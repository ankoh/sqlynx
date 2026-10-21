# Rust Coverage Fix for Bazel 8/9

The coverage workflow (`.github/workflows/coverage.yml`) covers the Rust core: it runs
`bazel coverage` over `//packages/dashql-core/...`, `//packages/dashql-parser/...` and
`//packages/dashql-snapshots/...`, instruments `//packages/dashql-core` and `//packages/dashql-parser`,
and uploads Bazel's combined report (`_coverage_report.dat`) to Coveralls.

## Problem

`bazel coverage` produced an empty tracefile for Rust targets under Bazel 8/9,
causing `lcov` to abort with empty tracefile errors.

## Root Cause

Bazel 8+ introduced split coverage post-processing (`SPLIT_COVERAGE_POST_PROCESSING=1`).
The test binary runs in one spawn and coverage collection runs in a separate spawn.
At the end of `collect_coverage.sh`, Bazel explicitly clears several environment
variables before exec-ing the LCOV merger:

```sh
JAVA_RUNFILES= RUNFILES_DIR= RUNFILES_MANIFEST_FILE= exec $LCOV_MERGER_CMD
```

For Rust tests, **the LCOV merger IS the `collect_coverage` binary from `rules_rust`**.
It receives `RUNFILES_DIR=""` (empty string).

The binary's `main()` function treated the empty string as a valid path:

```rust
// rules_rust 0.69.0 — util/collect_coverage/collect_coverage.rs, line 92
let mut runfiles_dir = PathBuf::from(env::var("RUNFILES_DIR").unwrap());
// PathBuf::from("") is empty → treated as CWD / execroot after join
if !runfiles_dir.is_absolute() {
    runfiles_dir = execroot.join(runfiles_dir); // → execroot
}
```

With `runfiles_dir = execroot`, `find_test_binary` tried to locate the binary at
`execroot/TEST_BINARY`, which does not exist.  The fallback path derivation also produced the wrong result because
`runfiles_dir.strip_prefix(execroot)` returned an empty path, yielding zero
configuration components.  `llvm-cov` was invoked with a non-existent binary,
wrote nothing to stdout, and the resulting `coverage.dat` was empty.

## Fix

### Strategy

When `RUNFILES_DIR` is empty, synthesise a `runfiles`-style bin directory by
extracting the Bazel configuration name from `COVERAGE_DIR`.

`COVERAGE_DIR` is always set to an absolute path of the form:

```
<execroot>/bazel-out/<config>/testlogs/<pkg>/<test>/
```

Stripping `execroot` and taking the first two components (`bazel-out`, `<config>`)
lets us reconstruct `<execroot>/bazel-out/<config>/bin/`.  The existing
`find_test_binary` fallback then correctly resolves the test binary to
`execroot/bazel-out/<config>/bin/<TEST_BINARY>`.

### Patch

The fix is applied via a bzlmod `single_version_override` on `rules_rust 0.69.0`.

**`bazel/patches/rules_rust_collect_coverage_fix.patch`** patches
`util/collect_coverage/collect_coverage.rs`:

```rust
// Before
let mut runfiles_dir = PathBuf::from(env::var("RUNFILES_DIR").unwrap());
if !runfiles_dir.is_absolute() {
    runfiles_dir = execroot.join(runfiles_dir);
}

// After
let runfiles_dir_raw = env::var("RUNFILES_DIR").unwrap_or_default();
let mut runfiles_dir = if runfiles_dir_raw.is_empty() {
    // Derive bin dir from COVERAGE_DIR: execroot/bazel-out/<config>/testlogs/...
    //                               --> execroot/bazel-out/<config>/bin/
    coverage_dir
        .strip_prefix(&execroot)
        .ok()
        .and_then(|rel| {
            let mut comps = rel.components();
            comps.next()?; // "bazel-out"
            let config = comps.next()?; // "<config>"
            Some(execroot.join("bazel-out").join(config.as_os_str()).join("bin"))
        })
        .unwrap_or_else(|| execroot.clone())
} else {
    PathBuf::from(&runfiles_dir_raw)
};
if !runfiles_dir.is_absolute() {
    runfiles_dir = execroot.join(runfiles_dir);
}
```

**`MODULE.bazel`** applies the patch at fetch time:

```starlark
single_version_override(
    module_name = "rules_rust",
    version = "0.69.0",
    patches = ["//bazel/patches:rules_rust_collect_coverage_fix.patch"],
    patch_strip = 1,
)
```

**`bazel/patches/BUILD.bazel`** exports the patch file so the label resolves:

```starlark
exports_files(glob(["*.patch"]))
```

### Safety net

`--ignore-errors empty,corrupt` was added to the `lcov` merge step in
`.github/workflows/coverage.yml` so that a legitimately empty tracefile (e.g. a
target with no instrumented sources) does not abort the workflow. The workflow
no longer merges tracefiles with `lcov`; it uploads Bazel's combined report directly.

## Files Changed

| File | Change |
|---|---|
| `bazel/patches/rules_rust_collect_coverage_fix.patch` | New — patch for `collect_coverage.rs` |
| `bazel/patches/BUILD.bazel` | New — exports patch files |
| `MODULE.bazel` | Added `single_version_override` for `rules_rust` |
| `.github/workflows/coverage.yml` | Added `--ignore-errors empty,corrupt` to `lcov` merge |
| `.bazelrc` | `--experimental_generate_llvm_lcov` → `--generate_llvm_lcov` (previous session) |

## Rust tests reported no coverage

Under Bazel 9 every `rust_test` produced an empty `coverage.dat`, and the per-test LCOV merger logged
`There was no coverage found.` `collect_coverage.sh` runs the collector of the test rule
(`CC_CODE_COVERAGE_SCRIPT`, the `collect_coverage` binary of `rules_rust`) only if `GENERATE_LLVM_LCOV` is set.
`--experimental_generate_llvm_lcov` does not set it for every test anymore: `cc_test` of `rules_cc` puts it into
its own test environment, `rust_test` does not. `.bazelrc` sets it for all tests under `coverage`:

```starlark
coverage --test_env=GENERATE_LLVM_LCOV=1
```

## Sources of dashql-parser were dropped

`dashql-parser` has generated sources (`src/tables.rs`, `src/keywords/table.rs`). `rules_rust` then copies all
sources of the crate into `bazel-out/<config>/bin`, and llvm-cov reports them as
`bazel-out/<config>/bin/packages/dashql-parser/src/...`. The LCOV merger keeps only files listed in the
instrumented files manifest, which names them at their source paths, so the whole parser vanished from the
report.

**`bazel/patches/rules_rust_coverage_source_paths.patch`** makes `collect_coverage.rs` strip the
`bazel-out/<config>/bin/` prefix from the `SF:` records. The checked-in sources now match the manifest; the
generated ones are not in it and stay excluded.

## Upstream

The same bug is tracked in [rules_rust PR #3812](https://github.com/bazelbuild/rules_rust/pull/3812).
Once that PR is merged and a new `rules_rust` version is released, the
`single_version_override` and patch can be removed.
