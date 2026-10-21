# Vega-Lite cross-filtering

## Overview

The result details screen renders brushable column summaries alongside a Vega-Lite
visualization of the same query result. DashQL owns cross-filter evaluation: histogram
brushes update `TableComputationState.crossFilters`, and the compute layer produces a
`filterTable` containing the stable row numbers that satisfy all active filters.

Vega-Lite consumes that existing row-ID relation as a selection mask. The full chart
source remains resident in a retained Vega View, while each brush updates only a small
named mask dataset and an active-filter signal. This avoids rebuilding the Vega-Lite
specification, dataflow, and scenegraph for every brush.

The implementation lives in:

- `packages/dashql-app/src/view/visualization/vegalite_crossfilter.ts`
- `packages/dashql-app/src/view/visualization/vegalite_view.tsx`

## Data flow

```text
Histogram brush
      |
      v
TableComputationState.crossFilters
      |
      v
DashQL SQL filter task
      |
      v
FilterTable containing stable row numbers
      |
      | replace named mask dataset + active signal
      v
Retained Vega View
      |
      | lookup row number in mask
      v
Injected leading filter
      |
      v
Authored Vega-Lite transforms and marks
```

DashQL remains the source of truth for predicates and membership. Vega does not
reimplement histogram filter semantics.

## Runtime spec augmentation

`injectVegaLiteCrossFilter` creates a runtime copy of the authored Vega-Lite spec. It
does not modify the analyzed spec, saved `VISUALIZE` syntax, or core generator output.

The runtime spec receives:

1. A named source dataset, populated through the Vega View API.
2. A named row-ID mask dataset.
3. A boolean parameter indicating whether a filter is active.
4. A leading lookup and filter before all authored transforms.
5. Initially-null stable-domain signals for compiled, data-driven scales.

For a source row-number field named `_rownum`, the effective structure is:

```json
{
  "data": {"name": "__dashql_source"},
  "datasets": {
    "__dashql_crossfilter_ids": []
  },
  "params": [
    {
      "name": "__dashql_crossfilter_active",
      "value": false
    }
  ],
  "transform": [
    {
      "lookup": "_rownum",
      "from": {
        "data": {"name": "__dashql_crossfilter_ids"},
        "key": "__dashql_row_id",
        "fields": ["__dashql_crossfilter_selected"]
      },
      "as": ["__dashql_crossfilter_selected"],
      "default": false
    },
    {
      "filter": "!__dashql_crossfilter_active || datum.__dashql_crossfilter_selected === true"
    },
    "authored transforms"
  ]
}
```

The lookup is necessary because it gives the Vega-Lite compiler an explicit dependency
on the mask dataset. A filter expression using `indata(...)` alone is insufficient:
Vega-Lite does not inspect expression data dependencies and can prune an otherwise
unreferenced dataset during compilation.

The lookup and filter are prepended. This ensures aggregate, bin, stack, window,
density, regression, and scale-domain calculations operate on selected rows. Appending
the filter would change mark visibility without correctly changing upstream transforms.

The scale domains are handled separately. A `vega-embed` patch adds `domainRaw`
references to compiled scales whose domains are data-driven. Explicit constant domains
and authored `domainRaw` expressions are left unchanged. The patch operates on compiled
Vega rather than Vega-Lite so it also covers domains derived from generated aggregate,
bin, and stack fields.

Internal source, dataset, signal, and marker names are allocated dynamically to avoid
collisions with authored names and source fields. Runtime updates use the returned names
rather than relying on Vega-Lite-generated names such as `source_0`.

## Source dataset lifecycle

`VegaLiteView` converts the analyzed Arrow table to Vega-compatible JavaScript row
objects once per source-table identity. BigInts are converted to numbers and Dates to
ISO strings.

The rows are not embedded in `data.values`. After `vegaEmbed` creates the View, the
renderer loads them through:

```ts
view.data(sourceDatasetName, rows);
```

The source dataset includes DashQL's stable system row-number field. Authored encodings
ignore that field unless explicitly referenced.

When no row-number field is available, the renderer still uses the named runtime source
but omits cross-filter mask transforms. Once the analyzed table with system columns is
available, its changed table identity causes one new embed with mask support.

Result-grid ordering is intentionally not applied to Vega-Lite. Ordering controls table
display order, while chart semantics depend only on the source rows and active filters.

## Mask updates

Before applying the first mask, the updater evaluates the complete source with filtering
disabled. It reads each patched scale through `view.scale(name).domain()`, copies that
domain into the corresponding stable-domain signal, and then applies the latest pending
mask. This one-time bootstrap keeps axes, category order, and color mappings based on the
full result while marks and authored transforms continue to recompute from selected rows.

For example, if an unfiltered aggregate has a maximum count of 100 and the selected rows
have a maximum count of 12, the bars update to the filtered counts but the quantitative
axis continues to use the domain derived from 100.

An accepted `filterTable` contains one row-number column. It is converted to records of
the following shape:

```ts
{
    __dashql_row_id: number;
    __dashql_crossfilter_selected: true;
}
```

No row-ID-to-Vega-tuple map is needed. The filter table already identifies rows in the
immutable source table.

The View update replaces the mask dataset and sets the active signal:

```ts
view
    .data(maskDatasetName, maskRows)
    .signal(maskActiveSignalName, filterTable != null);
await view.runAsync();
```

The active signal distinguishes these states:

| Filter state | Mask rows | Active | Result |
|---|---:|---:|---|
| No filter | Empty | `false` | All source rows |
| Filter with matches | Matching IDs | `true` | Matching rows |
| Filter with no matches | Empty | `true` | No rows |

Deriving activity from mask length would incorrectly treat a zero-match filter as a
cleared filter.

## Update serialization

Vega requires clients to await `runAsync()` before issuing the next update.
`VegaCrossFilterUpdater` serializes View runs and stores only the newest pending mask.
Rapid brush results are therefore coalesced rather than queued indefinitely.

The updater also handles asynchronous embed completion:

- The latest mask is retained in a React ref while modules and the View load.
- The source rows are evaluated once to capture scale domains after embed completes.
- The latest mask is applied immediately after domain capture.
- Subsequent filter changes update only the mask.
- Disposal drops pending work and prevents an old View from being touched after
  finalization.

Computation state already rejects stale filter-task results. Coalescing provides the
corresponding protection across the asynchronous Vega boundary.

## Composition behavior

The named source and leading transforms are installed at the top level. Unit, layer,
facet, repeat, and concat children that inherit the root data receive the cross-filter.

Children with an explicit data source represent authored auxiliary data. They do not
inherit the DashQL result source and are not filtered by the root mask.

## Performance

For `N` source rows and `K` selected rows:

| Operation | Previous behavior | Current behavior |
|---|---|---|
| Initial Arrow conversion | `O(N)` | `O(N)` |
| Vega-Lite embed | Every accepted brush | Once per source/spec/layout |
| Brush data conversion | `O(K)` complete rows | `O(K)` row-ID records |
| Main Vega source replacement | Every accepted brush | Never |
| Mask update | None | Replace `K` small records |
| Scenegraph/dataflow construction | Every accepted brush | Retained |

The design does not guarantee `O(K)` end-to-end filtering. Updating the lookup relation
can cause Vega to re-evaluate the source filter and downstream transforms over `N` rows.
The primary gain is eliminating repeated full-row marshaling, Vega-Lite compilation,
scenegraph construction, and View teardown.

The full source is still converted from Arrow to JavaScript tuples once because Vega's
View API consumes JavaScript objects. Avoiding that initial cost requires an Arrow-aware
Vega input path or SQL pushdown that sends Vega a reduced chart-specific result.

## Correctness constraints

- The source and mask row IDs use the same JavaScript numeric representation.
- The lookup/filter always precedes authored transforms.
- Data-driven scale domains are captured from the complete source before the first mask.
- Explicit and interactive authored scale domains are not overridden.
- An active empty mask renders no rows.
- Runtime augmentation never mutates the authored spec.
- Internal names never assume a reserved namespace.
- View runs are serialized and pending masks are coalesced.
- The CSP-compatible path uses `ast: true` with `vega-interpreter`.
- Grid ordering does not affect chart data.

## Verification

`vegalite_crossfilter.test.ts` covers:

- runtime augmentation without authored-spec mutation;
- named source injection;
- lookup/filter ordering;
- internal-name collisions;
- operation without a row-number field;
- integer and bigint filter-table IDs;
- aggregate updates through a compiled Vega-Lite spec using `vega-interpreter`;
- stable quantitative and categorical domains while aggregate marks are filtered;
- preservation of explicit and authored interactive scale domains;
- mask update serialization and coalescing; and
- disposal while a View run is pending.

The relevant Bazel targets are:

```bash
bazel test //packages/dashql-app:tsc_typecheck_test
bazel test //packages/dashql-app:test_chromium //packages/dashql-app:test_firefox
```

## Future work

- Diff consecutive masks and apply Vega changesets if replacing large mask relations is
  a measured bottleneck.
- Project the initial source to fields required by the visualization plus the row ID.
- Push chart aggregation and binning into SQL so Vega receives a reduced dataset where
  row-level cross-filter semantics permit it.
- Synchronize interactions authored inside Vega-Lite back into DashQL's shared
  `CrossFilters` state.
