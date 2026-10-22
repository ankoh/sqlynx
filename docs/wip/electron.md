# Electron Native Stack

## Status

This document records the migration from Tauri to Electron. Electron is now the
only native host; release validation remains in progress until the Electron stack has
passed the capability, security, packaging, and update gates below.

Current execution state:

| Area | State |
|---|---|
| Architecture and framework selection | Complete |
| Minimal Electron host | Complete |
| Secure application protocol and isolation | Complete for development host |
| Runtime Memory64 and shared-memory checks | Complete, including real HyperDB query |
| HyperDB-only embedded database | Capability proof complete; product workflows pending |
| Rust native proxy integration | Planned |
| Native platform API migration | Planned |
| Universal macOS packaging | Planned |
| Signing and notarization | Implemented in CI; requires production validation |
| R2 incremental updates | Planned |
| Tauri replacement decision | Complete: Electron is the only desktop host |

## Motivation

The current Tauri stack provides useful native behavior with a compact bundle:

- `dashql://` deep links and OAuth callback delivery.
- Native windows, dialogs, filesystem access, file watching, shell integration,
  process restart, logging, and drag and drop.
- A Rust custom-protocol backend for DuckDB, gRPC, and HTTP access.
- Signed incremental updates hosted on Cloudflare R2.
- Universal arm64/x86_64 macOS builds with signing and notarization.

The macOS system webview currently blocks two required web-platform features:

- WebAssembly Memory64 is not available in the required form.
- Cross-origin isolation is not reliable for the custom-scheme application,
  preventing `SharedArrayBuffer`, shared Wasm memory, and Wasm threads.

Electron ships Chromium. Electron 35 and newer contain Chromium versions where
Memory64 is enabled by default, and Electron custom protocols can return normal
responses with the COOP and COEP headers needed for cross-origin isolation.

The main tradeoff is distribution size and baseline memory use. A universal
Electron app is expected to add roughly 250-400 MiB installed and 90-170 MiB to
the compressed initial download. These estimates must be replaced by measured
release artifacts before making a migration decision.

## Proposed Stack

| Layer | Choice |
|---|---|
| Runtime | A currently supported Electron release, minimum Electron 35 |
| Main/preload/renderer build | `electron-vite` |
| Packaging | `electron-builder` |
| Updates | `electron-updater` with an R2-hosted generic feed |
| Renderer origin | Secure, standard `app://bundle/` custom protocol |
| Renderer privilege boundary | Sandboxed preload with narrow typed methods |
| Embedded database | HyperDB Wasm in Electron's Chromium renderer |
| Native proxies | `napi-rs` addon loaded in an Electron utility process |
| Initial macOS artifact | Universal DMG plus signed update ZIP/blockmap |
| Build and verification | Bazel targets only |

Electron Forge remains the fallback if official Electron governance becomes
more important than the unified `electron-builder` update pipeline. Nextron is
not justified because DashQL does not require Next.js. Template projects such
as Electron React Boilerplate are references rather than architecture
dependencies.

## Target Architecture

The renderer must remain an unprivileged web application. It must not receive
Node.js, filesystem, process, shell, or arbitrary IPC access.

```text
app://bundle/index.html
        |
        | contextBridge methods and events
        v
Electron preload (sandboxed, narrow API)
        |
        | validated IPC
        v
Electron main process
        |
        | validated utility-process messages
        v
Electron utility process
        |
        | Node-API with binary buffers
        v
Rust `napi-rs` addon
        |
        +-- gRPC and TLS
        +-- streaming HTTP

Electron renderer
        |
        | Memory64, shared Wasm memory, pthread workers
        v
HyperDB Wasm
```

The production `BrowserWindow` settings are:

```js
{
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  preload
}
```

The application protocol must be registered before Electron is ready with at
least `standard`, `secure`, and `supportFetchAPI` privileges. Its handler must:

- Map requests only into the packaged renderer directory.
- Validate the URL host and reject traversal and malformed encoding.
- Return correct MIME types, including `application/wasm`.
- Set `Cross-Origin-Opener-Policy: same-origin`.
- Set `Cross-Origin-Embedder-Policy: require-corp`.
- Set a restrictive Content Security Policy.
- Set `X-Content-Type-Options: nosniff`.
- Never enable `bypassCSP` or disable `webSecurity`.

The renderer startup gate must test actual capabilities, not infer them from an
Electron version:

- `window.isSecureContext === true`.
- `window.crossOriginIsolated === true`.
- A small Memory64 Wasm probe validates.
- Shared Wasm memory can be passed to a worker.
- The real HyperDB Memory64 module initializes and runs a representative query.

## Embedded Database Strategy

Electron replaces native DuckDB with HyperDB Wasm. This is a goal of the
migration rather than a fallback: Chromium provides Memory64, cross-origin
isolation, `SharedArrayBuffer`, Wasm exceptions, and pthread workers on desktop,
allowing the browser and desktop products to use the same embedded engine.

The Electron renderer build must therefore include the real HyperDB browser
provider and compressed Wasm artifact. It must not set
`DASHQL_NATIVE_BUILD=true`, because that build flag intentionally selects the
Tauri DuckDB provider. A separate Electron Vite mode provides relative asset
URLs and hash routing while retaining the web HyperDB provider.

The native DuckDB implementation and `ipc_bridge` may remain while Tauri is
supported, but they are not dependencies of the Electron product and are not
part of its acceptance gates. If Electron replaces Tauri, they can be removed
after the installed-product migration is complete.

## Native Proxy Strategy

The existing non-database Rust proxy implementation is compiled into a Node-API
addon with `napi-rs`. The addon is loaded in an Electron utility process rather
than the Electron main process. This avoids a custom Rust sidecar wire protocol
while preserving crash isolation for native code, Tokio, and network
operations.

The utility process communicates with Electron main through Electron's
structured process messages. The addon API uses Node `Buffer` values, avoiding
the JSON integer arrays used by the old stdio proof. Renderer code never loads
or receives the addon directly. Electron main remains responsible for sender
validation and exposes only narrow preload methods.

Migration steps:

1. Compile a Tauri- and DuckDB-independent Rust proxy library.
2. Expose its request router through a `napi-rs` Node-API addon.
3. Load and supervise the addon in an Electron utility process.
4. Prove unary gRPC, streaming gRPC, and HTTP operations.
5. Measure utility-process message CPU, memory, latency, and allocation overhead.
6. Add request cancellation, backpressure, process-exit propagation, bounded
   message sizes, startup timeout, and graceful shutdown.
7. Build arm64 and x86_64 addons through Bazel and merge the release `.node`
   binary with `lipo` for the universal application.

The renderer's existing `dashql-native://localhost/...` request contract can be
kept during the proof of concept by adapting Electron protocol requests to the
sidecar. The long-term API should be a typed preload surface unless retaining
the HTTP-shaped contract proves materially simpler and equally secure.

## Native Platform APIs

Port Tauri integrations behind framework-neutral TypeScript interfaces rather
than scattering Electron checks through the application.

| Current responsibility | Electron implementation |
|---|---|
| Native runtime detection | Build-time platform adapter selection |
| Deep links | Protocol client, `open-url`, `second-instance` |
| Single instance | `app.requestSingleInstanceLock()` |
| Window and titlebar | `BrowserWindow` with titlebar overlay |
| File drag and drop | Renderer drop event plus validated preload path handling |
| Open/save dialogs | `dialog` in main through typed preload calls |
| Filesystem and watching | Main process or native sidecar with scoped grants |
| Open external URL | Main-process allowlist around `shell.openExternal` |
| Relaunch | `app.relaunch()` followed by `app.exit()` |
| Logging | Renderer event to structured main/native logger |
| OAuth loopback callback | Reuse Rust server with host-neutral event callback |
| Updates | Main-process `electron-updater` state machine |

Deep links are untrusted input. The host must validate scheme, host, path, query
keys, payload size, and payload encoding before forwarding an event. Cold-start
and already-running delivery must use the same parsing function. Integration
tests must cover both paths.

## Packaging And Size

`electron-builder` should initially emit separate arm64 and x86_64 artifacts as
well as a universal artifact. This provides measurements and leaves open the
option of architecture-specific public downloads.

Expected universal artifacts:

```text
DashQL-<version>-universal.dmg
DashQL-<version>-universal-mac.zip
DashQL-<version>-universal-mac.zip.blockmap
latest-mac.yml
```

The size gate records, for Tauri, Electron arm64, Electron x86_64, and Electron
universal builds:

- Installed `.app` bytes.
- Compressed DMG bytes.
- Compressed update archive bytes.
- N to N+1 transferred update bytes for a renderer-only change.
- N to N+1 transferred update bytes for a Rust-addon change.
- N to N+1 transferred update bytes for a HyperDB Wasm change.
- N to N+1 transferred update bytes for an Electron runtime change.
- Cold-start time, idle RSS, and representative workload RSS.

Do not optimize bundle size until these measurements identify the dominant
components. Likely safe optimizations include pruning unused locales, excluding
source maps and debug artifacts, avoiding duplicate architecture-independent
resources, and keeping optional large data assets outside the initial bundle.

## Signing And Notarization

The existing Apple certificate and notarization credentials remain useful, but
Electron's nested bundle must be signed from the inside out. The current
single-executable bundle assembly and broad `codesign --deep` operation are not
sufficient as the final Electron signing design.

The release pipeline must:

1. Assemble and merge the universal application.
2. Sign the Rust `.node` addon and all Electron helpers and frameworks.
3. Sign the outer application with hardened runtime and explicit entitlements.
4. Verify the designated requirements and every nested executable.
5. Build the DMG and update ZIP.
6. Notarize the distributed artifacts.
7. Staple the application/DMG where supported.
8. Test launch and update on clean arm64 and x86_64 systems, including Rosetta.

## R2 Updates

The first Electron updater implementation should use `electron-updater` with a
generic HTTPS provider backed by the existing R2 bucket. A native R2 publisher
can be adopted after the corresponding stable tool versions are qualified.

Suggested object layout:

```text
releases/<version>/macos/DashQL-<version>-universal.dmg
releases/<version>/macos/DashQL-<version>-universal-mac.zip
releases/<version>/macos/DashQL-<version>-universal-mac.zip.blockmap
channels/stable/latest-mac.yml
channels/canary/latest-mac.yml
```

Publishing rules:

- Versioned artifacts are immutable and uploaded first.
- Channel metadata is mutable, uses `no-cache`, and is uploaded last.
- Previous update archives and blockmaps remain available.
- R2/custom-domain responses support correct single byte ranges.
- CDN transformations and recompression are disabled for update artifacts.
- A release is promoted only after hash, signature, range, and N to N+1 tests.

Electron's default update authenticity model differs from Tauri. Tauri verifies
an application-specific Ed25519 signature; Electron normally uses manifest
SHA-512 plus Apple code signing or Windows Authenticode. Before production,
decide whether to add a signed Electron manifest verified in main with the
existing release key. Treat R2 manifest-write credentials as release-signing
credentials either way.

Use client-side stable cohorts for an initial staged rollout. Add a Cloudflare
Worker only if account-level rollout rings, private artifact authorization, a
central kill switch, or eligibility telemetry is required. Recover from a bad
release with a higher-version fix rather than relying on downgrade behavior.

## Execution Plan

### Phase 0: Baseline

- Record release Tauri app, DMG, and updater sizes.
- Record startup time and idle/workload RSS.
- Preserve current native tests as the behavioral baseline.
- Add no Electron dependency to production release targets.

Exit criteria: reproducible baseline measurements from signed or release-mode
artifacts.

### Phase 1: Chromium Capability Proof

- Replace the retired Tauri host with Electron in `packages/dashql-native`.
- Start Electron against the existing native renderer bundle.
- Serve assets through `app://bundle/` with COOP, COEP, CSP, and MIME headers.
- Keep renderer sandboxing and context isolation enabled.
- Add a narrow preload API for runtime capability reporting.
- Verify secure context, cross-origin isolation, Memory64, shared memory, worker
  transfer, and the real HyperDB module.

Exit criteria: all runtime capability checks pass without Chromium experimental
flags or weakened Electron security settings.

### Phase 2: HyperDB Product Integration

- Make the Electron renderer select HyperDB Wasm as its embedded database.
- Verify application loading, compute queries, session queries, Arrow imports,
  persistence, shutdown, and relaunch behavior.
- Remove Electron dependencies on the native DuckDB protocol and bridge.
- Measure engine initialization, query latency, peak memory, and the additional
  compressed artifact size.

Exit criteria: Electron desktop workflows use HyperDB Wasm exclusively and no
DuckDB binary or route is packaged in the Electron application.

### Phase 3: Native Proxy Proof

- Build a Tauri-independent `napi-rs` addon without DuckDB.
- Load it in a supervised Electron utility process.
- Prove unary and streaming gRPC and HTTP streaming operations.
- Add crash, cancellation, timeout, malformed-message, and shutdown tests.
- Measure bridge overhead with representative protobuf and stream payloads.

Exit criteria: native behavior matches Tauri and measured overhead is acceptable
or a binary bridge implementation is scoped from evidence.

### Phase 4: Native Integration

- Implement deep-link cold start and second-instance delivery.
- Port dialogs, scoped filesystem access, watching, shell opening, relaunch,
  logging, drag and drop, and OAuth callbacks.
- Remove direct Tauri imports from application feature code in favor of shared
  platform interfaces.
- Validate navigation, external URL, IPC sender, and path allowlists.

Exit criteria: application workflows run in Electron without granting Node.js
to the renderer.

### Phase 5: Packaging

- Add arm64, x86_64, and universal Electron packaging targets.
- Package and sign the universal Rust `.node` addon.
- Configure exact file inclusion and ASAR boundaries.
- Sign nested components, notarize, and staple.
- Measure all size and resource gates.

Exit criteria: clean-machine installation and launch pass on Apple Silicon,
Intel, and Rosetta, with recorded size and performance results.

### Phase 6: Updates

- Generate update ZIPs, blockmaps, and channel metadata.
- Publish an isolated test channel to R2.
- Test full and differential N to N+1 updates.
- Test interrupted download, restart, bad hash, bad signature, stale metadata,
  paused rollout, and recovery release behavior.
- Decide and implement the additional signed-manifest policy.

Exit criteria: signed universal applications update reliably through R2 and a
failed update cannot replace the installed app.

### Phase 7: Decision And Migration

- Compare capability, size, memory, startup, maintenance, and release evidence.
- Decide between Electron, Tauri, or maintaining both hosts.
- If Electron wins, ship a Tauri bridge release that installs/migrates to the
  Electron product while preserving user data, protocol ownership, bundle
  identity, and uninstall behavior.
- Retire Tauri only after production rollout and rollback windows close.

Exit criteria: an explicit decision backed by measured artifacts and a tested
installed-product migration.

## Decision Gates

Electron is accepted only if:

- The real Memory64 workload passes.
- `crossOriginIsolated` and shared Wasm workers pass in packaged builds.
- No renderer receives Node integration or an unrestricted native API.
- Native proxy correctness and throughput remain acceptable.
- Deep links and OAuth work for cold and running applications.
- Universal signing, notarization, and clean-machine launch pass.
- R2 full and differential updates pass failure-injection tests.
- The measured size, startup, and memory costs are accepted explicitly.

Any failed gate keeps Tauri as the production host while the relevant proof is
reworked or the migration is abandoned.

## Immediate Work

The first checked-in slice is intentionally narrow:

1. Create the parallel Electron package without modifying Tauri release targets.
2. Add a Bazel-built Electron main/preload host.
3. Serve the existing `//packages/dashql-app:native` output through the secure
   custom protocol.
4. Expose and display runtime isolation capability results.
5. Add Bazel verification for protocol path validation and response headers.

Sidecar integration follows only after this capability proof is green.

## Execution Log

### 2026-08-28: Initial Capability Host

The first Electron host now exists at `packages/dashql-native`, replacing the
retired Tauri application while retaining the native app's release identity.

Implemented:

- Electron 38.8.6, embedding Chromium 140.0.7339.249 and Node 22.22.0.
- Bazel TypeScript compilation and Vitest targets.
- A Bazel development launcher using the existing
  `//packages/dashql-app:native` renderer bundle.
- A secure standard `app://bundle/` protocol with path confinement, MIME
  handling, COOP, COEP, CORP, CSP, and `nosniff` response headers.
- A sandboxed `BrowserWindow` with Node integration disabled and context
  isolation enabled.
- A narrow preload method for runtime-version and isolation reporting.
- A headless-by-lifecycle capability runner at
  `//packages/dashql-native:capability_test`.
- Unit tests for application URL validation, isolation headers, and Wasm MIME
  handling.

Verified through Bazel:

```text
bazel build //packages/dashql-native:compile
bazel build //packages/dashql-native:dev //packages/dashql-native:capability_test
bazel test //packages/dashql-native:test
bazel run //packages/dashql-native:capability_test
```

Observed capability result:

```json
{
  "crossOriginIsolated": true,
  "memory64": true,
  "secureContext": true,
  "sharedArrayBuffer": true,
  "sharedMemoryWorker": true,
  "chrome": "140.0.7339.249",
  "electron": "38.8.6",
  "node": "22.22.0"
}
```

The Memory64 result comes from validating a minimal Memory64 module. The shared
memory result creates a shared `WebAssembly.Memory` and transfers it to a real
worker.

### 2026-08-28: Real HyperDB Wasm Query

The Electron renderer now has a dedicated Vite mode and Bazel target at
`//packages/dashql-app:electron`. Unlike the Tauri `native` mode, it keeps
relative asset URLs while including the real HyperDB browser provider and
Memory64 Wasm artifact. The Tauri renderer remains unchanged and still excludes
HyperDB.

The capability page initializes the production browser worker, compiles and
runs the full HyperDB Wasm module, initializes pthread workers and OPFS, and
executes:

```sql
SELECT 42::INTEGER AS answer, 'hyper'::TEXT AS engine
```

Observed result:

```json
{
  "crossOriginIsolated": true,
  "memory64": true,
  "secureContext": true,
  "sharedArrayBuffer": true,
  "sharedMemoryWorker": true,
  "chrome": "140.0.7339.249",
  "electron": "38.8.6",
  "node": "22.22.0",
  "hyperdb": {
    "answer": 42,
    "durationMs": 663,
    "engine": "hyper",
    "initialized": true,
    "version": "Hyper 9.1.0 emulation, hyper version __UNVERSIONED_HYPER__.0.0.0.r00000000"
  }
}
```

Electron's custom protocol handler decompresses the packaged Brotli Wasm asset
before returning it as `application/wasm`. Returning compressed bytes with a
`Content-Encoding` header did not trigger transparent decoding for Electron's
custom protocol response, so explicit host-side decompression is currently
required. Packaging work should measure the startup memory and CPU effect and
evaluate pre-decompressing the Wasm artifact at build time.

This closes the Phase 1 runtime capability gate and confirms that Electron can
replace native DuckDB with HyperDB Wasm. The remaining HyperDB work is product
integration and persistence testing, not engine compatibility.

Next execution slice:

1. Run the normal Electron renderer with HyperDB as its only embedded database.
2. Test OPFS persistence across Electron termination and relaunch.
3. Adapt host detection so Electron native integrations can be added without
   selecting Tauri plugins or native DuckDB.

### 2026-08-28: Native Addon Utility Process

The native proxy architecture now uses a Node-API addon in an Electron utility
process rather than a standalone Rust sidecar.

Implemented:

- A new `packages/dashql-native-napi` Rust workspace crate.
- A Bazel `rust_shared_library` compiled as a Tauri-free `.node` addon.
- A DuckDB-free Rust router containing gRPC and streaming HTTP routes.
- Direct `http` crate imports in reusable proxy modules instead of Tauri's HTTP
  re-exports.
- `napi-rs` exports using Node `Buffer` values for request and response bodies.
- An Electron utility worker that loads the addon outside Electron main.
- A deterministic `/health` route and binary-message integration test.

The first utility-process response was:

```json
{
  "body": "{\"status\":\"ok\"}",
  "health": "dashql-native-napi:ok",
  "headers": [["content-type", "application/json"]],
  "id": 1,
  "status": 200,
  "statusText": "OK"
}
```

The addon target has no dependency on Tauri, Tauri plugins, Tauri ACL
generation, DuckDB, the Tauri build script, or generated test protos. The
existing Tauri application keeps its current native router and DuckDB while the
migration remains parallel.

This proves the complete packaging and runtime seam:

```text
Bazel Rust cdylib -> .node -> Electron utilityProcess -> Node-API Buffer -> Rust router
```

The next native-proxy slice is replacing the test-only main-process call with a
long-lived request multiplexer and preload API, followed by loopback gRPC and
HTTP streaming tests.

### 2026-08-28: Long-Lived Native Proxy And HTTP Streaming

The Electron main process now starts one long-lived native proxy utility
process for normal application sessions. A correlated request service owns the
utility process and provides:

- Monotonically increasing request IDs.
- Concurrent and out-of-order response correlation.
- A startup-ready handshake after the addon loads.
- Per-request timeouts.
- Rejection of all pending calls when the utility process exits or fails.
- Bounded request bodies, header count, and header value sizes.
- Explicit allowed methods and `dashql-native://localhost/{grpc,http}`
  route validation.
- Shutdown of the utility process during application quit.

The preload exposes only a structured native proxy request method. Electron
main validates the sender frame and request again before forwarding it. The
internal health route used by integration tests is not available to renderer
calls.

The native addon integration test now runs a full streaming HTTP request against
an ephemeral loopback server created only inside the test. No loopback server is
used by the production Electron application. The verified path is:

```text
Electron main test server
        ^
        | Rust reqwest HTTP request and streamed response
napi-rs addon
        ^
        | Node-API Buffer
Electron utility process
        ^
        | correlated utility-process messages
Electron main
```

The test verifies binary request forwarding, query parameters, upstream status
and headers, streamed binary response chunks, terminal stream events, and
stream deletion. Observed result:

```json
{
  "health": "{\"status\":\"ok\"}",
  "receivedBody": [0, 1, 2, 127, 128, 255],
  "receivedMethod": "POST",
  "receivedUrl": "/stream-test?token=loopback",
  "removedStatus": 200,
  "streamBody": [1, 2, 3, 4, 5, 6, 7, 8],
  "streamEvent": "StreamFinished",
  "streamStatus": 206
}
```

The next proxy work is loopback unary and server-streaming gRPC coverage,
followed by replacing the generic renderer-facing request shape with
operation-specific APIs where practical.

### 2026-08-28: Unary And Streaming gRPC

The native addon integration test now also runs a cleartext HTTP/2 gRPC server
on an ephemeral loopback port. As with the HTTP server, it exists only inside
the test and is not part of production Electron communication.

The test uses raw protobuf payloads and gRPC frames so the addon remains generic
and does not depend on generated test protos. It verifies:

- gRPC channel creation and deletion.
- Unary request and response framing.
- Server-stream creation, batched reads, trailers, and deletion.
- Binary protobuf integrity through Electron messages and Node-API buffers.
- Initial metadata and trailing metadata propagation.
- Filtering of private `dashql-*` headers before remote calls.
- Correlation of all requests through the long-lived utility process.

Observed gRPC result:

```json
{
  "grpcChannelRemovedStatus": 200,
  "grpcRequestCount": 2,
  "grpcStreamBody": [3, 0, 0, 0, 10, 1, 97, 3, 0, 0, 0, 10, 1, 98],
  "grpcStreamEvent": "StreamFinished",
  "grpcStreamMessages": "2",
  "grpcStreamRemovedStatus": 200,
  "grpcStreamTrailer": "stream-done",
  "grpcUnaryBody": [10, 1, 117],
  "grpcUnaryInitial": "unary"
}
```

This closes the deterministic HTTP and gRPC transport proof for the addon and
utility-process architecture. TLS behavior remains covered by the existing Rust
proxy tests. The next product slice is normal application startup with explicit
Electron host detection, HyperDB selection, and native-proxy capability
selection, followed by OPFS persistence across relaunch.

### 2026-08-28: Product Startup And OPFS Persistence

The application now distinguishes web, Tauri, and Electron hosts explicitly.
The legacy `isNativePlatform()` predicate remains a compatibility alias for
Tauri-only integrations, preventing Electron host identity from accidentally
selecting Tauri plugins, native DuckDB, or unavailable native filesystem APIs.
Embedded database selection now checks the Tauri host directly, so Electron
always selects HyperDB Wasm.

The normal application exposes a machine-readable startup result after Core,
the embedded database, storage restoration, and routing setup complete. The
Electron startup smoke test loads the real `index.html` and verifies:

```json
{
  "embeddedDatabase": "hyperdb-wasm",
  "host": "electron",
  "status": "ready",
  "crossOriginIsolated": true,
  "electronBridge": true,
  "legacyBridge": false
}
```

The Electron renderer bundle now includes the runtime `static/config.json`.
The preload is emitted as CommonJS because Electron's sandboxed preload loader
does not execute the package's ESM TypeScript output directly. The application
and response CSPs permit the secure `app:` origin and required Wasm fetches.

A two-launch OPFS test uses the same isolated Electron profile and
`app://bundle` origin. The first process creates, writes, checkpoints, and
terminates a persistent HyperDB database. A fresh Electron process then opens
the database, verifies the value, and drops it.

Observed results:

```json
{"durationMs":758,"initialized":true,"mode":"persistence-write","persisted":true}
{"answer":42,"durationMs":728,"initialized":true,"mode":"persistence-verify","persisted":true,"value":"dashql-opfs-persistence"}
```

This closes the normal startup, Electron host-selection, HyperDB-only embedded
database, and basic persistence gates. Remaining product integration work
includes Electron implementations for deep links, filesystem dialogs and
watching, external browser launch, logging, updates, and version-feed access.
