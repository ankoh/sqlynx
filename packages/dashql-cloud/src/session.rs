//! Stateless, HMAC-signed session cookies.
//!
//! After a successful Sign in with Apple we mint a cookie carrying the user's Apple `sub`
//! and email plus an expiry, signed with `SESSION_SECRET` (HMAC-SHA256). No server-side
//! session store is needed — the signature is what we trust. Format:
//!
//! ```text
//! <base64url(payload)>.<base64url(hmac_sha256(secret, payload))>
//! payload = "<apple_sub>|<email>|<expiry_epoch_millis>"
//! ```

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Name of the session cookie set on `account.dashql.app`.
pub const COOKIE_NAME: &str = "dashql_session";

/// Session lifetime: 7 days.
const SESSION_TTL_MILLIS: u64 = 7 * 24 * 60 * 60 * 1000;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The verified identity carried by a valid session.
pub struct Session {
    /// The Apple `sub` of the signed-in user
    pub apple_sub: String,
    /// The email of the signed-in user
    pub email: String,
}

/// Mint a signed cookie value for `apple_sub`/`email`, expiring `SESSION_TTL_MILLIS` from
/// `now_millis`.
pub fn issue(secret: &str, apple_sub: &str, email: &str, now_millis: u64) -> String {
    let expiry = now_millis + SESSION_TTL_MILLIS;
    // '|' is the field separator; sub/email from Apple never contain it, but guard anyway.
    let payload = format!(
        "{}|{}|{}",
        apple_sub.replace('|', ""),
        email.replace('|', ""),
        expiry
    );
    let sig = sign(secret, payload.as_bytes());
    format!("{}.{}", B64.encode(payload.as_bytes()), B64.encode(sig))
}

/// Verify a cookie value: checks the HMAC (constant-time) and the expiry. Returns the
/// [`Session`] on success, `None` otherwise.
pub fn verify(secret: &str, cookie_value: &str, now_millis: u64) -> Option<Session> {
    let (payload_b64, sig_b64) = cookie_value.split_once('.')?;
    let payload = B64.decode(payload_b64).ok()?;
    let sig = B64.decode(sig_b64).ok()?;

    // Constant-time verify via the MAC's own comparison.
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(&payload);
    mac.verify_slice(&sig).ok()?;

    let payload = String::from_utf8(payload).ok()?;
    let mut parts = payload.splitn(3, '|');
    let apple_sub = parts.next()?.to_string();
    let email = parts.next()?.to_string();
    let expiry: u64 = parts.next()?.parse().ok()?;
    if now_millis >= expiry {
        return None;
    }
    Some(Session { apple_sub, email })
}

/// Extract the session cookie value from a `Cookie` header, if present.
pub fn from_cookie_header(cookie_header: &str) -> Option<&str> {
    cookie_header
        .split(';')
        .map(str::trim)
        .find_map(|kv| kv.strip_prefix(&format!("{COOKIE_NAME}=")))
}

/// Build the `Set-Cookie` header value for a freshly issued session.
pub fn set_cookie(value: &str) -> String {
    format!(
        "{COOKIE_NAME}={value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={}",
        SESSION_TTL_MILLIS / 1000
    )
}

fn sign(secret: &str, msg: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret";
    const NOW: u64 = 1_700_000_000_000;

    #[test]
    fn round_trip_valid_session() {
        let cookie = issue(SECRET, "001.abc", "a@b.com", NOW);
        let s = verify(SECRET, &cookie, NOW + 1000).expect("valid");
        assert_eq!(s.apple_sub, "001.abc");
        assert_eq!(s.email, "a@b.com");
    }

    #[test]
    fn rejects_tampered_or_wrong_secret() {
        let cookie = issue(SECRET, "sub", "e@x.com", NOW);
        assert!(verify("other-secret", &cookie, NOW + 1000).is_none());
        let tampered = format!("{}x", cookie);
        assert!(verify(SECRET, &tampered, NOW + 1000).is_none());
    }

    #[test]
    fn rejects_expired_session() {
        let cookie = issue(SECRET, "sub", "e@x.com", NOW);
        assert!(verify(SECRET, &cookie, NOW + SESSION_TTL_MILLIS + 1).is_none());
    }

    #[test]
    fn parses_cookie_header() {
        let header = format!("foo=bar; {COOKIE_NAME}=abc.def; baz=qux");
        assert_eq!(from_cookie_header(&header), Some("abc.def"));
        assert_eq!(from_cookie_header("nothing=here"), None);
    }
}
