# DashQL Core Coverage Report

Date: 2026-10-21

Line coverage of the Rust core (`dashql-core`, `dashql-parser`) from the `bazel coverage` run of the unit, snapshot and parser tests (generated `tables.rs` excluded).

**Overall: 95.1% (18,371 / 19,315 lines)**, up from 85.6% (16,528 / 19,315) before the targeted snapshot and unit-test pass of today.

## Per-file coverage

| File | Lines | Coverage | Before |
|---|---|---|---|
| dashql-core/src/catalog/ids.rs | 83/83 | 100.0% | 80.7% |
| dashql-core/src/catalog/names.rs | 30/30 | 100.0% | 86.7% |
| dashql-core/src/error.rs | 47/47 | 100.0% | 12.8% |
| dashql-core/src/hash.rs | 33/33 | 100.0% | 81.8% |
| dashql-core/src/script_execution.rs | 105/105 | 100.0% | 100.0% |
| dashql-core/src/shell/api.rs | 117/117 | 100.0% | 59.8% |
| dashql-core/src/shell/mod.rs | 16/16 | 100.0% | 87.5% |
| dashql-core/src/shell/unicode.rs | 27/27 | 100.0% | 88.9% |
| dashql-core/src/shell/vt100.rs | 10/10 | 100.0% | 100.0% |
| dashql-core/src/utils/rope.rs | 74/74 | 100.0% | 100.0% |
| dashql-core/src/visualize/markdown/tests.rs | 96/96 | 100.0% | 100.0% |
| dashql-core/src/visualize/tests.rs | 82/82 | 100.0% | 100.0% |
| dashql-core/src/visualize/umap.rs | 32/32 | 100.0% | 100.0% |
| dashql-core/src/view/tests.rs | 460/461 | 99.8% | 99.8% |
| dashql-core/src/shell/prompt_buffer.rs | 311/312 | 99.7% | 93.9% |
| dashql-core/src/script.rs | 310/312 | 99.4% | 94.9% |
| dashql-core/src/view/plan_layout.rs | 262/265 | 98.9% | 98.9% |
| dashql-core/src/signature.rs | 81/82 | 98.8% | 79.3% |
| dashql-parser/src/keywords.rs | 66/67 | 98.5% | 98.5% |
| dashql-parser/src/comment_blocks.rs | 292/297 | 98.3% | 98.3% |
| dashql-core/src/shell/arrow_renderer.rs | 336/343 | 98.0% | 91.5% |
| dashql-core/src/visualize/markdown/mod.rs | 225/230 | 97.8% | 97.8% |
| dashql-core/src/analyzer/name_resolution.rs | 1254/1284 | 97.7% | 97.7% |
| dashql-core/src/utils/mod.rs | 42/43 | 97.7% | 97.7% |
| dashql-core/src/analyzer/visualization.rs | 496/508 | 97.6% | 86.6% |
| dashql-core/src/view/plan_view_model.rs | 247/253 | 97.6% | 97.6% |
| dashql-core/src/analyzer/state.rs | 230/236 | 97.5% | 97.0% |
| dashql-core/src/view/hyper_plan_parser.rs | 336/345 | 97.4% | 97.4% |
| dashql-core/src/analyzer/constants.rs | 132/136 | 97.1% | 83.8% |
| dashql-core/src/visualize/vegalite_parser.rs | 269/277 | 97.1% | 96.4% |
| dashql-core/src/catalog/descriptor.rs | 248/256 | 96.9% | 0.0% |
| dashql-core/src/formatter/create.rs | 156/161 | 96.9% | 96.9% |
| dashql-core/src/formatter/pgq.rs | 202/209 | 96.7% | 83.3% |
| dashql-core/src/catalog/mod.rs | 522/541 | 96.5% | 73.8% |
| dashql-core/src/formatter/program.rs | 471/488 | 96.5% | 95.1% |
| dashql-parser/src/parser/context.rs | 359/373 | 96.2% | 91.7% |
| dashql-core/src/script_diff.rs | 484/504 | 96.0% | 88.9% |
| dashql-core/src/cursor.rs | 280/293 | 95.6% | 95.2% |
| dashql-parser/src/names.rs | 86/90 | 95.6% | 95.6% |
| dashql-core/src/completion.rs | 1158/1212 | 95.5% | 94.7% |
| dashql-core/src/batch.rs | 103/108 | 95.4% | 0.0% |
| dashql-core/src/formatter/comments.rs | 265/278 | 95.3% | 92.1% |
| dashql-parser/src/parser/actions.rs | 120/126 | 95.2% | 95.2% |
| dashql-core/src/pack.rs | 687/723 | 95.0% | 55.2% |
| dashql-core/src/shell/session.rs | 1420/1496 | 94.9% | 86.4% |
| dashql-core/src/utils/topk.rs | 55/58 | 94.8% | 94.8% |
| dashql-core/src/formatter/vis.rs | 286/302 | 94.7% | 38.1% |
| dashql-core/src/script_session.rs | 717/757 | 94.7% | 91.9% |
| dashql-core/src/catalog/entry.rs | 170/180 | 94.4% | 88.3% |
| dashql-core/src/planner.rs | 521/553 | 94.2% | 91.5% |
| dashql-core/src/visualize/vegalite_generator.rs | 293/311 | 94.2% | 76.8% |
| dashql-parser/src/scanner.rs | 366/389 | 94.1% | 86.9% |
| dashql-core/src/analyzer/function_calls.rs | 63/67 | 94.0% | 92.5% |
| dashql-parser/src/parser/probe.rs | 200/213 | 93.9% | 93.4% |
| dashql-core/src/visualize/mod.rs | 15/16 | 93.8% | 93.8% |
| dashql-core/src/shell/session_relations.rs | 95/102 | 93.1% | 93.1% |
| dashql-core/src/formatter/select.rs | 135/148 | 91.2% | 85.1% |
| dashql-core/src/formatter/delete.rs | 20/22 | 90.9% | 90.9% |
| dashql-core/src/formatter/mod.rs | 1830/2028 | 90.2% | 81.6% |
| dashql-core/src/formatter/explain.rs | 26/29 | 89.7% | 89.7% |
| dashql-parser/src/lib.rs | 43/48 | 89.6% | 89.6% |
| dashql-core/src/analyzer/mod.rs | 65/73 | 89.0% | 76.7% |
| dashql-parser/src/parser/driver.rs | 211/238 | 88.7% | 87.8% |
| dashql-core/src/formatter/insert.rs | 44/50 | 88.0% | 88.0% |
| dashql-core/src/compiler.rs | 218/248 | 87.9% | 55.2% |
| dashql-parser/src/parser/enums.rs | 36/42 | 85.7% | 83.3% |
| dashql-core/src/analyzer/types.rs | 85/101 | 84.2% | 84.2% |
| dashql-parser/src/parser/mod.rs | 144/180 | 80.0% | 79.4% |
| dashql-parser/src/span.rs | 11/14 | 78.6% | 78.6% |
| dashql-parser/src/attributes.rs | 34/47 | 72.3% | 72.3% |
| dashql-parser/src/parser/value.rs | 26/38 | 68.4% | 68.4% |
| dashql-core/src/lib.rs | 0/0 | 0.0% | 0.0% |
| dashql-core/src/view/mod.rs | 0/0 | 0.0% | 0.0% |
| dashql-core/src/view/tests_tpch.rs | 0/0 | 0.0% | 0.0% |

## Top offenders (most uncovered lines)

| File | Uncovered | Notes |
|---|---|---|
| dashql-core/src/formatter/mod.rs | 198 | Mostly unreachable `format_unimplemented` fallbacks; reachable: `replace_obfuscated_literals` (no snapshot option), `O::XOR`, `O::NOT_GLOB`, `tinyint` |
| dashql-core/src/shell/session.rs | 76 | Terminal escaping (`escape_terminal_text`) and rare effect paths |
| dashql-core/src/completion.rs | 54 | Correlation barrier in derived tables (see known issues) |
| dashql-core/src/script_session.rs | 40 | Rare selection and diff branches |
| dashql-core/src/pack.rs | 36 | Completion and cursor-context packing branches |
| dashql-parser/src/parser/mod.rs | 36 | Error recovery and expected-symbol corners |
| dashql-core/src/planner.rs | 32 | Planner error paths |
| dashql-core/src/analyzer/name_resolution.rs | 30 | Defensive branches |
| dashql-core/src/compiler.rs | 30 | Formatting-failure and missing-visualization error paths |
| dashql-parser/src/parser/driver.rs | 27 | LR error recovery corners |

## Known issues found while writing tests

Cases that would pin wrong behavior were left out of the snapshots:

- **Formatter:** constraint attributes `NOT DEFERRABLE`, `INITIALLY DEFERRED/IMMEDIATE`, `NOT VALID`, `NO INHERIT` all map to `DEFERRABLE` in `grammar/rules/sql_create.y`; the `interval` keyword is dropped from interval types; `text array` prints as `text`; `between symmetric` prints as `between`; parentheses of graph label expressions and `union` operands (with their `order by` and `limit`) are lost; aggregate `order by`, `rows from`, `treat`, `= any (select ...)` and empty visualize specs print placeholders; syntax errors format to an empty string.
- **Scanner:** operators followed by `-`, `+` or `/*` lose characters (`a>=-1` becomes `a > -1`, `1 +/* c */ 2` fails to parse).
- **Vega-Lite generator:** string bounds keep their quotes (`domain_min => 'a'`).
- **Completion:** sibling columns are offered inside a derived table.
- **Parser:** `select * from where a = 1` parses without an error.
- **Analyzer:** constant `AND`/`OR` gets `op: UNKNOWN`; `sum(1) filter (where true)` is marked constant.
- **Snapshotter:** a cursor inside a comment does not write `no-target`.

## Suggested actions

1. Fix the issues above, then add their snapshot cases back.
2. Add a snapshot option for `replace_obfuscated_literals` and a formatter debug mode case.
3. Cover the remaining `pack.rs` completion branches with a completion packing test.
4. Remove unreachable `format_unimplemented` fallbacks, or turn them into `unreachable!`, so the formatter's coverage reflects reachable code.
5. Parser: add error-recovery inputs for `parser/mod.rs`, `driver.rs` and `value.rs`.
