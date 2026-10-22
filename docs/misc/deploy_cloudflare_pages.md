# Deploying dashql.app with Cloudflare Pages

The web app is built by Bazel in GitHub Actions and deployed to Cloudflare Pages as a prebuilt
artifact. Cloudflare does not clone or build the repository.

## One-time setup

1. Create a Cloudflare Pages **Direct Upload** project named `dashql` with production branch
   `main`. Do not connect the GitHub repository through Cloudflare's Git integration.
2. Create a Cloudflare API token with `Account > Cloudflare Pages > Edit` permission, scoped to
   the account that owns `dashql.app`.
3. Add these GitHub Actions repository secrets:
   - `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
   - `CLOUDFLARE_API_TOKEN`: the Pages API token.
4. Run the main-branch workflow once. The publish job downloads the `dashql_app_pages` artifact
   produced by Bazel and uploads it with `wrangler pages deploy`.
5. In the Pages project's **Custom domains** settings, add both `dashql.app` and `hyperdb.sh`.
   Cloudflare manages each apex DNS record after the domain is attached to the project. Both zones
   must be active in the Cloudflare account that owns the Pages project.
6. After both domains serve the Pages deployment, disable GitHub Pages for the repository and
   remove obsolete zone-level cache and response-header rules that were needed in front of GitHub
   Pages.

## Routing and headers

Cloudflare Pages treats a deployment without a top-level `404.html` as a single-page app. Unknown
paths are served by `index.html`, while uploaded files and everything under `/static/` are served
directly. A directory-local `static/404.html` ensures missing static assets return a real 404 instead
of the SPA shell without disabling top-level SPA routing. The Pages artifact also copies the runtime
`static/config.json` alongside Vite's generated assets. `packages/dashql-app/_redirects` internally
rewrites `/oauth.html` to Pages' canonical
`/oauth` asset without changing the browser URL. This avoids Pages' default redirect to an
extensionless URL because OAuth providers and the token exchange require the registered
`https://dashql.app/oauth.html` redirect URI to remain exact.

`packages/dashql-app/_headers` is included in the Bazel `//packages/dashql-app:pages` output. It
defines the cross-origin isolation headers and browser cache policy:

- Vite-fingerprinted assets under `/static/assets/`, `/static/css/`, `/static/fonts/`,
  `/static/img/`, `/static/js/`, `/static/scripts/`, and `/static/wasm/`: one year, immutable.
  Mutable files such as `/static/config.json` are intentionally excluded and retain Pages'
  deployment-aware default (`max-age=0, must-revalidate`).
- `/releases/*`: one year, immutable.
- WebAssembly is pre-compressed, so the bytes we deploy are the bytes users download and nothing depends on the CDN
  compressing it. The `pages` build compresses every emitted `.wasm` with Brotli (quality 11, `precompressWasm` in
  `packages/dashql-app/vite.config.tpl.ts`) and rewrites the references, `x.HASH.wasm` becomes `x.HASH.wasm.br`. The
  build fails if a raw `.wasm` is left or a reference cannot be rewritten. hyperdb-wasm ships as `.br` from npm, which
  it needs anyway because the raw file is above the 25 MiB limit of Pages.
  - `/static/wasm/*.br` and `/static/assets/hyperdb-wasm.wasm.*.br`: `Content-Encoding: br` and
    `Content-Type: application/wasm`. The browser decompresses before `fetch()` or
    `WebAssembly.instantiateStreaming()` sees the bytes. For such responses `Content-Length` is the compressed size,
    so loaders must not use it as the total of a progress bar (`utils/content_length.ts`).
  - The Electron app protocol and the browser test server serve every `*.wasm.br` the same way. Dev, `reloc` and
    `electron` builds stay uncompressed.
- Published session source under `/static/examples/sessions/*`: `no-store`, so every open fetches the
  current manifest, generated index, and SQL files.
- HTML entrypoints: stored with mandatory revalidation.

Release manifests such as `canary.json` and `stable.json`, along with updater routes, remain on
`get.dashql.app` and are not configured by this Pages deployment.

The global rule applies `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` to responses on `dashql.app`, `hyperdb.sh`, and Pages
preview URLs. It also applies `Access-Control-Allow-Origin: *`, allowing static resources to be
loaded cross-origin from either domain.

Cloudflare Pages automatically invalidates its deployment cache when a new deployment is
published. The explicit TTLs above control browser caching; no additional zone Cache Rules are
required for the Pages deployment.

## Verification

After switching the custom domain, verify the production responses:

```bash
curl -I https://dashql.app/
curl -I https://dashql.app/oauth.html
curl -I https://dashql.app/static/assets/<fingerprinted-wasm>.br
curl -I https://dashql.app/static/wasm/<fingerprinted-core-wasm>.br
curl -I https://dashql.app/a/client/side/route
curl -I https://hyperdb.sh/
```

The responses should include `Cross-Origin-Embedder-Policy: require-corp`,
`Cross-Origin-Opener-Policy: same-origin`, and `Access-Control-Allow-Origin: *`. The unknown client
route should return the app HTML, entrypoints should require revalidation, and fingerprinted
static assets should be immutable. Every `.br` WebAssembly response needs `Content-Encoding: br` and
`Content-Type: application/wasm`.
