# VISUALIZE Execution — Proof of Concept

> Historical design record, superseded by complete-query execution. The
> original POC used frontend source lookup, source-kind dispatch, and notebook
> script references. Those mechanisms were removed and must not be used as a
> current implementation guide. The supported architecture executes the
> complete classical query prefix written before ` VISUALIZE` with no
> frontend substitution.

## Context

At the time of this POC, visualization stopped at *analysis*: the analyzer
collected a `VisualizationSpec`, and the C++ side could lift it into Vega-Lite
JSON via `dashql::visualize::GenerateVegaLiteSpec`, but:

1. The visualization specs are **not serialized** into `AnalyzedScript` (`analyzed_script.fbs`), so the app can't see them.
2. There is no execution path: when a user sends a visualization statement, its raw text is shipped to the backend, which doesn't speak the dialect.
3. There is no Vega-Lite renderer on the frontend.

The current user-facing form is a complete query followed by the visualization
operator, for example `select i, i * 2 as v from generate_series(0, 10) as t(i)
 visualize using vegalite (...)`. Running it shows the query result in the
existing data table and enables the visualization tab.

Key decisions:

- **Always re-execute the source** in v1; no cache reuse, no refcounted result map yet.
- **Vega-Lite JSON belongs on the analyzed-script flatbuffer.** The vis analysis is currently omitted entirely; we use this opportunity to wire it through. The TS side reads the spec from there.
- **Wrap in a new `QueryExecutionState`** for the visualization statement's script (so its tabs behave like any other script's).
- Render with `vega-embed` + `vega-loader-arrow` to bind Apache Arrow results directly.
- The current execution path has one source shape: the complete classical
  `SELECT` query prefix.

## Historical implementation outline

### Core (C++)

The C++ core has since been replaced by the Rust core in `packages/dashql-core`. The counterparts of
the files below are `src/analyzer/types.rs`, `src/analyzer/visualization.rs`, `src/pack.rs`
(`pack_visualization`) and `src/visualize/vegalite_generator.rs`.

- `proto/fb/dashql/analyzed_script.fbs` — add a `VisualizationSpec` table
  containing the renderer output, AST/statement ids, and the AST node id for
  the complete input query; add `visualization_specs: [VisualizationSpec]` to
  `AnalyzedScript`.
- `packages/dashql-core/include/dashql/analyzer/analyzer_types.h` — retain the
  complete query AST node on the in-memory `VisualizationSpec` together with
  `vegalite_json`.
- `packages/dashql-core/src/analyzer/analyze_visualization_pass.cc` — record the
  required `OBJECT_SQL_SELECT` prefix as the visualization query. Do not
  classify table, script, or inline source variants.
- `packages/dashql-core/src/analyzer/analyzer.cc` (the `Pack` path that produces `AnalyzedScript` flatbuffer) — call `visualize::GenerateVegaLiteSpec` once per spec, store the JSON, and serialize the new `VisualizationSpec` table into the flatbuffer. Reuse the existing logic in `tools/snapshotter.cc:797` and `test/visualize_snapshot_test_suite.cc:38` as the reference for how to call the generator.
- Add a snapshot test that asserts the new flatbuffer field round-trips.

### App (TypeScript)

- `packages/dashql-app/package.json` — add deps `vega`, `vega-lite`, `vega-embed`, `vega-loader-arrow`.
- `packages/dashql-app/src/connection/visualize_executor.ts` *(new)* — given a `ScriptData` with a single pipeline ending in a VIS_VISUALISE node:
  1. Read the analyzed flatbuffer's `VisualizationSpec`.
  2. Read the complete query AST node's text range and slice that span from the
     same script.
  3. Call the existing `executeQuery` with that SQL, return the new `queryId` and a handle to the Vega-Lite JSON.
- `packages/dashql-app/src/view/notebook/notebook_feed.tsx` (in `handleSend`) — before calling `executeQuery`, detect VIS_VISUALISE via the analyzed buffer; if present, dispatch through `visualize_executor.ts` instead. Either way, wrap the resulting `queryId` into the script's `latestQueryId` via `REGISTER_QUERY` (unchanged action shape — visualize execution still produces one `QueryExecutionState`, sourced from the complete query prefix).
- `packages/dashql-app/src/view/visualization/visualization_dispatch.tsx` and
  `packages/dashql-app/src/view/visualization/vegalite_view.tsx` — dispatch the resolved renderer,
  attach the result data to the Vega-Lite spec, and mount `vega-embed`. They handle resize and
  rendering errors; callers disable visualization tabs until the result is available.
- `packages/dashql-app/src/view/notebook/script_details.tsx`:
  - Add `TabKey.Visualization = 3` to the enum (line 38).
  - Compute `hasVisualizeStmt` from the editor session's portable script annotations.
  - Update the `enabledTabs` counter (lines 233–236) to include the visualization tab only when `activeQueryState.status === SUCCEEDED && hasVisualizeStmt`.
  - Add the tab in `tabProps` (chart icon — pick an appropriate symbol from `@ankoh/dashql-svg-symbols`; reuse `#table_24` style as a placeholder if no chart icon exists yet) and the renderer in `tabRenderers`.
  - Update the keyboard cycle list (line 288) and split-tab fallback logic (lines 392–410) to include the new tab.
- `packages/dashql-app/src/scripts/notebook_scripts.ts` `deriveScriptAnnotations` — also lift the complete visualization query out of the analyzed buffer into `ScriptAnnotations`, so consumers don't re-decode the flatbuffer per render.
- `packages/dashql-app/src/scripts/script_types.ts` — extend `ScriptAnnotations` with the visualization query and renderer data.

## Historical reuse decisions

- C++ Vega-Lite generation: `visualize::GenerateVegaLiteSpec` already exists and is exercised by snapshot tests. We just call it from the analyzer's `Pack` path.
- Query plumbing: `executeQuery` in `connection/query_executor.tsx` plus `REGISTER_QUERY` in `scripts/notebook_scripts.ts`, dispatched from `view/notebook/notebook_feed.tsx`, already covers ID allocation, dispatch, lifecycle, and the computation registry. Visualize execution piggy-backs on this — we don't add a parallel state machine.
- Query extraction: the parser already provides the complete source span, so
  execution does not depend on catalog or notebook source reconstruction.

## Historical scope exclusions

- No refcounted result map; no result reuse. Every run of a script containing a visualization statement issues a fresh source query.
- No multi-statement orchestration; we still treat a script as a single execution unit, and v1 assumes a visualization script contains exactly one statement ending in VIS_VISUALISE.
- No edits to ggsql; no grammar changes.
- No footer-tab change. The third "Visualization" tab is added only to the script *details* panel (per the user's description of "below the result data table").

## Historical verification plan

1. **Bazel tests** (per repo convention — never `npx vitest` directly):
   - `bazel test //packages/dashql-core/...` — covers the new analyzer serialization snapshot.
   - `bazel test //packages/dashql-app/...` — covers extraction of the complete
     query prefix and annotation decoding.
2. **Snapshot test** (new): write a fixture containing a self-contained query
   statement and assert that the analyzed flatbuffer contains a
   `VisualizationSpec` with a non-empty Vega-Lite spec and the complete query
   AST node.
3. **Manual end-to-end** (DashQL app dev server):
   - Create a script containing `select i, i * 2 as v from
     generate_series(0, 10) as t(i) visualize using vegalite (mark => line,
     x => i, y => v);`. Run it.
   - Verify: data tab shows the same 11-row result; the new Visualization tab is enabled and renders a line chart via vega-embed.
   - Repeat with a CTE, projection, and filter in the query prefix to verify that
     the exact self-contained query is executed.
4. **Regression check**: a script with no `VISUALIZE` statement keeps the same two-then-three tab progression (Editor / Status / Data) — the Visualization tab stays disabled and absent from cycling.
