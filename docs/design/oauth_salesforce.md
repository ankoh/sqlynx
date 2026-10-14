# Salesforce OAuth Flow

DashQL uses the [Web Server OAuth Flow with PKCE](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&type=5).
No client secret is embedded; PKCE alone binds the initiator to the finisher.

Core OAuth access tokens may be opaque. DashQL exchanges the Core token for a separate
Data Cloud JWT; named-user OrgJWT access tokens are not required.
See [External Client App setup](../misc/setup_data_cloud.md).

The registered `redirect_uri` is always `https://dashql.app/oauth.html` regardless of where the
app is running. That page acts as a relay: it receives the authorization code from Salesforce,
encodes it into a platform-appropriate event, and hands it back to the originating app instance.

---

## Shared setup (all paths)

`salesforce_connection_setup.ts` always runs these steps first:

1. Generate a PKCE challenge (`code_verifier` + `code_challenge` via S256).
2. Choose `flowVariant` based on platform type:
   - `WEB_OPENER_FLOW` — when running as a web app (including localhost dev server)
   - `NATIVE_LINK_FLOW` — when running as the Electron desktop app
3. Serialise `OAuthState { flowVariant, salesforceProvider: { instanceUrl, appConsumerKey, expiresAt } }` → JSON → base64url → `state` query param.
4. Build the Salesforce authorization URL:
   ```
   {instanceUrl}/services/oauth2/authorize
     ?client_id={appConsumerKey}
     &redirect_uri=https://dashql.app/oauth.html
     &code_challenge={pkceChallenge}
     &code_challenge_method=S256
     &response_type=code
     &state={base64url-OAuthState}
   ```
5. Open the URL (mechanism differs per path — see below).
6. Call `appEvents.waitForOAuthRedirect(abortSignal)` and suspend until the code arrives.

After the code arrives:

7. Exchange the code for a core access token: POST to `{instanceUrl}/services/oauth2/token`
   with `code`, `code_verifier`, and `redirect_uri=https://dashql.app/oauth.html`.
8. POST to the Core token response's `{instance_url}/services/a360/token` with
   `grant_type=urn:salesforce:grant-type:external:cdp`, `subject_token={coreAccessToken}`,
   and `subject_token_type=urn:ietf:params:oauth:token-type:access_token`.
9. Decode the exchanged Data Cloud JWT and use the exchange response's `instance_url`
   for Direct HTTP or Hyper gRPC. Send the Data Cloud JWT unchanged as the bearer token
   and its `audienceTenantId` as the audience. Read the selected dataspace from
   `customAttributes.data.dataspace` (or the flat `customAttributes.dataspace`), falling
   back to `default`. The gRPC lakehouse path is `sf:{audienceTenantId};{dataspace}`.
   Keep the Core token and its `instance_url` for Core REST user info and metadata;
   metadata requests use the dataspace from the Data Cloud token.

JWT decoding does not verify signatures; the receiving Salesforce service does that.
No manual Data Cloud endpoint or tenant parameters are needed. The app does not
currently refresh credentials automatically; reconnect when the tokens expire.

---

## Path A: `dashql.app` → `oauth.html` → `dashql.app`

`flowVariant = WEB_OPENER_FLOW`

```
dashql.app                Salesforce               dashql.app/oauth.html
    |                         |                             |
    |--- open popup --------->|                             |
    |    (authorization URL)  |                             |
    |                         |<-- user authenticates ------|
    |                         |--- redirect --------------->|
    |                         |    ?code=...&state=...      |
    |                         |                             |--- React loads
    |                         |                             |    decodes state
    |                         |                             |    builds AppEventData
    |<-- postMessage(base64) -+-----------------------------|
    |    (window.opener)      |                             |--- window closes
    |                         |
    |--- token exchange ------>
```

1. `window.open(url, 'DashQL OAuth', 'width=600,height=700,...')` opens a popup.
2. Salesforce redirects the popup to `https://dashql.app/oauth.html?code=xxx&state=base64url`.
3. `oauth.html` loads `oauth_redirect.tsx`.
4. `RedirectPage` decodes `state` → recovers `OAuthState`.
5. `OAuthSucceeded` encodes `AppEventData { oauthRedirect: { code, state: OAuthState } }` → JSON → base64url.
6. After a 2-second delay, `triggerFlow` calls `window.opener.postMessage(eventBase64)` and the popup closes.
7. The parent tab's `WebPlatformEventListener.processMessageEvent` receives the `MessageEvent`, validates base64, parses JSON → `AppEventData`.
8. `dispatchAppEvent → dispatchOAuthRedirect` resolves `waitForOAuthRedirect`.

---

## Path B: `localhost` (dev server) → `oauth.html` → `localhost`

Identical to Path A. The platform is still `PlatformType.WEB`, so `flowVariant = WEB_OPENER_FLOW`.

The popup is opened from `localhost`; Salesforce redirects it to `dashql.app/oauth.html`;
`window.opener.postMessage(eventBase64)` delivers the event back cross-origin to the `localhost`
parent window. `postMessage` is sent without a `targetOrigin` restriction (`*`), so no special
CORS configuration is needed on `localhost`.

---

## Path C: Native app → `oauth.html` → Native app

`flowVariant = NATIVE_LINK_FLOW`

```
Native app (Electron)     Salesforce            System browser            OS deep-link
    |                         |                      |                         |
    |--- shell.open(url) ---->|                      |                         |
    |                         |<-- user authenticates|                         |
    |                         |--- redirect -------->|                         |
    |                         |    ?code=...&state=..|                         |
    |                         |                      |--- React loads          |
    |                         |                      |    decodes state        |
    |                         |                      |    builds AppEventData  |
    |                         |                      |--- window.open -------->|
    |                         |                      |    dashql://localhost   |
    |<------------------------------------------------------------ Electron deep-link event
    |                         |
    |--- token exchange ------>
```

1. Electron's `shell.openExternal(url)` opens the authorization URL in the system browser (outside the app window).
2. Salesforce redirects the browser to `https://dashql.app/oauth.html?code=xxx&state=base64url`.
3. `oauth.html` loads `oauth_redirect.tsx` inside the **system browser**.
4. `RedirectPage` decodes `state` → recovers `OAuthState` with `flowVariant = NATIVE_LINK_FLOW`.
5. `OAuthSucceeded` encodes `AppEventData` as before.
6. After a 2-second delay, `triggerFlow` calls `window.open("dashql://localhost?data=eventBase64", '_self')`.
   - The OS routes the `dashql://` deep link to the registered Electron app.
   - An "Open in App" button lets the user retry until the code expires.
7. `ElectronPlatformEventListener` receives the deep link through the preload bridge, calls `readAppEvent → dispatchAppEvent → dispatchOAuthRedirect`, resolving `waitForOAuthRedirect`.
   - On cold start, Electron queues command-line and `open-url` deep links until the renderer requests them.

### Debug mode

When the native app is running in `debugMode` (dev server cannot register as deep-link handler):

- Auto-trigger is skipped entirely.
- `oauth.html` renders the full `dashql://localhost?data=...` deep link as a copyable text field.
- The user pastes it anywhere in the app window; `processClipboardEvent` in `PlatformEventListener` intercepts pastes starting with `dashql://`, extracts the `data` param, and dispatches the event.

---

## Event encoding

All paths share the same wire format for the event passed back to the app:

```
AppEventData { oauthRedirect: { code: string, state: OAuthState } }
  → JSON
  → UTF-8 bytes
  → base64url string
```

`PlatformEventListener.readAppEvent` decodes this on receipt. Messages that are not valid
base64url, or that don't parse as `AppEventData`, are silently dropped.

---

## Comparison table

| | `dashql.app` | `localhost` | Native |
|---|---|---|---|
| `flowVariant` | `WEB_OPENER_FLOW` | `WEB_OPENER_FLOW` | `NATIVE_LINK_FLOW` |
| URL opened via | `window.open` (popup) | `window.open` (popup) | `shell.open` (system browser) |
| Code returned via | `window.opener.postMessage` | `window.opener.postMessage` | `dashql://` deep link |
| Event received by | `WebPlatformEventListener` | `WebPlatformEventListener` | `NativePlatformEventListener` |
| Debug fallback | — | — | Paste deep link into app |
| `redirect_uri` | `https://dashql.app/oauth.html` | `https://dashql.app/oauth.html` | `https://dashql.app/oauth.html` |
