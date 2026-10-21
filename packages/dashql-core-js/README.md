# DashQL Core

Portable ESM bindings for DashQL's SQL parser, analyzer, formatter, catalog,
batch processing, and plan view models. FlatBuffers is the only runtime npm
dependency. The package includes the wasm-bindgen glue, Wasm binary, generated
FlatBuffer bindings, and TypeScript declarations.

```ts
import { DashQL } from '@ankoh/dashql-core';

const core = await DashQL.create();
const catalog = core.createCatalog();
const script = core.createScript(catalog);
try {
    script.insertTextAt(0, 'select 1');
    script.analyze();
} finally {
    script.destroy();
    catalog.destroy();
}
```

The generated bindings are also available directly:

```ts
import * as buffers from '@ankoh/dashql-core/buffers';
import type { VariantKind } from '@ankoh/dashql-core';
```

Native objects (catalogs, scripts, sessions, ...) live in Wasm memory and
require explicit `destroy()`. Destroy scripts before their catalogs. Returned
FlatBuffer pointers own their bytes as a JavaScript `Uint8Array`, so readers stay
valid across subsequent operations; `destroy()` only drops the bytes.
`resetUnsafe()` is a test/reset escape hatch that invalidates all outstanding
handles.

`DashQL.create` accepts a `wasmBinary` or a precompiled WebAssembly `module` and
loads the bundled binary otherwise. The shell module re-exports the core
bindings, so `new DashQL(shellModule)` wraps it as well.

The root export does not export browser workers. In browsers, use:

```ts
import { createBatchWorker } from '@ankoh/dashql-core/browser-worker';

const worker = createBatchWorker();
const result = await worker.processBatch({ scripts: [{ id: 'query', text: 'select 1', outputs: ['analyzed'] }] });
worker.dispose();
```

The browser-worker entry point also exports `DashQLBatchWorker` and the
`BatchWorkerRequest`, `BatchWorkerResponse`, `BatchRequest`, `BatchResult`,
`BatchScriptInput`, `BatchScriptResult`, `BatchDiagnostic`, and `BatchOutput`
types. Importing it is safe in Node; creating a worker requires a browser
module-worker environment. This package is ESM-only and does not expose
internal `dist/*` paths.

## TypeScript

Declarations support `module` and `moduleResolution` set to `NodeNext` with
`strict: true` and `skipLibCheck: false`. TypeScript does not supply WebAssembly
types in its ES libraries alone. For consumers without the DOM library, use
explicit supported worker typings, for example:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "WebWorker"],
    "types": [],
    "strict": true,
    "skipLibCheck": false
  }
}
```

`WebWorker` supplies WebAssembly and browser-worker types without `DOM` or
`Document`. Browser applications can instead use their usual `DOM` typings.
No ambient type shim or extra runtime dependency is installed by this package.

Serve the package's `dist` directory intact or use a bundler that preserves
module-worker and `new URL(..., import.meta.url)` assets. The `./wasm` subpath
exports the binary; `./wasm/glue` exports the wasm-bindgen glue for custom
loading. No application-specific aliases or test globals are required.

## Bazel

- `bazel build //packages/dashql-core-js:compile` compiles ESM and declarations.
- `bazel build //packages/dashql-core-js:npm_package` assembles the npm directory.
- `bazel build //packages/dashql-core-js:npm_tarball` creates the publishable archive.
- `bazel test //packages/dashql-core-js:node_smoke_test` checks the assembled runtime.
- `bazel test //packages/dashql-core-js:tarball_consumer_test` validates the actual archive as an external consumer.
- `bazel test //packages/dashql-core-js:tests` runs the colocated core tests in Node.
- `bazel test //packages/dashql-core-js/test:all` runs source and packaged-consumer tests in Chromium and Firefox.

The real browser-worker integration test requires a browser and is skipped in
Node; worker transport tests run in both environments.

Generated source bindings are staged under `compile_inputs/src/gen/dashql/buffers`;
compiled bindings are shipped under `dist/gen/dashql/buffers`. Core tests load
their own Wasm fixture and are not shipped in the npm package.

The tarball uses the existing hermetic BSD tar toolchain through Bazel's
`tar` rule, with an ordered mtree manifest, fixed timestamps and ownership,
ustar format, and timestamp-free gzip compression. The consumer test compares
two independent archive actions byte for byte. This guarantees reproducible
packaging for identical inputs/toolchains, not identical Wasm across build
configurations or compiler versions. `package.json` is the only publish-version
source; rules_js's optional Bazel link version is unused. The root package links
`:npm_package` as `//:node_modules/@ankoh/dashql-core`, and the in-repo consumer
`//packages/dashql-app` depends on that link instead of
copying the package. TypeScript resolves it through node_modules, and the app's vite
config points `__CORE_PATH__` at `node_modules/@ankoh/dashql-core/dist`.

The external test extracts `:npm_tarball` into a fresh temporary
`node_modules/@ankoh/dashql-core`, copies only the declared FlatBuffers runtime
dependency from Bazel runfiles, and clears Node's resolution overrides. It uses
no package manager or network. Package-name imports exercise every public JS
entry point, binary resolution, default and explicit Wasm initialization,
SQL analysis, and batch processing. TypeScript runs from the Bazel tool input
against the extracted declarations, without repository aliases, DOM typings,
or skipped declaration checks. This does not replace real browser execution.

## License

DashQL is licensed under MPL-2.0, as confirmed by the repository-root `LICENSE`
and `NOTICE`. Both files are copied unchanged into the package; `NOTICE` is
the repository-wide third-party notice.
Source is available at <https://github.com/ankoh/dashql>, including the bindings
under `packages/dashql-core-js`, the Rust core under `packages/dashql-core` and
`packages/dashql-parser`, its wasm-bindgen module under `packages/dashql-core-wasm`,
and generated binding schemas under `proto/fb`. Third-party components retain
their own licenses.
