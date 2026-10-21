//! API keys and their rolling-window quota, backed by three KV namespaces.
//!
//!   * `DASHQL_CLOUD_API_KEYS`      : `sha256(key)` -> [`KeyRecord`] JSON (owner + per-key budgets).
//!   * `DASHQL_CLOUD_API_KEY_USAGE` : per-window counters, TTL'd so they self-expire. Two per key/window:
//!       - `"<sha256(key)>:<window_start_secs>:r"` -> requests made this window
//!       - `"<sha256(key)>:<window_start_secs>:n"` -> **neuron-micros** consumed this window
//!     The `<window_start_secs>` suffix is the window's start as absolute epoch seconds
//!     (`now` aligned down to the window), so both counters reset each window.
//!   * `DASHQL_CLOUD_ACCOUNTS`      : `<lowercased-email>` -> [`Account`] JSON — the allowlist of
//!     Apple emails permitted to mint keys. Presence means allowlisted; `enabled: false` suspends
//!     without deleting. It's the single source of truth for who may create a key.
//!
//! Each key has two budgets: a **request count** and a **neuron** cap. Neurons are Cloudflare's
//! unit of GPU compute — the thing that actually burns the 10k-neuron/day free tier — and are
//! derived from a request's token counts via a fixed per-model rate (see [`crate::ai`]). We
//! store them as *neuron-micros* (neurons × 1e6) so `tokens × neurons-per-million-tokens` is an
//! exact integer with no rounding loss.
//!
//! The window length is a **deployment-wide** setting (`QUOTA_WINDOW_SECS`), read fresh on
//! every request — like a Claude subscription's shared reset cadence, with each key carrying
//! its own budgets. Keying the usage counters by an *absolute* window-start timestamp (rather
//! than a `now / window` index) is what makes changing that window safe: after a redeploy with
//! a different duration, the new counters land on different KV keys than the ones written under
//! the old duration, so they never collide — the stale ones just TTL away.
//!
//! Keys are opaque `dashql_<hex>` strings; only their SHA-256 is ever stored, so a KV
//! read never reveals a usable key. Note the counters are read-modify-write and thus not
//! strictly atomic under concurrency — acceptable for a personal gateway; strict accounting
//! would need Durable Objects (see `docs/wip/account.md`).

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::*;

/// Prefix that marks a dashql-cloud key. `<prefix><hex-random>`.
pub const KEY_PREFIX: &str = "dashql_";

/// One neuron, expressed in the *neuron-micros* unit the neuron counter stores.
pub const NEURON: u64 = 1_000_000;

/// Default quota window if the deployment doesn't set one: 5 hours (like Claude subscriptions).
pub const DEFAULT_QUOTA_WINDOW_SECS: u32 = 5 * 60 * 60;

/// Default per-key request cap per window.
pub const DEFAULT_REQUEST_LIMIT: u32 = 500;

/// Default per-key neuron cap per window, in whole neurons. Sized against the 10k-neuron/day
/// free tier: on `gemma-4-26b-a4b-it` (27273 neurons/M output tokens) this is
/// ~370k output tokens per window — generous for a personal tool, tunable via `NEURON_LIMIT`.
pub const DEFAULT_NEURON_LIMIT: u64 = 10_000;

/// Stored (by `sha256(key)`) in the `DASHQL_CLOUD_API_KEYS` namespace.
///
/// Only the per-key *budgets* live here; the reset cadence (window length) is a deployment-wide
/// setting, not a per-key one, so it is deliberately absent.
#[derive(Serialize, Deserialize)]
pub struct KeyRecord {
    /// Apple `sub` of the owner (stable across email changes / private relay).
    pub apple_sub: String,
    /// Owner email at creation time (informational).
    pub email: String,
    /// Epoch millis when the key was minted.
    pub created_at: u64,
    /// Max requests allowed within each rolling window.
    pub request_limit: u32,
    /// Max neurons (GPU-compute units) allowed within each rolling window. Records written
    /// before this field existed default to [`DEFAULT_NEURON_LIMIT`] via serde.
    #[serde(default = "default_neuron_limit")]
    pub neuron_limit: u64,
}

fn default_neuron_limit() -> u64 {
    DEFAULT_NEURON_LIMIT
}

/// Which budget a [`KeyError::QuotaExceeded`] refers to, so the caller can phrase the 429.
pub enum QuotaKind {
    Requests,
    Neurons,
}

/// Why a request was rejected, so the caller can map it to the right HTTP status.
pub enum KeyError {
    /// No/blank bearer token, or the hash isn't in `DASHQL_CLOUD_API_KEYS`. -> 401
    Unauthorized,
    /// A budget for the current window is exhausted. `limit` is in requests or whole neurons
    /// depending on `kind`. -> 429
    QuotaExceeded { kind: QuotaKind, limit: u64, window_secs: u32 },
    /// KV or other infrastructure error. -> 500
    Internal(worker::Error),
}

/// SHA-256 of a key, lowercase hex. This is the KV key we store/look up under.
pub fn hash_key(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    hex::encode(digest)
}

/// Generate a fresh `dashql_<43-char-base64url>` key (256 bits of entropy).
pub fn generate_key() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| worker::Error::RustError(format!("getrandom failed: {e}")))?;
    let rand = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    Ok(format!("{KEY_PREFIX}{rand}"))
}

/// Pull the bearer token out of the `Authorization` header, if present and non-empty.
pub fn bearer_token(req: &Request) -> Option<String> {
    let header = req.headers().get("Authorization").ok().flatten()?;
    let token = header.strip_prefix("Bearer ")?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// A request that has passed the up-front quota check and had its request slot charged. Hold
/// it across the AI call, then call [`Charge::charge_neurons`] with the request's neuron cost.
pub struct Charge {
    /// The `sha256(key)` hash of the charged API key
    hash: String,
    /// The start of the charged quota window in epoch seconds
    window_start: u64,
    /// The length of the quota window in seconds
    window_secs: u32,
}

/// KV key for the request counter of `(key, window)`.
fn request_key(hash: &str, window_start: u64) -> String {
    format!("{hash}:{window_start}:r")
}

/// KV key for the neuron-micros counter of `(key, window)`.
fn neuron_key(hash: &str, window_start: u64) -> String {
    format!("{hash}:{window_start}:n")
}

/// Counter TTL: ~2 windows, so an expired bucket self-deletes, but never below KV's 60s floor.
fn usage_ttl(window_secs: u32) -> u64 {
    ((window_secs as u64) * 2).max(60)
}

/// Phase 1 of charging a request, run **before** the model call. Verifies the API key and
/// checks *both* budgets (requests and neurons) for the current window; on success charges one
/// request slot and returns a [`Charge`] to settle the neuron cost afterwards.
///
/// The neuron check is "already over?" rather than "will this request push me over?" — token
/// counts only exist after inference — so a key can overshoot its neuron budget by at most one
/// request's worth before the next call is refused. That's the standard debit-after-use model.
/// Errors distinguish 401 / 429 / 500 via [`KeyError`].
pub async fn verify_and_charge(req: &Request, env: &Env) -> std::result::Result<Charge, KeyError> {
    let token = bearer_token(req).ok_or(KeyError::Unauthorized)?;
    let hash = hash_key(&token);

    // KV builder ops return `worker::kv::KvError`; `worker::Error: From<KvError>`, so
    // `.into()` normalizes both those and plain `worker::Error` into `KeyError::Internal`.
    let keys = env.kv("DASHQL_CLOUD_API_KEYS").map_err(|e| KeyError::Internal(e.into()))?;
    let record: KeyRecord = keys
        .get(&hash)
        .json()
        .await
        .map_err(|e| KeyError::Internal(e.into()))?
        .ok_or(KeyError::Unauthorized)?;

    // The window length is a deployment-wide setting, read fresh each request. The counter keys
    // are suffixed with the window's *start time* in absolute epoch seconds, so they roll over
    // when the clock crosses a boundary. Keying by an absolute timestamp (rather than a
    // `now / window` index) means a redeploy with a different window lands on different KV keys
    // than the old one, so the counters never collide across the change. Guard against zero.
    let window_secs = quota_window_secs(env).max(1);
    let window_start = window_start_secs(Date::now().as_millis(), window_secs);

    let usage = env.kv("DASHQL_CLOUD_API_KEY_USAGE").map_err(|e| KeyError::Internal(e.into()))?;

    // Neuron budget first (the one that protects the free tier). Absent == 0.
    let neurons_used = read_u64(&usage, &neuron_key(&hash, window_start)).await?;
    if neurons_used >= record.neuron_limit.saturating_mul(NEURON) {
        return Err(KeyError::QuotaExceeded {
            kind: QuotaKind::Neurons,
            limit: record.neuron_limit,
            window_secs,
        });
    }

    // Request budget. Absent == 0.
    let req_key = request_key(&hash, window_start);
    let requests_used = read_u64(&usage, &req_key).await? as u32;
    if requests_used >= record.request_limit {
        return Err(KeyError::QuotaExceeded {
            kind: QuotaKind::Requests,
            limit: record.request_limit as u64,
            window_secs,
        });
    }

    // Charge the request slot now (the neuron cost is settled after inference).
    usage
        .put(&req_key, (requests_used + 1).to_string())
        .map_err(|e| KeyError::Internal(e.into()))?
        .expiration_ttl(usage_ttl(window_secs))
        .execute()
        .await
        .map_err(|e| KeyError::Internal(e.into()))?;

    Ok(Charge { hash, window_start, window_secs })
}

impl Charge {
    /// Phase 2: add this request's neuron cost (in neuron-micros) to the window counter. Called
    /// after inference, once token counts are known. Read-modify-write, best-effort under
    /// concurrency. A zero cost is a no-op (avoids a needless KV write).
    pub async fn charge_neurons(&self, env: &Env, neuron_micros: u64) -> Result<()> {
        if neuron_micros == 0 {
            return Ok(());
        }
        let usage = env.kv("DASHQL_CLOUD_API_KEY_USAGE")?;
        let key = neuron_key(&self.hash, self.window_start);
        let current = read_u64(&usage, &key).await.map_err(unwrap_internal)?;
        usage
            .put(&key, current.saturating_add(neuron_micros).to_string())?
            .expiration_ttl(usage_ttl(self.window_secs))
            .execute()
            .await?;
        Ok(())
    }
}

/// Read a KV counter as `u64`, treating absent/unparseable as 0.
async fn read_u64(usage: &kv::KvStore, key: &str) -> std::result::Result<u64, KeyError> {
    Ok(usage
        .get(key)
        .text()
        .await
        .map_err(|e| KeyError::Internal(e.into()))?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0))
}

/// Unwrap a [`KeyError`] back into a plain `worker::Error` (only `Internal` is possible from
/// [`read_u64`]); used where the caller works in `worker::Result`.
fn unwrap_internal(e: KeyError) -> worker::Error {
    match e {
        KeyError::Internal(e) => e,
        _ => worker::Error::RustError("unexpected key error".into()),
    }
}

/// Current-window usage for a key (for the dashboard): `(requests, neuron_micros)`.
pub async fn window_usage(env: &Env, hash: &str) -> Result<(u32, u64)> {
    let window_secs = quota_window_secs(env).max(1);
    let window_start = window_start_secs(Date::now().as_millis(), window_secs);
    let usage = env.kv("DASHQL_CLOUD_API_KEY_USAGE")?;
    let requests = read_u64(&usage, &request_key(hash, window_start))
        .await
        .map_err(unwrap_internal)? as u32;
    let neuron_micros =
        read_u64(&usage, &neuron_key(hash, window_start)).await.map_err(unwrap_internal)?;
    Ok((requests, neuron_micros))
}

/// Prefix for the owner index inside the `DASHQL_CLOUD_API_KEYS` namespace. A record is stored twice:
///   * under `sha256(key)` (raw 64-hex) for O(1) verification, and
///   * under `owner:<apple_sub>:<sha256(key)>` for per-user listing.
/// Raw hex hashes never collide with `owner:`-prefixed index keys, so `verify_and_charge`'s
/// `get(&hash)` is unaffected by the index.
const OWNER_PREFIX: &str = "owner:";

/// A key as shown in the dashboard — never includes the plaintext key, only its hash.
#[derive(Serialize, Deserialize)]
pub struct KeyInfo {
    /// `sha256(key)` — used as the id to revoke.
    pub hash: String,
    /// Epoch millis when the key was minted
    pub created_at: u64,
    /// Max requests allowed within each rolling window
    pub request_limit: u32,
    /// Max neurons allowed within each rolling window
    #[serde(default = "default_neuron_limit")]
    pub neuron_limit: u64,
}

/// Store a new key: the full record under `sha256(key)`, and a display entry under the
/// owner index so it can be listed and revoked later.
pub async fn store_key(env: &Env, key: &str, record: &KeyRecord) -> Result<()> {
    let keys = env.kv("DASHQL_CLOUD_API_KEYS")?;
    let hash = hash_key(key);

    let value = serde_json::to_string(record)
        .map_err(|e| worker::Error::RustError(format!("serialize KeyRecord: {e}")))?;
    keys.put(&hash, value)?.execute().await?;

    let info = KeyInfo {
        hash: hash.clone(),
        created_at: record.created_at,
        request_limit: record.request_limit,
        neuron_limit: record.neuron_limit,
    };
    let info_value = serde_json::to_string(&info)
        .map_err(|e| worker::Error::RustError(format!("serialize KeyInfo: {e}")))?;
    keys.put(&format!("{OWNER_PREFIX}{}:{hash}", record.apple_sub), info_value)?
        .execute()
        .await?;
    Ok(())
}

/// List every key owned by `apple_sub` (via the owner index).
pub async fn list_keys(env: &Env, apple_sub: &str) -> Result<Vec<KeyInfo>> {
    let keys = env.kv("DASHQL_CLOUD_API_KEYS")?;
    let prefix = format!("{OWNER_PREFIX}{apple_sub}:");
    let listed = keys.list().prefix(prefix).execute().await?;
    let mut out = Vec::with_capacity(listed.keys.len());
    for k in listed.keys {
        if let Some(info) = keys.get(&k.name).json::<KeyInfo>().await? {
            out.push(info);
        }
    }
    Ok(out)
}

/// Revoke a key by its hash, but only if it belongs to `apple_sub` (so a user can't revoke
/// another user's key by guessing a hash). Deletes both the record and the index entry.
pub async fn revoke_key(env: &Env, apple_sub: &str, hash: &str) -> Result<bool> {
    let keys = env.kv("DASHQL_CLOUD_API_KEYS")?;
    let index_key = format!("{OWNER_PREFIX}{apple_sub}:{hash}");
    // Ownership check: the index entry only exists if this sub owns this hash.
    if keys.get(&index_key).text().await?.is_none() {
        return Ok(false);
    }
    keys.delete(hash).await?;
    keys.delete(&index_key).await?;
    Ok(true)
}

/// Account record for an allowlisted email, stored in the `DASHQL_CLOUD_ACCOUNTS` namespace
/// under the bare lowercased email. Presence in the namespace means allowlisted; `enabled` lets
/// an admin *suspend* an account without deleting its entry (and losing the `added_at` audit
/// note). A bare `{}` value therefore reads as enabled.
#[derive(Serialize, Deserialize)]
pub struct Account {
    /// Whether this email may currently mint keys. Defaults to `true` so `{}` == enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Epoch millis when the account was added (informational).
    #[serde(default)]
    pub added_at: u64,
}

fn default_true() -> bool {
    true
}

/// Normalize an email for use as an account key: trimmed + lowercased. The email is the whole
/// key — the `DASHQL_CLOUD_ACCOUNTS` namespace holds nothing else, so no prefix is needed.
fn account_key(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

/// Is `email` allowed to mint keys? The `DASHQL_CLOUD_ACCOUNTS` KV namespace is the single source
/// of truth: an entry with `enabled: false` denies, `enabled: true` (or a bare `{}`) allows, and
/// **no entry means not allowed** — the allowlist is admin-seeded, so absence is a denial, not a
/// fallback. A KV read error also **fails closed** (denies), since this is a security gate.
pub async fn is_email_allowed(env: &Env, email: &str) -> bool {
    let accounts = match env.kv("DASHQL_CLOUD_ACCOUNTS") {
        Ok(k) => k,
        Err(_) => return false,
    };
    match accounts.get(&account_key(email)).json::<Account>().await {
        Ok(Some(account)) => account.enabled,
        // No account entry, or a KV failure -> deny (fail closed).
        Ok(None) | Err(_) => false,
    }
}

/// The deployment-wide quota window length, in seconds, from the `QUOTA_WINDOW_SECS` var.
/// Falls back to [`DEFAULT_QUOTA_WINDOW_SECS`] if unset or unparseable. Read fresh per request
/// so a redeploy changing it takes effect immediately.
pub fn quota_window_secs(env: &Env) -> u32 {
    env_num(env, "QUOTA_WINDOW_SECS", DEFAULT_QUOTA_WINDOW_SECS)
}

/// Read a numeric wrangler var, falling back to `default` if it's unset or unparseable.
pub fn env_num<T: std::str::FromStr>(env: &Env, name: &str, default: T) -> T {
    env.var(name)
        .map(|v| v.to_string())
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(default)
}

/// Render neuron-micros as whole neurons for display (e.g. `12345`), rounding to the nearest.
pub fn neurons_from_micros(neuron_micros: u64) -> u64 {
    (neuron_micros + NEURON / 2) / NEURON
}

/// Start of the quota window containing `epoch_millis`, as absolute epoch **seconds** aligned
/// down to a `window_secs` boundary: `floor(now_secs / window) * window`. Used as the usage
/// counter's key suffix. Because it's a real timestamp rather than a window *index*, changing
/// `window_secs` (via a redeploy) produces fresh, non-colliding buckets instead of reusing an
/// index that meant a different span of time under the old length.
pub fn window_start_secs(epoch_millis: u64, window_secs: u32) -> u64 {
    let window = window_secs.max(1) as u64;
    let now_secs = epoch_millis / 1000;
    (now_secs / window) * window
}

/// Render a window length as a compact, human-friendly string (e.g. `5h`, `30m`, `1d`, `90s`)
/// for the dashboard and quota-exceeded messages. Falls back to whole minutes/hours/days when
/// the window divides evenly, else the next-smaller unit.
pub fn humanize_window(window_secs: u32) -> String {
    const MIN: u32 = 60;
    const HOUR: u32 = 60 * 60;
    const DAY: u32 = 24 * 60 * 60;
    if window_secs == 0 {
        "0s".to_string()
    } else if window_secs % DAY == 0 {
        format!("{}d", window_secs / DAY)
    } else if window_secs % HOUR == 0 {
        format!("{}h", window_secs / HOUR)
    } else if window_secs % MIN == 0 {
        format!("{}m", window_secs / MIN)
    } else {
        format!("{window_secs}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_start_rolls_over_on_boundaries() {
        let window = 5 * 60 * 60; // 5h in seconds
        let window_ms = window as u64 * 1000;
        // Same window -> same start timestamp (aligned to 0).
        assert_eq!(window_start_secs(0, window), 0);
        assert_eq!(window_start_secs(window_ms - 1, window), 0);
        // One ms past the boundary -> next window, one `window` further along (in seconds).
        assert_eq!(window_start_secs(window_ms, window), window as u64);
        // The start is always an absolute epoch-second timestamp on a window boundary.
        assert_eq!(window_start_secs(3 * window_ms + 42_000, window), 3 * window as u64);
        // A degenerate zero window is clamped to 1s rather than dividing by zero.
        assert_eq!(window_start_secs(1500, 0), 1);
    }

    #[test]
    fn changing_window_length_yields_distinct_buckets() {
        // The whole point of keying by absolute time: at a fixed instant, the old deployment's
        // window and the new one land on different suffixes, so a redeploy that changes
        // QUOTA_WINDOW_SECS never reuses a counter that was scoped to a different span.
        let now_ms = 1_700_000_000_000;
        let old_window = window_start_secs(now_ms, 5 * 60 * 60);
        let new_window = window_start_secs(now_ms, 60 * 60);
        assert_ne!(old_window, new_window);
    }

    #[test]
    fn humanize_window_picks_the_largest_even_unit() {
        assert_eq!(humanize_window(DEFAULT_QUOTA_WINDOW_SECS), "5h");
        assert_eq!(humanize_window(24 * 60 * 60), "1d");
        assert_eq!(humanize_window(30 * 60), "30m");
        assert_eq!(humanize_window(90), "90s");
        assert_eq!(humanize_window(0), "0s");
    }

    #[test]
    fn neurons_from_micros_rounds_to_nearest() {
        assert_eq!(neurons_from_micros(0), 0);
        assert_eq!(neurons_from_micros(NEURON), 1);
        assert_eq!(neurons_from_micros(NEURON / 2), 1); // .5 rounds up
        assert_eq!(neurons_from_micros(NEURON / 2 - 1), 0);
        assert_eq!(neurons_from_micros(12_345 * NEURON + 400_000), 12_345);
    }

    #[test]
    fn hash_is_stable_and_hex() {
        let h = hash_key("dashql_abc");
        assert_eq!(h.len(), 64);
        assert_eq!(h, hash_key("dashql_abc"));
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generated_keys_are_prefixed_and_unique() {
        let a = generate_key().unwrap();
        let b = generate_key().unwrap();
        assert!(a.starts_with(KEY_PREFIX));
        assert_ne!(a, b);
    }

    #[test]
    fn account_key_is_normalized() {
        assert_eq!(account_key("  Me@Example.COM "), "me@example.com");
    }

    #[test]
    fn account_defaults_bare_object_to_enabled() {
        // A hand-written `{}` (e.g. `wrangler kv key put --binding DASHQL_CLOUD_ACCOUNTS
        // me@x.com '{}'`) reads as enabled.
        let bare: Account = serde_json::from_str("{}").unwrap();
        assert!(bare.enabled);
        assert_eq!(bare.added_at, 0);
        // An explicit suspension is honored.
        let off: Account = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!off.enabled);
    }
}
