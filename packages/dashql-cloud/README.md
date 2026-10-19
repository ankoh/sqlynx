# dashql-cloud

The dashql service: a minimal, OpenAI-compatible **SLM gateway** on Cloudflare Workers AI,
gatekept by an Apple account allowlist. One Cloudflare Worker (Rust /
[`workers-rs`](https://github.com/cloudflare/workers-rs)) serves two custom domains:

| Host                 | Purpose                                                        |
| -------------------- | ------------------------------------------------------------- |
| `ai.dashql.app`      | Machine API: `GET /v1/models`, `POST /v1/chat/completions`    |
| `account.dashql.app` | Human dashboard: Sign in with Apple + API-key management      |

The DashQL application does not embed an AI client, but this standalone service remains
available for future use and for other OpenAI-compatible clients. Chat completions forward OpenAI's `response_format` to Workers AI. Full design
and rationale live in [`../../docs/wip/account.md`](../../docs/wip/account.md).

> **Repo isolation:** this crate is deliberately outside the root Cargo workspace (it has its
> own `[workspace]` table and is not in the root `members` list) and is listed in the repo
> `.bazelignore`. Build it with `cargo`/`wrangler` directly, never Bazel.

## Prerequisites

- Rust with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`).
- `wrangler` (via `npx wrangler …`); `worker-build` is auto-installed by the build command.
- A Cloudflare account with Workers AI enabled, and `dashql.app` as a zone on it.

## Local development

```sh
# Type-check the WASM build:
cargo check --target wasm32-unknown-unknown

# Run locally (serves the API surface on localhost):
npx wrangler dev

# Smoke-test the API (uses the placeholder key until task #4 lands real keys):
curl localhost:8787/v1/models -H "Authorization: Bearer dashql_devtestkey"

curl localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer dashql_devtestkey" \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/google/gemma-4-26b-a4b-it","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## Deploy

```sh
# One-time: create the KV namespaces and paste their ids into wrangler.jsonc.
npx wrangler kv namespace create DASHQL_CLOUD_API_KEYS
npx wrangler kv namespace create DASHQL_CLOUD_API_KEY_USAGE

# One-time: set the session-cookie HMAC secret.
npx wrangler secret put SESSION_SECRET

npx wrangler deploy
```

## Apple setup (Sign in with Apple, web)

See `docs/wip/account.md` → "One-time Apple setup". In short: create a **Services ID**
(this is `APPLE_SERVICE_ID` in `wrangler.jsonc`), enable Sign in with Apple, and register
`account.dashql.app` + the return URL `https://account.dashql.app/auth/apple/callback`.

## Status

- [x] Scaffold + `wrangler.jsonc` + host routing
- [x] `/v1/models` + `/v1/chat/completions`
- [x] KV-backed API keys + rolling-window quota: per-key request + neuron budgets (default 5h)
- [x] Sign in with Apple (pure-Rust RS256) + key-management dashboard
- [ ] Deploy + hardening (needs a live Cloudflare account, `dashql.app` zone, and an Apple Services ID)
