## Setup External Client App

1. Go To Setup > External Client Apps
2. Enable OAuth Settings
    a. Callback URL: `https://dashql.app/oauth.html`
    b. Enable OAuth Scopes: `api`, `sfap_api`, `cdp_query_api`, `data_cloud_user_claims`
    c. Enable "Issue JSON Web Token (JWT)-based access tokens for named users"
       (`isNamedUserJwtEnabled=true` in `ExtlClntAppGlobalOauthSettings`)
3. Require PKCE and uncheck Require Secret for Web Server Flow
4. Save
5. Manage Consumer Details
6. Copy only the insensitive "Consumer Key", not the secret
7. Authorize the target user for the app. If using admin-approved preauthorization,
   assign the appropriate permission set. Configure the named-user JWT timeout in the ECA policy.
   Enter the tenant-specific Data Cloud endpoint and CDP tenant ID in the connection settings.
   DashQL does not require `cdp_url` or `cdp_tenant` claims in the access token.
   Scopes alone do not create a Data Cloud tenant.
8. For the instance URL, make sure to use the correct URL:
```
# Will work
https://orgfarm-fdd95295a3.test2.my.pc-rnd.salesforce.com


# Will NOT work
https://dsm000001gktt2au.sfdctest.test1.my.pc-rnd.salesforce.com
https://dsm000001gktt2au.sfdctest.test1.lightning.pc-rnd.force.com
https://orgfarm-fdd95295a3.test2.file.pc-rnd.force.com
```

# Setup CORS

1. Go To Setup > CORS
2. Add `https://dashql.app` and `http://localhost:9002`
3. Check "Enable CORS for OAuth endpoints"

DashQL uses authorization code + PKCE, not a client-signed JWT-Bearer assertion.
Never put private keys or app secrets in browser JavaScript. The ECA controls the
format and lifetime of Salesforce's returned access token. DashQL no longer performs
an A360 exchange. Direct/Hyper endpoints still need OrgJWT tenant mapping and, for
browser requests, their own CORS support; Query Connect success proves neither.
