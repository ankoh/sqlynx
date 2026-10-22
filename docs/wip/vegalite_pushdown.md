# Push visualization transforms down into SQL

## Context

DashQL is in a rare position: it owns *both* the SQL semantics and the visualization
spec semantics for a complete, self-contained
`<classical SELECT query> VISUALIZE USING vegalite (...)` statement. Today
those two worlds are not wired together on the hot path.

**The inefficiency.** For a cell containing a visualization statement, the
frontend slices the complete query prefix from the same script and executes it.
Then `VegaLiteView` marshals the **entire** result table row-by-row into
`data: { values: rows }`
(`packages/dashql-app/src/view/visualization/vegalite_view.tsx:13-31,47`). Any
`aggregate` / `bin` / `sort` / `top-N` declared in the spec is then executed by
**Vega-Lite in JavaScript** over the full, un-reduced dataset. For a bar chart that is
`sum(revenue) by month`, we ship every row to the browser and let JS collapse it.

This is exactly the problem Mosaic addresses by compiling declarative viz transforms to
SQL against DuckDB and pulling back only the small aggregates. DashQL is better positioned
than Mosaic here: the analyzer **already captures** `aggregate`, `bin`, and `time_unit`
per encoding channel (`VisEncodingChannel` in
`packages/dashql-core/src/analyzer/types.rs`) and already emits
them into the Vega-Lite JSON (`packages/dashql-core/src/visualize/vegalite_generator.rs`). We just re-route those
directives from "JS transform" to "SQL GROUP BY".

The pushdown machinery also already exists — but only for the data-grid histograms/top-K,
via `SQLFrame` (`packages/dashql-app/src/sql/sqlframe_builder.ts`), which compiles binning,
GROUP BY aggregation, filters, ordering, and limit into DuckDB CTEs. The Vega-Lite path
simply doesn't use it.

**Intended outcome.** A visualization statement whose spec declares aggregation/binning/top-N executes
the reduction in the SQL engine (DuckDB/Hyper/Trino) and hands Vega-Lite a small,
pre-aggregated table. The declarative Vega-Lite authoring experience is unchanged; the
computation moves to where the data lives.

**Scope (agreed):** incremental pushdown compiler, lowering built in the **Rust core**
(`packages/dashql-core`). No interactive cross-filtering / selection linking in this pass. No
adoption of Mosaic as a renderer.

## Design

### The lowering rule (Vega-Lite aggregate semantics)

Vega-Lite's aggregate transform groups by *every encoded field that is not itself
aggregated* and computes the aggregate fields per group. We mirror that:

- **Group keys** = encoding channels that have a `field` but **no** `aggregate`
  (these are the "dimensions": x for a bar chart, `color`, `column`, `detail`, etc.).
- **Binned key** = a channel with `bin` becomes a group key on a bin expression.
- **Measures** = channels with an `aggregate` (`sum`, `mean`/`avg`, `count`, `min`, `max`, …).
- If **no** channel has `aggregate` and **no** channel has `bin` → **no pushdown**; fall
  back to today's behavior (raw select + Vega-Lite spec with no transforms to run anyway).

### Coordinated output: SQL *and* a rewritten spec

The critical correctness constraint: if we pre-aggregate in SQL **and** leave
`aggregate`/`bin` in the Vega-Lite spec, Vega-Lite re-aggregates the already-aggregated
column (double counting; `mean` of `mean` is wrong). So the compiler must emit a
**coordinated pair**:

1. `pushdown_sql` — the GROUP BY query producing one column per channel.
2. A Vega-Lite spec whose channels reference the **output columns by alias** with the
   `aggregate` / `bin` directives **stripped**.

Both are generated together, lazily, in the core during `AnalyzedScript::Pack`.

**Aliasing convention** (follow Vega-Lite's own defaults so titles/tooltips stay sensible):
- Group-key channel on field `F` → output column `F` (spec keeps `field: F`).
- Aggregate `A` on field `F` → output column `A_F` (e.g. `sum_revenue`); spec sets
  `field: "A_F"`, drops `aggregate`. Cosmetic note: Vega-Lite auto-title becomes
  `"sum_revenue"` instead of `"Sum of revenue"`; acceptable, and recoverable later by
  emitting an axis/legend `title`.
- `count` with no field → output column `__count` (Vega-Lite's own convention).

### Source handling: wrap the complete query prefix

The pipeline input is always a complete classical `SELECT` query in the same
script. The core owns its exact source span, so pushdown SQL can be generated
directly around that query with no frontend lookup, reconstruction, sentinel,
or substitution:

```sql
WITH __vis_source AS (
    SELECT month, revenue
    FROM sales
    WHERE fiscal_year = 2026
)
SELECT "month", SUM("revenue") AS "sum_revenue"
FROM __vis_source
GROUP BY 1
ORDER BY ...
LIMIT ...
```

The wrapper must preserve the complete query prefix exactly, including CTEs,
projections, filters, joins, grouping, ordering, and limits authored before the
pipe. The generated `pushdown_sql` is complete executable SQL. The frontend
chooses it when present and otherwise executes the original query prefix; it
never edits either string.

### Phasing

- **Phase 1 — aggregation + top-N (highest value, lowest risk).** GROUP BY over dimensions,
  aggregate measures, optional `ORDER BY` + `LIMIT` when the spec implies a top-N. This
  directly reuses the shape `SQLFrame` already proves out.
- **Phase 2 — binning.** Deferred within this effort: SQL binning produces lower/upper
  bounds, which for Vega-Lite means rewriting a binned `x` channel into `x` + `x2` (bin
  bounds) and setting `bin: { binned: true }`. More spec surgery; land after Phase 1.
- **Optional — scale-domain extents.** Low priority: post-aggregation data is already small,
  so computing `domainMin/Max` in SQL saves little. Skip unless a concrete need appears.

## Files to modify

**Rust core (`packages/dashql-core`):**
- `src/visualize/` — add a new `vegalite_pushdown.rs` implementing the lowering rule: inspect
  `spec.encoding_channels` for group keys vs. measures, read the complete query
  prefix from `spec.source_node_id`, and build the complete CTE-wrapped GROUP BY
  SQL. Mirror the SQL-building idioms in `sqlframe_builder.ts` (quoting, agg formatting).
- `src/visualize/vegalite_generator.rs` — make `generate_vegalite_spec` pushdown-aware: when
  aggregation is lowered, emit channel `field` as the output alias and **omit**
  `aggregate` (and later `bin`). Keep current behavior when no pushdown applies.
- `src/pack.rs` — in `pack_visualization`, when the renderer is `vegalite`, also generate
  the pushdown SQL next to the Vega-Lite JSON and pack it into the `VisualizationSpec` table.

**FlatBuffer schema:**
- `proto/fb/dashql/analyzed_script.fbs:281-303` — add `pushdown_sql: string;` to the
  `VisualizationSpec` table (append after `umap_spec` to preserve field ordering).
  Regenerate bindings via the normal Bazel codegen.

**Frontend (`packages/dashql-app`):**
- `src/connection/visualize_executor.ts` — in the `vegalite` branch, execute
  `spec.pushdownSql()` when present; otherwise execute the complete original
  query prefix. No source lookup or substitution is allowed. `VegaLiteView`
  needs **no change** — it just receives fewer rows and a transform-free spec.

## Verification

- **Snapshot tests** — the natural home. Add cases to
  `snapshots/visualize/basic.yaml` (driven by
  `//packages/dashql-core:visualize_snapshot_test`, encoded by
  `packages/dashql-snapshots/src/encode/visualize.rs`) with a new `pushdown_sql`
  expectation alongside the existing `vegalite` / `roundtrip` fields. Cover: (a) bar chart
  `sum(y) by x` → GROUP BY + stripped aggregate in spec; (b) multi-dimension group
  (`x` + `color`); (c) `count` with no field → `__count`; (d) no-aggregate spec → **no**
  pushdown emitted (regression guard); (e) top-N with sort+limit. Run via the Bazel test
  target (per project convention — not `npx`/`cargo` directly).
- **TS execution test** — cover selection of the complete `pushdown_sql` when
  present and fallback to the unmodified complete query prefix otherwise.
  Include a query with a CTE, join, filter, ordering, and limit to guard against
  prefix truncation or reconstruction.
- **End-to-end in the app** — run a session with a complete
  `SELECT ... FROM <relation> VISUALIZE USING vegalite (...)` query and an
  aggregating bar-chart spec; confirm the executed query is the GROUP BY (small result)
  rather than `SELECT *`, and the chart renders identically to the pre-change JS-aggregated
  version. Compare against the current behavior on the same spec.
- **Guardrail** — verify that specs with no aggregate/bin are byte-identical to today
  (spec unchanged, no `pushdown_sql`), so existing snapshots don't churn.

## Notes / open risks

- **Double-aggregation** is the correctness trap; the coordinated spec-rewrite (stripping
  `aggregate`/`bin`) is what prevents it. Any code path that emits `pushdown_sql` must also
  go through the pushdown-aware spec generation — keep them in one function so they can't
  diverge.
- **Query-boundary correctness** — source-span extraction must include the full
  classical query and exclude ` VISUALIZE`. Snapshot complex prefixes so the
  wrapper cannot silently truncate a CTE, clause, or nested query.
- **Auto-title cosmetics** — aggregated axis titles degrade from "Sum of revenue" to
  "sum_revenue"; note as a known follow-up (emit explicit axis/legend titles).
