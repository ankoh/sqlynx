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
| 2 | Parser: Rust rule set, ParseContext, driver, LAC, recovery | Table parity between both rule sets; 506 parser snapshots; AST differential at 0 diffs | **done** |
| 3 | Formatter, script_diff | 422 formatter and 13 diff snapshots; idempotency; Hyper validation | **done** (idempotency and Hyper validation open) |
| 4 | Catalog, descriptor, AnalyzedScript, 4 analyzer passes | 101 analyzer snapshots; `ComputeSignature` equals C++ | **analyzer and signature done** (packing, catalog tests open) |
| 5 | Cursor and completion | 161 completion snapshots; differential at every prefix and cursor | **done** (unit tests open) |
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

## Phase 2 results

**Rust rule set**
- `//grammar:rust_rule_files` translates the actions of `grammar/rules/*.y` into Rust in the build,
  using `grammar/rust/translate_actions.py`. All 1238 actions translate, and the rules themselves are
  copied verbatim.
- `grammar/rules/*.y` therefore stay the single source of the grammar until the C++ core is removed.
  At that point the translated rules get checked in and the translator is deleted.
- `assemble_grammar.py --lang rust` derives the Rust prologue (tokens, types) from the C++ one.
- `:dashql_grammar_table_parity_test` asserts that both rule sets describe the identical automaton.
  Only `yyrline` (debug line numbers) differs.

**Runtime** (`dashql_grammar::parser`)
- `ParseContext` is ported with interior mutability, so translated actions nest calls in the same
  order as the C++ actions. Semantic values are `Copy`, with lists and n-ary expressions in arenas.
- The driver ports the lalr1.cc loop:
  - full LAC
  - verbose errors and the SCONST hint
  - `error` token recovery, `YYERROR` and `yyclearin`
  - the custom `YYLLOC_DEFAULT`
- `feed` and `lac_check` are exposed for the completion probes.

**Gates**
- `:parser_snapshot_test`: all 506 parser snapshots pass, produced by the Rust parser and a port of
  the C++ encoder.
- `:parser_differential_test`: raw output equals the C++ parser. The comparison covers every node
  field, statements, errors with hints, vis spec spans, feature flags, names, and obfuscated
  literals. The inputs are:
  - all snapshot inputs and their prefixes
  - 3200 random sentences of the grammar (random walks through the LR automaton over acceptable
    tokens, about 85 tokens each)
  - 8000 fuzz inputs

**Performance** (`bazel run -c opt //packages/dashql-core-rs:bench_pipeline`, TPC-DS q1, same
machine as the baseline):

| Measure | Rust | C++ |
|---|---|---|
| scan | 2.3 µs | 3.2 µs |
| parse | 8.6 µs | 7.7 µs |

Changes that got the Rust code here:
- **Scanner:** keyword lookup through a generated FNV hash table, an open-addressing name registry,
  and no per-identifier allocations.
- **Parser:**
  - each grammar action is its own function, so `reduce` has a small frame
  - list allocations are recycled
  - the parse context state uses a `RefCell` only in debug builds

## Phase 3 results

- `script_diff` is ported (`dashql_core::script_diff`). `:diff_snapshot_test` passes the 13 diff
  snapshots and a differential against `tools/oracle_ffi_script_diff.cc` over edited snapshot inputs.
- The formatter is ported (`dashql_core::formatter`).
  - `:formatter_snapshot_test` passes all 422 cases (1287 expectations), including the reparse checks
    of the `coverage_` cases.
  - `:formatter_differential_test` compares text and unformattable nodes against
    `tools/oracle_ffi_formatter.cc`: 238k whole-script and 12.5k single-node comparisons, covering
    every snapshot input under 16 configs (modes, dialects, keyword cases, widths, indentation, debug
    mode), prefixes, and fuzz inputs with comments. 0 differences.
- Open: the idempotency check and the Hyper validation of formatted SQL.
- The Hyper plan view model is ported (`dashql_core::view`) with a port of the needed parts of
  rapidjson. `:plan_view_model_snapshot_test` passes 36 of 36 plans (including the `pipelines`
  section, which the C++ suite skips), the 19 `hyper_plan_test.cc` tests pass, and
  `:plan_view_model_differential_test` finds 0 differences in 51,720 comparisons (bit-identical
  layout) against `tools/oracle_ffi_view.cc`.

**Attribute lookups.** The C++ core looks up object attributes through compile-time
`frozen::unordered_map`s. `dashql_grammar::attrs!` fixes the keys at compile time too (duplicate
keys fail constant evaluation) and scans the children against the constant key array, which LLVM
vectorizes. Measured with `bench_pipeline` (`attrs_21/*`, the 21 keys of a vis scale):

| Children | Constant-key scan | Static perfect hash | Direct-index table |
|---|---|---|---|
| 5 | 4 ns | 8 ns | 9 ns |
| 21 | 11 ns | 13 ns | 24 ns |
| 40 | 14 ns | 18 ns | 28 ns |

Formatting TPC-DS q1 (`format_query`, added to both benchmarks) takes 6.1 µs in Rust and 11.4 µs in
C++. The hash table variant was 6.5 µs, so it was dropped.

## Phase 4 results

- The catalog (`dashql_core::catalog`) publishes analyzed scripts and descriptor pools as immutable
  entries shared through `Arc`. An analyzed script holds the entries it was analyzed against, which
  replaces the `retained_catalog_dependencies` lease. Id reservations go through the catalog by
  shared reference, so an analysis only needs `&Catalog`.
- The analyzer (`dashql_core::analyzer`) ports the four passes with the 1024-node morsel
  interleaving of the `PassManager`, so expression ids match. Objects live in vectors of the
  analyzed script and reference each other by index.
- `:analyzer_snapshot_test` passes all 101 analyzer snapshots on the keys the C++ suite compares.
- `:analyzer_differential_test` compares the complete encoding, including visualizations, against
  `tools/oracle_ffi_analyzer.cc` with 0 differences. Inputs: every analyzer case with prefixes, every
  snapshot input of every category alone and against the snapshot catalogs with prefixes, and 3200
  fuzzed scripts against fuzzed catalogs.
- `dashql_core::signature::compute_signature` equals `Script::ComputeSignature` on every snapshot
  input, their prefixes and 4000 fuzz inputs (`:signature_differential_test`).
- Open: the FlatBuffer packing of the analyzed script, and the catalog,
  descriptor and analyzer unit tests.

**Performance** (TPC-DS q1 against the TPC-DS schema in the catalog, `bench_pipeline` and
`benchmark_pipeline`):

| Measure | Rust | C++ |
|---|---|---|
| analyze (analysis only) | 10.6 µs | 12.7 µs (`analyze_query_only`) |
| `Script::Analyze` (rescan, reparse, analyze) | | 29.0 µs (`analyze_query`) |

`analyze_query` of the C++ benchmark rescans and reparses on every iteration, because a script whose
names carry analyzer tags is never reanalyzed in place. `analyze_query_only` measures the analysis
alone. What made the Rust analyzer fast, from 25.6 µs:
- node states move up the tree by taking over the child buffers instead of copying (C++ splices
  intrusive lists),
- visualization node states exist only for nodes with visualization state,
- the property graph ancestor walk is skipped for scripts without graph syntax,
- the maps use FxHash (`dashql_core::hash`) instead of SipHash.

Name resolution could also store its node states as linked lists like C++, which would remove the
remaining per-list allocations.

## Phase 5 results

- The LR probes of the completion (`DriveLALR` and its policies) are ported to
  `dashql_grammar::parser::probe`: `parse_until_with_snapshot`, `parse_until_after`, and the suffix
  probes over a state snapshot, with the 128-reductions bound.
- `dashql_core::cursor` ports `ScriptCursor` and the location lookups, `dashql_core::completion`
  ports the completion. Name lookups use per-entry suffix indexes in the case-insensitive order of
  the C++ `btree::multimap`; candidates are ranked with a port of libstdc++'s `std::sort`
  (`dashql_core::utils::sort`), because `TopKHeap` breaks ties by the unstable sort.
- `:completion_snapshot_test` passes all 161 completion snapshots (including the analysis of the
  catalog and editor scripts).
- `:completion_differential_test` compares the complete encoding with
  `tools/oracle_ffi_completion.cc` at every cursor position of every completion snapshot, at sampled
  positions in all other snapshot inputs (with and without a catalog), and at the end of prefixes:
  0 differences.
- Open: `completion_test.cc` (33 tests) and `cursor_test.cc`, which need the `Script` facade.

**Open items**
- The repository `rustfmt.toml` is not valid TOML (`max_width: 120`), so rustfmt refuses it. Format
  with `--config max_width=120,use_small_heuristics=Max` until it is fixed.
- rustfmt is not wired into Bazel. `@rules_rust//tools/upstream_wrapper:rustfmt` crashes Bazel during
  execution platform registration (duplicate `@platforms//host` entry).
