# Core Browser Tests

The harness runs core TypeScript tests in real Chromium and Firefox without the
app bundle, React, or HyperDB. Mocha provides scoped hooks and test execution;
`vitest_compat.ts` exposes the existing Jest-style matchers and spies.

```sh
bazel test //packages/dashql-core-js/test:test_chromium
bazel test //packages/dashql-core-js/test:test_firefox
bazel test //packages/dashql-core-js/test:test_chromium --test_arg=src/api.test.ts
bazel test //packages/dashql-core-js/test:test_chromium --test_arg=package_consumer.test.ts
```

The parent package must expose these public build targets:

- `:srcs`: `src/**/*.ts`, including core tests and their fixtures.
- `:wasm_assets`: wasm-bindgen glue and Wasm under `src/wasm/dashql_core.{js,d.ts,wasm}`.

`:inputs` stages source files, Wasm assets, and `//proto/fb:dashql_buffers_ts_gen`
under `inputs/src/`, with generated bindings under `inputs/src/gen/`. Core code and
fixtures use relative imports of the staged Wasm assets. Test files are discovered
by `import.meta.glob('./inputs/src/**/*.test.ts')`; no hand-maintained test list is needed.

`:packaged` independently stages `//packages/dashql-core-js:npm_package`.
`package_consumer.test.ts` imports its public API, Wasm asset, and browser-worker
entry through exact aliases derived from the published export map. These compiled
modules have a separate identity from the source modules, so the source runtime
override does not affect them. The two consumer smoke tests verify explicit
`wasmBinary` initialization, default emitted Wasm URL loading, and real worker
`processBatch` results. The original 244 source tests remain unchanged.

Each file runs serially with fresh Mocha hooks. The test entry point compiles Wasm
once, overrides `DashQL.create` only in the test page to share one runtime, and
resets that runtime between files. The production factory reads no test globals.
`DASHQL_PRECOMPILED` remains available for fixtures not yet migrated to explicit
test-only loading. Hook failures, import failures, empty suites, and browser console
errors all fail the Bazel test.

The Playwright driver reads `__DASHQL_BROWSER_TESTS__`, matching the app driver's
summary protocol. Browser executables come from the same Bazel-managed Playwright
repositories as the app harness.

The app's separate `src/tests/core_pool.ts` keeps its existing cross-frame sharing
in test-only code. App integration must resolve `@ankoh/dashql-core` to the
new package API and retain the core Wasm URL alias used by its dashboard/frame.
