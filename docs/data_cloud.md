## Setup

1. Go To Setup > App Manager > New Connected App
2. Enable OAuth Settings
    a. Callback URL: `http://localhost:9002/oauth.html`
    b. Available OAuth Scopes: enable cdp_api
3. Uncheck Require Secret for Web Server Flow
4. Save
5. Manage Consumer Details
6. Copy only the insensitive "Consumer Key", not the secret
7. Open "Data Cloud Setup" at least once in the UI otherwise `/services/a360/token` will return `instance_url: null`

