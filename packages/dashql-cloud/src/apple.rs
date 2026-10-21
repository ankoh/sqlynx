//! Sign in with Apple (web), using the `form_post` id_token flow.
//!
//! We request `response_type=code id_token` with `response_mode=form_post`, so Apple POSTs
//! an `id_token` (a JWT) straight to our callback. We verify that JWT ourselves — no code
//! exchange, so no client-secret JWT / private key at runtime. Verification is pure-Rust
//! RS256 (`rsa` + `sha2`), which compiles cleanly to `wasm32-unknown-unknown` (no `ring`).

use base64::Engine;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::signature::Verifier;
use rsa::{BigUint, RsaPublicKey};
use serde::Deserialize;
use sha2::Sha256;
use worker::*;

const APPLE_AUTHORIZE: &str = "https://appleid.apple.com/auth/authorize";
const APPLE_JWKS: &str = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER: &str = "https://appleid.apple.com";

const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The verified claims we care about from Apple's id_token.
pub struct AppleIdentity {
    /// The stable Apple user id (`sub` claim)
    pub sub: String,
    /// The user email, empty when Apple omitted it
    pub email: String,
}

/// Build the Apple authorize URL to redirect the browser to.
/// `service_id` is the Services ID (our OAuth client_id); `redirect_uri` must match the
/// return URL registered with Apple.
pub fn authorize_url(service_id: &str, redirect_uri: &str) -> String {
    // `name email` scope requires form_post (Apple's rule); we only need email here.
    let mut url = Url::parse(APPLE_AUTHORIZE).expect("valid Apple authorize URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code id_token")
        .append_pair("response_mode", "form_post")
        .append_pair("client_id", service_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", "email");
    url.into()
}

// ---- id_token verification ------------------------------------------------------------

/// The decoded header of an Apple id_token JWT
#[derive(Deserialize)]
struct JwtHeader {
    /// The id of the JWKS key that signed the token
    kid: String,
    /// The signature algorithm, must be `RS256`
    alg: String,
}

/// The decoded claims of an Apple id_token JWT
#[derive(Deserialize)]
struct JwtClaims {
    /// The token issuer, must be Apple
    iss: String,
    /// The token audience, must be our Services ID
    aud: String,
    /// The expiry time in epoch seconds
    exp: u64,
    /// The stable Apple user id
    sub: String,
    /// The user email, empty when absent
    #[serde(default)]
    email: String,
}

/// Apple's JSON Web Key Set
#[derive(Deserialize)]
struct Jwks {
    /// The published signing keys
    keys: Vec<Jwk>,
}

/// A single RSA public key in Apple's JWKS
#[derive(Deserialize)]
struct Jwk {
    /// The key id, matched against the JWT header `kid`
    kid: String,
    /// The RSA modulus, base64url-encoded
    n: String,
    /// The RSA public exponent, base64url-encoded
    e: String,
}

/// Verify an Apple id_token JWT and return the identity. Checks the RS256 signature against
/// Apple's JWKS (fetched live) and validates `iss`, `aud`, and `exp`.
pub async fn verify_id_token(
    id_token: &str,
    service_id: &str,
    now_millis: u64,
) -> std::result::Result<AppleIdentity, String> {
    // 1. Split the JWT.
    let mut parts = id_token.split('.');
    let header_b64 = parts.next().ok_or("malformed jwt: no header")?;
    let claims_b64 = parts.next().ok_or("malformed jwt: no claims")?;
    let sig_b64 = parts.next().ok_or("malformed jwt: no signature")?;
    if parts.next().is_some() {
        return Err("malformed jwt: too many segments".into());
    }
    let signing_input = format!("{header_b64}.{claims_b64}");

    // 2. Decode header + claims.
    let header: JwtHeader = decode_json_segment(header_b64).map_err(|e| format!("header: {e}"))?;
    if header.alg != "RS256" {
        return Err(format!("unexpected alg: {}", header.alg));
    }
    let claims: JwtClaims = decode_json_segment(claims_b64).map_err(|e| format!("claims: {e}"))?;

    // 3. Validate standard claims before doing crypto work.
    if claims.iss != APPLE_ISSUER {
        return Err(format!("bad issuer: {}", claims.iss));
    }
    if claims.aud != service_id {
        return Err(format!("bad audience: {}", claims.aud));
    }
    if now_millis / 1000 >= claims.exp {
        return Err("token expired".into());
    }

    // 4. Fetch Apple's JWKS and find the key by `kid`.
    let jwks = fetch_jwks().await.map_err(|e| format!("jwks fetch: {e}"))?;
    let jwk = jwks
        .keys
        .iter()
        .find(|k| k.kid == header.kid)
        .ok_or("no matching JWKS key for kid")?;

    // 5. Reconstruct the RSA public key and verify the RS256 signature.
    let n = BigUint::from_bytes_be(&B64URL.decode(&jwk.n).map_err(|e| format!("jwk n: {e}"))?);
    let e = BigUint::from_bytes_be(&B64URL.decode(&jwk.e).map_err(|e| format!("jwk e: {e}"))?);
    let public_key = RsaPublicKey::new(n, e).map_err(|e| format!("rsa key: {e}"))?;
    let verifying_key = VerifyingKey::<Sha256>::new(public_key);
    let sig_bytes = B64URL.decode(sig_b64).map_err(|e| format!("sig: {e}"))?;
    let signature = Signature::try_from(sig_bytes.as_slice()).map_err(|e| format!("sig parse: {e}"))?;
    verifying_key
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| "signature verification failed".to_string())?;

    Ok(AppleIdentity { sub: claims.sub, email: claims.email })
}

/// Base64url-decode a JWT segment and parse it as JSON.
fn decode_json_segment<T: for<'de> Deserialize<'de>>(seg: &str) -> std::result::Result<T, String> {
    let bytes = B64URL.decode(seg).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Fetch Apple's JWKS. (v1: fetched per-callback; a short KV cache is a noted optimization.)
async fn fetch_jwks() -> Result<Jwks> {
    let url = Url::parse(APPLE_JWKS)?;
    let mut resp = Fetch::Url(url).send().await?;
    resp.json::<Jwks>().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_has_form_post_and_client() {
        let u = authorize_url("app.dashql.account", "https://account.dashql.app/auth/apple/callback");
        assert!(u.contains("response_mode=form_post"));
        assert!(u.contains("client_id=app.dashql.account"));
        assert!(u.contains("response_type=code+id_token") || u.contains("response_type=code%20id_token"));
        assert!(u.contains("redirect_uri=https"));
    }
}
