# rust-analyzer

The Rust crates are built by Bazel only. There are no Cargo manifests (crates are declared with `crate.spec` in
`bazel/crates/*.MODULE.bazel`), and part of the sources (the parser tables, the keyword table, the FlatBuffers
bindings) exist only in `bazel-out`. rust-analyzer therefore cannot load them through Cargo. It reads a
`rust-project.json` that is generated from the Bazel build graph instead.

## Generating rust-project.json

```bash
bazel run //scripts:rust_project
```

This writes `rust-project.json` to the repository root. It covers every package with Rust targets. On Linux
without the OpenSSL headers it skips `packages/dashql-native-proxy` with a warning, because `openssl-sys` cannot
build there (`apt install libssl-dev pkg-config` fixes that). Pass target patterns to cover less, for example
`bazel run //scripts:rust_project -- //packages/dashql-core/...`.

Rerun it after adding or removing crates, targets or dependencies, after editing `bazel/crates/*.MODULE.bazel`
or repinning, after changing the Rust toolchain, and after `bazel clean`. Edits to existing source files need no
rerun.

The script wraps `@rules_rust//tools/rust_analyzer:gen_rust_project` and fixes up its output:

- Crates that are also built for wasm32 appear only once, in their native configuration.
- The parser crate mixes checked-in and generated sources. The script symlinks the generated sources next to
  the checked-in ones (`src/tables.rs`, `src/keywords/table.rs`, `tests/calc_tables.rs`). The links are
  git-ignored, and Bazel resolves their paths to the generated files, so they do not affect the build.

`rust-project.json` and the links contain absolute paths of the local Bazel output base and are not checked in.

## Running the toolchain's rust-analyzer

Use the rust-analyzer that ships with the Bazel Rust toolchain (`MODULE.bazel`). `rust-project.json` points
rust-analyzer at that toolchain's standard library, and a much newer rust-analyzer (for example the latest one
from Mason or rustup) leaves its macros (`vec!`, `format!`, `assert_eq!`) unresolved. `scripts/rust-analyzer.sh`
starts the toolchain's rust-analyzer. Configure it as the server command of the editor for this repository.

There is no `cargo` in this setup. rust-analyzer needs none with `rust-project.json`, but two defaults still
reach for it:

- nvim-lspconfig's default `root_dir` for `rust_analyzer` warns `[rust_analyzer] cargo not found.` and never
  starts the server. Use the directory of `rust-project.json` as the root.
- rust-analyzer's check on save runs `cargo check`. Turn it off; `bazel build` reports the compiler errors.

For Neovim 0.11 with nvim-lspconfig, before `mason-lspconfig` is set up:

```lua
local default_root_dir = vim.lsp.config.rust_analyzer.root_dir
vim.lsp.config('rust_analyzer', {
  -- Use the repository's wrapper (the toolchain's rust-analyzer) when there is one
  cmd = function(dispatchers, config)
    local wrapper = config.root_dir and vim.fs.joinpath(config.root_dir, 'scripts/rust-analyzer.sh')
    local exe = (wrapper and vim.uv.fs_stat(wrapper)) and wrapper or 'rust-analyzer'
    return vim.lsp.rpc.start({ exe }, dispatchers, { cwd = config.root_dir })
  end,
  -- Prefer rust-project.json, fall back to lspconfig's Cargo logic elsewhere
  root_dir = function(bufnr, on_dir)
    local root = vim.fs.root(bufnr, { 'rust-project.json' })
    if root then
      return on_dir(root)
    end
    default_root_dir(bufnr, on_dir)
  end,
  settings = {
    ['rust-analyzer'] = {
      checkOnSave = false,
    },
  },
})
```

Check the setup without an editor:

```bash
scripts/rust-analyzer.sh diagnostics .
```

It must report no errors.
