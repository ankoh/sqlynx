import * as React from 'react';

import * as styles from '../visualization.module.css';
import type * as buffers from '@ankoh/dashql-core/buffers';
import { QueryExecutionState, QueryExecutionStatus } from '../../../../connections/query_execution_state.js';
import { EmbeddingScatter, EmbeddingPoints } from './embedding_scatter.js';
import { extractCategories } from './umap_categories.js';
import { UmapInfoPanel, UmapAttribute } from './umap_info_panel.js';
import { useComputationRegistry } from '../../../../../../compute/computation_registry.js';
import { ColumnGroup, LIST_COLUMN, ORDINAL_COLUMN, ROWNUMBER_COLUMN, STRING_COLUMN } from '../../../../../../compute/computation_types.js';
import { extractFloat32Column } from '../../../../../../compute/umap/umap_extraction.js';
import { makeArrowValueFormatter } from '../../../../../../compute/arrow_formatter.js';
import { resolveVisibleRowIndices } from '../../query_result/visible_rows.js';

interface Props {
    query: QueryExecutionState | null;
    spec: buffers.visualization.UmapSpecT | null;
    /// Render the scatter with a transparent background so it blends into its container.
    transparent?: boolean;
    /// Enable pan/drag on the scatter. Defaults to true.
    interactive?: boolean;
    /// Enable scroll-wheel zoom. Disabled in the feed footer so the wheel scrolls the feed.
    /// Defaults to true.
    wheelZoom?: boolean;
}

/// Collect the names of generated "system" columns from the analyzed column groups: the row-number
/// column, per-column stats/bin/value-id meta fields, and the UMAP x/y coordinate columns. These
/// are compute-internal — the attribute panel shows only the user's own columns (each group's
/// `inputFieldName`), so we exclude everything gathered here.
function collectSystemFieldNames(columnGroups: ColumnGroup[]): Set<string> {
    const names = new Set<string>();
    const addStats = (stats: { countFieldName: string; distinctCountFieldName: string | null; minAggregateFieldName: string | null; maxAggregateFieldName: string | null } | null) => {
        if (stats == null) return;
        names.add(stats.countFieldName);
        if (stats.distinctCountFieldName != null) names.add(stats.distinctCountFieldName);
        if (stats.minAggregateFieldName != null) names.add(stats.minAggregateFieldName);
        if (stats.maxAggregateFieldName != null) names.add(stats.maxAggregateFieldName);
    };
    for (const group of columnGroups) {
        switch (group.type) {
            case ROWNUMBER_COLUMN:
                names.add(group.value.rowNumberFieldName);
                break;
            case ORDINAL_COLUMN:
                addStats(group.value.statsFields);
                if (group.value.binFieldName != null) names.add(group.value.binFieldName);
                break;
            case STRING_COLUMN:
                addStats(group.value.statsFields);
                if (group.value.valueIdFieldName != null) names.add(group.value.valueIdFieldName);
                break;
            case LIST_COLUMN:
                addStats(group.value.statsFields);
                if (group.value.valueIdFieldName != null) names.add(group.value.valueIdFieldName);
                if (group.value.umapProjection != null) {
                    names.add(group.value.umapProjection.xFieldName);
                    names.add(group.value.umapProjection.yFieldName);
                }
                break;
        }
    }
    return names;
}

/// Renders an embedding table as an interactive 2D scatter plot.
///
/// The projection is no longer computed here: when the query resolves a `'umap'`
/// visualize spec, `analyzeTable` runs the UMAP projection as a post-processing step,
/// appends the `x`/`y` coordinates to the analyzed table, and records their field names
/// on the embedding column's group.
/// This view is a pure renderer — it reads those coordinate columns out of the
/// computation state and drives the WebGPU/WebGL2 EmbeddingScatter. No worker, no
/// cache, no effect.
export function UmapView(props: Props): React.ReactElement {
    const [computationState] = useComputationRegistry();
    const spec = props.spec;
    const succeeded = props.query?.status === QueryExecutionStatus.SUCCEEDED;
    const queryId = props.query?.queryId ?? null;

    const tableComputation = queryId != null ? computationState.tableComputations[queryId] ?? null : null;

    // Locate the embedding column's group in the analyzed table's column groups and read
    // the projected coordinate columns by the generated field names recorded on it (an
    // internal detail of the compute module, not a hard-coded string).
    //
    // We render the FULL point cloud at all times and express the active cross-filter as a
    // per-point selection bitmask: selected (filter-matching) points stay at full opacity,
    // the rest are dimmed by the renderer. Ordering is intentionally NOT reflected here — it
    // only changes display order, which has no meaning in a scatter, so ordering alone dims
    // nothing. Only a `filterTable` produces a selection.
    const dataTable = tableComputation?.dataTable ?? null;
    const columnGroups = tableComputation?.columnGroups ?? null;
    const filterTable = tableComputation?.filterTable ?? null;
    const orderingTable = tableComputation?.orderingTable ?? null;

    // The coordinates only change with the analyzed table, not with every task step of the computation.
    const coordinates = React.useMemo<{ x: Float32Array; y: Float32Array } | null>(() => {
        if (dataTable == null || columnGroups == null) return null;
        const umapGroup = columnGroups.find(
            g => g.type === LIST_COLUMN && g.value.umapProjection != null);
        if (!umapGroup || umapGroup.type !== LIST_COLUMN || umapGroup.value.umapProjection == null) return null;
        const x = extractFloat32Column(dataTable, umapGroup.value.umapProjection.xFieldName);
        const y = extractFloat32Column(dataTable, umapGroup.value.umapProjection.yFieldName);
        if (!x || !y) return null;
        return { x, y };
    }, [dataTable, columnGroups]);

    const categoryColumn = typeof spec?.categoryColumn === 'string' ? spec.categoryColumn : null;
    const categories = React.useMemo(
        () => (dataTable != null && categoryColumn) ? extractCategories(dataTable, categoryColumn) : null,
        [dataTable, categoryColumn],
    );

    // Build a selection bitmask from the filtered row set (1-based row numbers → 0-based
    // positional indices, already resolved by `resolveVisibleRowIndices`). A null result
    // means no filter is active, so the whole cloud renders at full opacity.
    const pointCount = coordinates?.x.length ?? 0;
    const selection = React.useMemo<Uint32Array | null>(() => {
        // Reads only the ordering and filter tables of the computation, both are dependencies
        const selectedRows = filterTable != null ? resolveVisibleRowIndices(tableComputation) : null;
        if (selectedRows == null) return null;
        const selection = new Uint32Array(Math.ceil(pointCount / 32));
        for (let i = 0; i < selectedRows.length; ++i) {
            const row = selectedRows[i];
            if (row >= 0 && row < pointCount) {
                selection[row >>> 5] |= 1 << (row & 31);
            }
        }
        return selection;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterTable, orderingTable, pointCount]);

    const resolved = React.useMemo<{ points: EmbeddingPoints } | null>(() => {
        if (coordinates == null) return null;
        const points: EmbeddingPoints = {
            x: coordinates.x,
            y: coordinates.y,
            category: categories?.category ?? null,
            categoryCount: categoryColumn ? (categories?.categoryCount ?? 0) : 1,
            selection,
        };
        return { points };
    }, [coordinates, categories, categoryColumn, selection]);
    const points = resolved?.points ?? null;

    // Single-point selection: hovering overrules the last click, which is "sticky" (falls back to
    // it when the cursor leaves the cloud). Both are positional indices into the point cloud, which
    // equals the positional row index into the analyzed data table (the memo builds points straight
    // from dataTable, no reordering). Reset when the data table changes to avoid a stale row.
    const [clickedIndex, setClickedIndex] = React.useState<number | null>(null);
    const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
    const selectedIndex = hoveredIndex ?? clickedIndex;
    React.useEffect(() => {
        setClickedIndex(null);
        setHoveredIndex(null);
    }, [dataTable]);

    // The selected point's column values, formatted with the app's Arrow formatter. Generated
    // system columns (row number, stats, bins, value-ids, UMAP coords) are hidden — only the user's
    // own query columns are shown.
    const attributes = React.useMemo<UmapAttribute[] | null>(() => {
        if (dataTable == null || columnGroups == null || selectedIndex == null) return null;
        if (selectedIndex < 0 || selectedIndex >= dataTable.numRows) return null;
        const systemFields = collectSystemFieldNames(columnGroups);
        return dataTable.schema.fields
            .filter(field => !systemFields.has(field.name))
            .map(field => {
                const value = dataTable.getChild(field.name)?.get(selectedIndex) ?? null;
                const formatter = makeArrowValueFormatter(field);
                return { name: field.name, value: formatter.format(value) };
            });
    }, [dataTable, columnGroups, selectedIndex]);

    if (!spec) {
        return <div className={styles.empty}>No visualization available</div>;
    }
    if (!succeeded) {
        return <div className={styles.empty}>Run the query to see the visualization</div>;
    }
    if (!points) {
        // The projection is computed inside the (blocking) post-processing step, so by
        // the time the query SUCCEEDED the coordinates are present. Until then, show a
        // projecting placeholder.
        return <div className={styles.empty}>Projecting embeddings…</div>;
    }
    if (points.x.length === 0) {
        return <div className={styles.empty}>Result is empty</div>;
    }

    return (
        <div className={styles.root_flush}>
            <EmbeddingScatter
                points={points}
                transparent={props.transparent}
                interactive={props.interactive}
                wheelZoom={props.wheelZoom}
                onSelectPoint={setClickedIndex}
                onHoverPoint={setHoveredIndex}
                highlightedIndex={selectedIndex}
            />
            {resolved && <UmapInfoPanel attributes={attributes} />}
        </div>
    );
}
