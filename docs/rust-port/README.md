# Rust rewrite of dashql-core

`packages/dashql-core` (C++20, emscripten) is being rewritten in Rust as a parallel crate set,
`packages/dashql-core-rs`. The Rust core replaces the C++ core once it reaches parity. Until then the C++
core keeps shipping and serves as the differential test oracle.

## Decisions

- **Parser: bison tables, not LALRPOP.**
  - Bison stays the LALR(1) table compiler. `//grammar/rust:tables.rs.m4` is a bison skeleton that
    emits the automaton (and, for the Rust rule set, the user actions) as Rust.
  - The LR driver is a hand-written port of the C++ `DriveLALR`.
  - Code completion drives the raw LR tables (state snapshots, LAC expected sets, suffix probes) and
    the grammar resolves its conflicts with a Postgres-style precedence ladder. LALRPOP supports
    neither.
- **Scanner: hand-written**, bug-compatible with `grammar/scanner.l`.
- **JS boundary: wasm-bindgen with a new API.** FlatBuffers stays the payload format, so the generated
  TypeScript readers keep working.
- **Parse tree: unchanged by default.** Intentional changes follow [ast-changes.md](ast-changes.md) and
  land on the C++ side first.
- **Parity first, fixes later.** Known C++ bugs are reproduced and listed in [quirks.md](quirks.md).
- **Bazel only.**
  - Generated code comes from genrules, never `build.rs`.
  - Cargo manifests only feed the `@core_crates` crate universe.
  - Never `cargo build` or `cargo test`.

## Verification layers

Snapshots alone do not prove parity. The port is checked on several levels:

1. **By construction.** Both cores use:
   - the same bison automaton, checked by `:dashql_grammar_table_parity_test`
   - the same FlatBuffers enums, checked by `:dashql_buffers_test`
   - the same keyword lists
2. **Shared snapshots.** The Rust tests read the same `snapshots/**/*.yaml` and compare structurally,
   including the key order of every map. A Rust snapshotter must later regenerate the files byte for
   byte.
3. **Differential oracle.**
   - `//packages/dashql-core:oracle_ffi` is a C ABI over the C++ core that never throws, linked
     natively into Rust tests through `:dashql_oracle`. It answers in the snapshot serialization.
   - Corpus: snapshot inputs, every prefix and cursor position for completion, TPC-H/DS, random
     sentences derived from the grammar, and fuzzed inputs.
4. **Ported unit tests**, then the dashql-core-js and app test suites against the Rust wasm.

## Layout

| Target | Content |
|---|---|
| `//grammar/rust:tables.rs.m4`, `//grammar/rust:defs.bzl` | Bison skeleton and `bison_rust_tables` macro |
| `//grammar:parser_tables_rs` | The tables of `dashql.y` as Rust (tables only, actions are still C++) |
| `//proto/fb:dashql_buffers_rs` | `flatc --rust` bindings, bundled into one crate by `proto/fb/bazel/flatbuf_rust_bundle.py`. `plan_view_model_events.fbs` is excluded because Rust does not support vectors of unions. |
| `//packages/dashql-core-rs:dashql_grammar` | Grammar crate: tables, symbol kinds, symbol names, keywords (`//grammar:keywords_rs`), scanner, comment blocks |
| `//packages/dashql-core-rs:dashql_snapshots` | Loads snapshot categories as libtest-mimic trials, structural YAML comparison |
| `//packages/dashql-core-rs:dashql_oracle` | The C++ core as an oracle (`scan`, `parse`). `bazel run //packages/dashql-core-rs:oracle -- scan "..."` queries it from the shell. |
| `//packages/dashql-core-rs:core_wasm` | wasm-bindgen module (for now: grammar only, to track the module size) |

```bash
bazel test //packages/dashql-core-rs/...
bazel build --config=release //packages/dashql-core-rs:core_wasm
# After editing packages/dashql-core-rs/**/Cargo.toml:
CARGO_BAZEL_REPIN=1 bazel build @core_crates//:all
```

## Phases

| # | Phase | Gate | Status |
|---|---|---|---|
| 0 | Spikes and scaffolding | Skeleton emits the C++ automaton; harness and oracle reproduce the snapshots | **done** |
| 1 | Scanner, keywords, names, comment blocks | Token-stream differential at 0 diffs; scanner and keyword tests ported | **done** |
| 2 | Parser: Rust rule set, ParseContext, driver, LAC, recovery | Table parity between both rule sets; 506 parser snapshots; AST differential at 0 diffs | |
| 3 | Formatter, script_diff | 422 formatter and 13 diff snapshots; idempotency; Hyper validation | |
| 4 | Catalog, descriptor, AnalyzedScript, 4 analyzer passes | 101 analyzer snapshots; `ComputeSignature` equals C++ | |
| 5 | Cursor and completion | 161 completion snapshots; differential at every prefix and cursor | |
| 6 | visualize, compiler, Script, batch, planner | 27 visualize and 38 planner snapshots; batch differential | |
| 7 | ScriptSession, ScriptExecution, Hyper plan view | Session, execution and plan tests; 36 plan snapshots | |
| 8 | wasm-bindgen API and rewrite of `dashql-core-js/src/api.ts` | core-js, browser and app tests on the Rust wasm; size and speed budgets | |
| 9 | Switch-over | Release built from Rust; C++ removed after one release cycle | |
| 10 | Shell (arrow-rs) | Shell tests ported | |

## Phase 0 results (2026-10-20)

**Bison skeleton**
- `tables.rs.m4` emits the full grammar as narrow integer tables, the same types as the C++ tables:
  - 639 terminals, 359 nonterminals, 1825 rules, 2791 states
  - `yylast` 69019
  - `i16` for `yytable`/`yycheck`, `i32` for `yypact`
- It also emits the symbol names and `S_*` symbol kinds.
- `:dashql_grammar_table_parity_test` checks every table entry, constant and symbol name against the
  lalr1.cc output.
- The action path works: `:dashql_grammar_skeleton_test` runs a calculator grammar with Rust block
  actions, typed `$n`, `@n`/`@$`, precedence, default actions and errors raised from actions.
- Why our own skeleton instead of the `rust-bison-skeleton` crate:
  - That crate's m4 files carry bison's GPL header, so we can't vendor them.
  - It brings its own parse loop, but we need the tables for a ported driver.
  - Our skeleton includes only `c-like.m4` from the bison installation at build time.
- Bison has to run outside the sandbox (`local = 1`), like the existing `//grammar:parser_generated`.

**Oracle and harness**
- `:oracle_parser_snapshot_test` replays all 506 parser cases through the C++ oracle, and all pass.
- That covers 18 cases the C++ suite never registers (see [quirks.md](quirks.md)).

**Baselines** (WSL2, x86_64)

| Measure | Value |
|---|---|
| C++ `core_wasm`, `--config=release` | 2,807,795 bytes |
| Rust `core_wasm` with all parser tables, `--config=release` | 324,207 bytes (48,321 gzipped) |
| `dashql_grammar` compile time (release) | 4.5 s |
| C++ `benchmark_pipeline`, `-c opt`: scan_query | 3.2 µs |
| C++ `benchmark_pipeline`, `-c opt`: parse_query | 7.7 µs |
| C++ `benchmark_pipeline`, `-c opt`: analyze_query | 30.0 µs |
| C++ `benchmark_pipeline`, `-c opt`: move_cursor | 92 ns |
| C++ `benchmark_pipeline`, `-c opt`: complete_cursor | 1.89 ms |

**Export audit**
- `dashql-core-js/src/api.ts` uses 68 of the 70 core exports. `dashql_script_scan` and
  `dashql_script_get_scanned` are unused.
- The legacy `DashQLScript` wrapper is still used by the app (format dialog, shell share,
  `shell/api.ts`, catalog cards). It cannot be dropped wholesale; shrink it to the methods in use when
  designing the wasm-bindgen API.

## Phase 1 results

**Scanner**
- `dashql_grammar::scanner` emulates the flex matching discipline instead of using a generated DFA:
  - every rule of the current start condition computes its longest match
  - the longest match wins, and ties go to the earlier rule
  - line breaks are recorded per match, before `yyless` puts text back
- The lookahead filter is ported literally.

**Differential test**
- `:scanner_differential_test` compares the complete scanner output against the C++ scanner on:
  - every snapshot input of every category, and their prefixes
  - 32,000 deterministic fuzz inputs
- The compared output covers symbols and values, errors, line breaks, comments, obfuscated literals,
  names, comment blocks, and comment warnings.
- There are no differences.
- New quirks found along the way are in [quirks.md](quirks.md).

**Comment blocks**
- `dashql_grammar::comment_blocks` ports `GroupComments`.
- Metadata JSON is validated with serde_json instead of rapidjson.

**Open items**
- rustfmt is not wired into Bazel. `@rules_rust//tools/upstream_wrapper:rustfmt` crashes Bazel during
  execution platform registration (duplicate `@platforms//host` entry).
