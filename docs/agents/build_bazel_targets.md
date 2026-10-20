# Building, Testing, and Verifying with Bazel

## Core Principle

**All building, testing, and verification MUST be done through Bazel targets.**

Do not invoke language-specific tools or package-manager scripts directly (`npx tsc`, `yarn build`, `yarn test`, `pnpm run build`, `pnpm test`, `npm run build`, `cargo build`, `cargo test`, etc.). These bypass the build system's dependency tracking, caching, and reproducibility guarantees — even when the underlying `package.json` script exists, the Bazel target is the source of truth.

## Why Bazel Only?

### Problems with Direct Tool Invocation

Running `npx tsc` or `cargo build` directly:
- **Breaks incremental builds** — Bazel doesn't know about changes made outside its sandbox
- **Misses dependencies** — Tool may succeed locally but fail in CI due to missing deps
- **Wastes time** — No shared cache, rebuilds everything
- **Creates inconsistency** — Different results between local dev and CI
- **Corrupts bazel-bin/** — Manual writes can invalidate Bazel's cache

### Bazel Benefits

- **Hermetic builds** — Same inputs always produce same outputs
- **Shared cache** — [bazel-cache.dashql.app](https://bazel-cache.dashql.app) speeds up builds for everyone
- **Correct dependencies** — Bazel enforces that all inputs are declared
- **Parallel execution** — Bazel automatically parallelizes independent actions
- **Cross-language support** — One tool for C++, Rust, TypeScript, and WebAssembly

## Building Targets

### General Pattern

```bash
# Build a specific target
bazel build //packages/dashql-core:dashql_core

# Build all targets in a package
bazel build //packages/dashql-app:all

# Build everything
bazel build //...
```

### Common Build Targets

| Target | Purpose |
|--------|---------|
| `//packages/dashql-app:pages` | Web app bundle for Cloudflare Pages |
| `//packages/dashql-app:reloc` | Web app bundle for native apps |
| `//packages/dashql-native:mac_package_arm64` | arm64 macOS Electron app, DMG, ZIP, and blockmaps |
| `//packages/dashql-native:mac_package_x86_64` | x86_64 macOS Electron app, DMG, ZIP, and blockmaps |
| `//packages/dashql-pack:pack` | Publish architecture-specific Electron artifacts and update manifests to R2 |
| `//packages/dashql-pack:vacuum` | Remove complete expired release versions, including old updater blockmaps |
| `//packages/dashql-core-rs:core_wasm` | Core Wasm module (Rust, wasm-bindgen) shipped by `dashql-core-js` |
| `//packages/dashql-core-rs:shell_wasm` | Shell Wasm module (Rust, includes the core bindings) shipped by the app |
| `//packages/dashql-core:dashql_core` | Core C++ library, kept as the differential oracle of the Rust core |
| `//packages/dashql-core-js:compile` | Core ESM bindings and TypeScript declarations |
| `//packages/dashql-core-js:npm_package` | Standalone core npm package directory |
| `//packages/dashql-core-js:npm_tarball` | Core npm archive at `bazel-bin/packages/dashql-core-js/dashql-core.tgz` |

### Build Configs

```bash
# Fast development builds (default)
bazel build //packages/dashql-app:all

# Optimized release builds
bazel build --config=release //packages/dashql-app:pages

# Debug builds with symbols
bazel build --config=debug //packages/dashql-app:dev
```

Use `--config=release` for production artifacts. The default `fastbuild` config is sufficient for development.

## Running Tests

### General Pattern

```bash
# Run a specific test
bazel test //packages/dashql-core:unit_tests

# Run all tests in a package
bazel test //packages/dashql-core:all

# Run all tests in the repo
bazel test //...

# Run tests matching a pattern
bazel test //packages/dashql-core:*_tests
```

### Common Test Targets

| Target | Purpose |
|--------|---------|
| `//packages/dashql-core:unit_tests` | C++ unit tests |
| `//packages/dashql-core:parser_tests` | Parser snapshot tests |
| `//packages/dashql-core:analyzer_tests` | Analyzer snapshot tests |
| `//packages/dashql-core:formatter_tests` | Formatter snapshot tests |
| `//packages/dashql-core-rs:formatter_validation_hyper_test` | Execute the formatted SQL of the formatter snapshots in Hyper |
| `//packages/dashql-core-rs/...` | Rust core: unit, snapshot and differential tests against the C++ oracle (see `docs/rust-port/README.md`) |
| `//packages/dashql-core-js:all` | Core Node unit, assembled-runtime, and tarball consumer tests |
| `//packages/dashql-core-js/test:all` | Core browser tests in Chromium and Firefox, including browser workers |
| `//packages/hyper-api:smoke_test` | Native Tableau Hyper API integration test |
| `//packages/dashql-native:test` | Electron host unit tests |
| `//packages/dashql-cli:tests` | DashQL CLI unit tests, including execution in hyperdb-wasm |
| `//packages/dashql-app:test_chromium` | Web app tests in Chromium |
| `//packages/dashql-app:test_firefox` | Web app tests in Firefox |

### Test Output

By default, Bazel only shows output for failed tests (configured in `.bazelrc`):

```bash
# See all test output
bazel test --test_output=all //packages/dashql-core:unit_tests

# See output for failed tests only (default)
bazel test --test_output=errors //packages/dashql-core:unit_tests
```

### Snapshot Tests

Many tests use snapshot fixtures in `/snapshots/`. To update snapshots after intentional changes:

```bash
bazel run //snapshots/parser:update
bazel run //snapshots/analyzer:update
bazel run //snapshots/formatter:update
bazel run //snapshots/completion:update
bazel run //snapshots/plans/hyper/tests:update
```

These targets regenerate `/snapshots/*.yaml` from `/snapshots/*.tpl.yaml` templates.

## Type Checking

### TypeScript

TypeScript type checking is integrated into Bazel test targets:

```bash
# Type check a specific package
bazel test //packages/dashql-app:tsc_typecheck_test

# Type check with transitive dependencies
bazel test //packages/dashql-app:tsc_transitive_typecheck_test
```

**Never run `npx tsc` directly.** The typecheck tests use the same `tsconfig.json` but run through Bazel's sandbox with correct `NODE_PATH` resolution.

### Rust

Rust type checking happens automatically during `bazel build` and `bazel test`. The Rust compiler is part of the build graph, so type errors will fail the build.

```bash
# This type-checks as part of building
bazel build //packages/dashql-native-napi:addon
```

### C++

C++ type checking happens during compilation. For IDE integration with clangd:

```bash
# Generate compile_commands.json for clangd
bazel run //:refresh_compile_commands
```

This creates `compile_commands.json` in the workspace root, which clangd uses for real-time type checking in your editor.

## Querying Targets

Use `bazel query` to find targets:

```bash
# List all targets in a package
bazel query //packages/dashql-core:all

# Find all test targets
bazel query 'kind(".*_test", //...)'

# Find all Rust targets
bazel query 'kind("rust_.*", //packages/dashql-native-napi:all)'

# Show dependencies of a target
bazel query 'deps(//packages/dashql-app:pages)'

# Show reverse dependencies (what depends on this?)
bazel query 'rdeps(//..., //packages/dashql-core:dashql_core)'
```

## Development Servers

For local development with hot module reloading:

```bash
# Start browser dev server with HMR
bazel run //packages/dashql-app:dev

# Start the Vite server in Electron mode with renderer HMR
bazel run //packages/dashql-app:dev -- --mode electron

# Start the native app (connects to the Electron-mode Vite server)
bazel run //packages/dashql-native:dev
```

Run the last two commands in separate terminals for Electron development.
`//packages/dashql-native:dev` defaults to `http://localhost:9002`; set
`DASHQL_ELECTRON_RENDERER_URL` to use another loopback HTTP origin.

## Anti-Patterns

### Never Do This

```bash
# ❌ Direct TypeScript compilation
npx tsc
npx tsc --noEmit

# ❌ Direct Cargo commands
cargo build
cargo test
cargo check

# ❌ Direct yarn / pnpm / npm scripts for building or testing
yarn build
yarn test
yarn typecheck
pnpm run build
pnpm test
npm run build

# ❌ Manual file operations in bazel-bin/
cp something.wasm bazel-bin/packages/foo/
rm -rf bazel-bin/packages/bar/
```

### Always Do This

```bash
# ✅ Bazel type checking
bazel test //packages/dashql-app:tsc_typecheck_test

# ✅ Bazel building
bazel build //packages/dashql-native-napi:addon

# ✅ Bazel testing
bazel test //packages/dashql-native:test

# ✅ Bazel target for code generation
bazel run //snapshots/parser:update
```

## Common Workflows

### After Changing TypeScript Code

```bash
# Type check and run tests
bazel test //packages/dashql-app:tsc_typecheck_test
bazel test //packages/dashql-app:test_chromium //packages/dashql-app:test_firefox
```

### After Changing Rust Code

```bash
# Build and test (type checking happens automatically)
bazel test //packages/dashql-native:test
```

### After Changing C++ Code

```bash
# Build and run relevant tests
bazel build //packages/dashql-core:dashql_core
bazel test //packages/dashql-core:unit_tests
```

### Core npm Package

```bash
# Compile ESM bindings and declarations
bazel build //packages/dashql-core-js:compile

# Assemble the standalone npm directory
bazel build //packages/dashql-core-js:npm_package

# Run Node, tarball consumer, and browser tests
bazel test //packages/dashql-core-js:all //packages/dashql-core-js/test:all

# Build the release archive without building the app or native packages
bazel build --config=release //packages/dashql-core-js:npm_tarball
```

The package targets depend directly on `//packages/dashql-core-rs:core_wasm` and its
wasm-bindgen glue (`:dashql_core_bindgen`) and build the TypeScript API around them. The release archive is
`bazel-bin/packages/dashql-core-js/dashql-core.tgz`. Trusted CI waits for the release
Wasm build and requires that artifact to be available in the remote cache before
packaging, so it does not rebuild the same Wasm action. It uploads the archive as
`dashql_core_npm`; it does not publish to npm. Trusted fastbuild/release and
untrusted fastbuild CI run both core JS test target sets.

### After Changing Parser Grammar

```bash
# Rebuild parser and update snapshots
bazel build //packages/dashql-core:dashql_core
bazel run //snapshots/parser:update

# Verify snapshot changes
git diff snapshots/parser/
```

### Checking and Executing SQL Scripts

`//packages/dashql-cli:cli execute` scans, parses and analyzes SQL scripts and executes the ones without errors in an
in-memory Hyper database. It prints the errors and warnings and, per script, how many rows its final query or
VISUALIZE returns. Use it to check scripts you write, see `packages/dashql-cli/README.md`.

```bash
bazel run //packages/dashql-cli:cli -- execute path/to/script.sql path/to/dir
echo "select 1 +;" | bazel run //packages/dashql-cli:cli -- execute -
# Only scan, parse and analyze
bazel run //packages/dashql-cli:cli -- lint path/to/dir
# Resolve names against CREATE TABLE statements, which also run first
bazel run //packages/dashql-cli:cli -- execute --schema schema.sql query.sql
```

### Before Committing

```bash
# Run all tests
bazel test //...

# Or run tests for changed areas only
bazel test //packages/dashql-app:all
bazel test //packages/dashql-core:all
```

## Dependency Management

### Updating Rust Dependencies

```bash
# Update Cargo.lock and regenerate Bazel files
bazel run //scripts:repin_crates
```

This updates `Cargo.lock`, `Cargo.Bazel.lock`, and regenerates `defs.bzl` for all Rust dependencies.

### Updating Node Dependencies

Node dependencies are managed via `pnpm` and exposed to Bazel via `aspect_rules_js`. After updating `package.json`:

```bash
# Update lockfile (outside Bazel)
pnpm install

# Bazel will automatically pick up changes on next build
bazel build //packages/dashql-app:pages
```

## Summary

When working as an agent:

1. **Query first** — Use `bazel query` to discover targets
2. **Build through Bazel** — Never invoke `tsc`, `cargo`, `npm run`, etc.
3. **Test through Bazel** — All tests are Bazel targets
4. **Verify through Bazel** — Type checking is a test target
5. **Trust the cache** — Bazel's incrementality is correct; avoid `clean`

If you find yourself typing `yarn`, `pnpm`, `npm`, `npx`, or `cargo`, stop and find the Bazel target instead.
