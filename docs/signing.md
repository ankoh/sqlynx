
## General Signing

We use a simple Ed25519 key pair for signing our own binaries.
https://jedisct1.github.io/minisign/

They are passed to Tauri via TAURI_SIGNING_PRIVATE_KEY & TAURI_SIGNING_PRIVATE_KEY_PASSWORD.

## MacOS Signing

We need only two things for MacOS signing:

A certificate of type "Developer ID Application" to sign our applications:
Can be created here: https://developer.apple.com/account/resources/certificates/list

Provided through:
- MACOS_SIGNING_IDENTITY
- MACOS_DEVELOPER_ID_APPLICATION_BASE64
- MACOS_DEVELOPER_ID_APPLICATION_SECRET

An API key to access the AppStoreConnect Api.
Can be created here: https://appstoreconnect.apple.com/access/integrations/api

Provided through:
- MACOS_STORE_ISSUER_ID
- MACOS_STORE_KEY_ID
- MACOS_STORE_KEY
- APPLE_API_KEY_PATH
