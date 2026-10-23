import * as arrow from 'apache-arrow';

import { DataFrame, generateTableName } from './data_frame.js';
import { COLUMN_AGGREGATION_TASK, SYSTEM_COLUMN_COMPUTATION_TASK, TABLE_AGGREGATION_TASK } from './computation_types.js';
import { COMPUTATION_FROM_QUERY_RESULT, ComputationAction, CREATED_DATA_FRAME, UMAP_COMPUTATION_SUCCEEDED } from './computation_state.js';
import { ColumnAggregationTask, TableAggregationTask, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, ColumnGroup, SKIPPED_COLUMN, ListGridColumnGroup, SystemColumnComputationTask, ROWNUMBER_COLUMN, ComputationStateVersion } from './computation_types.js';
import { Dispatch, VariantKind } from '../utils/variant.js';
import { LoggerLike, stringifyError } from '../platform/logger/logger.js';
import type { EmbeddedComputeDatabase } from '../platform/database/embedded_database.js';
import { UmapRequest, projectWithUMAP } from './umap/umap_projection.js';
import { extractEmbeddingMatrix } from './umap/umap_extraction.js';
import { scheduleTask } from './computation_tasks.js';
import { createUniqueColumnName } from './arrow_columns.js';

const LOG_CTX = "compute";

/// The number of bins of an ordinal column
const BIN_COUNT = 16;

/// Analyze a table.
///
/// This function computes multiple summaries for displaying the data in the table grid component.
///
/// It consists of multiple steps:
///   1) We first global table aggregates.
///      For each of the columns we compute minimum, maximum, counts and distinct counts depending on the column type.
///   2) We then compute auxiliary system columns storing the input row number and (fractional) bin values in the domain.
///   3) We then compute summary tables per column based on these bin values.
///      (For example an aggregated histogram table for ordinal columns)
///
/// On Cross-Filters:
///   One option for fast cross-filters is to pre-compute summed area tables from Dominik's Falcon paper:
///     https://osf.io/preprints/osf/szpqm_v1
///   This paper proposes to precompute a summation table to assist brushing.
///   The idea is the following:
///     A) Aggregate counts for the cube of all cross-filter dimensions (N table columns -> 2^N fields).
///        (A, B, C) -> grouping sets ((A, B, C), (A, B), (A, C), (B, C), (A), (B), (C), ())
///     B) Compute comulative sums for the aggregates.
///        When brushing, we want to compute the count between two boundaries, for which we need cumulative sums.
///     C) Cross-filtering then becomes a O(1) lookup in this cube.
///
///   Problem:
///     This is simple when doing this for ordinal columns only, where we control the dimension count.
///     For categorical columns, we have the problem that we might want to cross-filter with a *specific* distinct value.
///     Precomputing for that is infeasible with higher distinct counts, so we'll have to maintain a non-precomputed path anyway?
///     Also, 2^N is not exactly cheap for very wide tables where the user would never visibly see the cross-filter.
///
///   Alternative:
///     We do ad-hoc cross-filter computations on the pre-computed bin fields and only for what is currently visible (!).
///     The upside here is that the bin count is dictated by what we can show in the UI and is thus usually small.
///     Whenever a user updates a cross-filter (by brushing or selecting a distinct value), we just recompute the column summaries
///     with the new set of cross-filters and update the UI.
export async function analyzeTable(tableId: number, table: arrow.Table, dispatch: Dispatch<ComputationAction>, database: EmbeddedComputeDatabase, logger: LoggerLike, projection?: UmapRequest, connectionId: string | null = null): Promise<void> {
    // Statements such as DDL can legitimately produce an Arrow table without columns. There is
    // nothing to summarize, and embedded databases reject importing a zero-column table.
    if (table.numCols === 0) {
        return;
    }

    let gridColumnGroups = buildGridColumnGroups(table!);
    const computeAbortCtrl = new AbortController();
    dispatch({
        type: COMPUTATION_FROM_QUERY_RESULT,
        value: [tableId, table!, gridColumnGroups, computeAbortCtrl, connectionId]
    });

    const inputTableName = generateTableName("__input");
    let dataFrame = await DataFrame.fromArrowTable(database, table, inputTableName);
    dispatch({
        type: CREATED_DATA_FRAME,
        value: [tableId, dataFrame]
    });

    // Compute table aggregates
    const tableAggregationTask: TableAggregationTask = {
        tableId,
        tableVersion: new ComputationStateVersion(0, 0),
        columnEntries: gridColumnGroups,
        inputDataFrame: dataFrame
    };
    const [tableAggregate, initialColumnGroups] = await scheduleTask(TABLE_AGGREGATION_TASK, tableAggregationTask, dispatch);
    gridColumnGroups = initialColumnGroups;

    // Precompute the system columns
    const precomputationTask: SystemColumnComputationTask = {
        tableId,
        tableVersion: new ComputationStateVersion(0, 0),
        columnEntries: gridColumnGroups,
        inputTable: table,
        inputDataFrame: dataFrame,
        tableAggregate
    };
    let [newTable, newDataFrame, updatedColumnGroups] = await scheduleTask(SYSTEM_COLUMN_COMPUTATION_TASK, precomputationTask, dispatch);
    gridColumnGroups = updatedColumnGroups;

    // Compute the column aggregates
    let colAggregateCount = 0;
    let colAggregateOrdinalCount = 0;
    let colAggregateStringCount = 0;
    let colAggregateSlowestDuration = 0;
    let colAggregateSlowestColumn: string | null = null;
    let colAggregatesBegin = performance.now();
    logger.info("Computing column aggregates", {
        "table": tableId.toString(),
        "rows": newTable.numRows.toString(),
        "columns": gridColumnGroups.length.toString(),
    }, LOG_CTX);
    for (let columnId = 0; columnId < gridColumnGroups.length; ++columnId) {
        // LIST columns (e.g. float32 embedding arrays) are not aggregated: their value
        // identifier / frequent-value / distinct-count computations are very expensive
        // (full-vector sort/hash) and buy nothing — no summary histogram is rendered for
        // them. We keep the LIST_COLUMN group (UMAP still attaches its projection to it),
        // but skip all of its embedded-database aggregation work.
        const columnEntry = gridColumnGroups[columnId];
        if (columnEntry.type == SKIPPED_COLUMN || columnEntry.type == ROWNUMBER_COLUMN || columnEntry.type == LIST_COLUMN) {
            continue;
        }
        const columnAggregationTask: ColumnAggregationTask = {
            tableId,
            tableVersion: new ComputationStateVersion(0, 0),
            columnId,
            tableAggregate,
            columnEntry,
            inputDataFrame: newDataFrame,
        };
        // Measured around the dispatch, so this includes the scheduler round trip.
        const columnBegin = performance.now();
        await scheduleTask(COLUMN_AGGREGATION_TASK, columnAggregationTask, dispatch);
        const columnDuration = performance.now() - columnBegin;
        if (columnDuration > colAggregateSlowestDuration) {
            colAggregateSlowestDuration = columnDuration;
            colAggregateSlowestColumn = columnEntry.value.inputFieldName;
        }
        ++colAggregateCount;
        if (columnEntry.type == ORDINAL_COLUMN) {
            ++colAggregateOrdinalCount;
        } else {
            ++colAggregateStringCount;
        }
    }
    let colAggregatesEnd = performance.now();

    if (colAggregateCount > 0) {
        const duration = colAggregatesEnd - colAggregatesBegin;
        logger.info("Computed column aggregates", {
            "table": tableId.toString(),
            "rows": newTable.numRows.toString(),
            "aggregates": colAggregateCount.toString(),
            "ordinal": colAggregateOrdinalCount.toString(),
            "string": colAggregateStringCount.toString(),
            "duration": Math.floor(duration).toString(),
            "avgDuration": Math.floor(duration / colAggregateCount).toString(),
            "maxDuration": Math.floor(colAggregateSlowestDuration).toString(),
            "slowestColumn": colAggregateSlowestColumn ?? "",
        }, LOG_CTX);
    }

    // Compute the UMAP projection (only for a resolved `'umap'` visualize spec).
    // Runs last: it appends `x`/`y` coordinate columns to both the arrow table and the
    // embedded data frame, and records their field names on the embedding column's group.
    // Blocking — the query stays in QUERY_PROCESSING_RESULTS until the projection finishes.
    if (projection != null) {
        [newTable, newDataFrame, gridColumnGroups] = await computeUmapProjection(
            tableId, newTable, newDataFrame, gridColumnGroups, projection, computeAbortCtrl, dispatch, logger
        );
    }
}

/// Compute the UMAP projection as a post-processing step and fold the resulting
/// `x`/`y` coordinates into BOTH representations of the analyzed table:
///   - the main-thread arrow `dataTable` (row-aligned, for the scatter renderer), and
///   - the embedded-database-backed `dataFrame` (so the coordinates are queryable — a plain
///     `{rownum, x, y}` arrow table is inserted and joined on the row-number key).
/// The generated coordinate field names are recorded on the embedding column's own
/// LIST_COLUMN group (as `umapProjection`), like the value-identifier meta field. On
/// extraction failure we log and return the inputs unchanged (the query still succeeds;
/// the scatter shows its empty/error placeholder).
async function computeUmapProjection(
    tableId: number,
    inputTable: arrow.Table,
    inputDataFrame: DataFrame,
    columnGroups: ColumnGroup[],
    projection: UmapRequest,
    abortCtrl: AbortController,
    dispatch: Dispatch<ComputationAction>,
    logger: LoggerLike,
): Promise<[arrow.Table, DataFrame, ColumnGroup[]]> {
    // The row-number column identifies rows across the arrow table and the embedded
    // data frame; it was appended by the system-columns step.
    let rowNumberFieldName: string | null = null;
    for (const group of columnGroups) {
        if (group.type == ROWNUMBER_COLUMN) {
            rowNumberFieldName = group.value.rowNumberFieldName;
            break;
        }
    }
    if (rowNumberFieldName == null) {
        logger.warn("Skipping UMAP projection: no row-number column", {}, LOG_CTX);
        return [inputTable, inputDataFrame, columnGroups];
    }

    const extraction = extractEmbeddingMatrix(inputTable, projection.vectorColumn);
    if (!extraction.ok) {
        logger.warn("Skipping UMAP projection", { "error": extraction.error }, LOG_CTX);
        return [inputTable, inputDataFrame, columnGroups];
    }

    // Run the projection in the worker, cancelled if the table's compute lifetime aborts.
    logger.info("Computing UMAP projection", {
        "points": extraction.matrix.count.toString(),
        "dimension": extraction.matrix.dimension.toString(),
    }, LOG_CTX);
    const projectionStart = performance.now();
    // Throttle the progress logging so we emit at most one info line every 500ms.
    let lastProgressLog = 0;
    const run = projectWithUMAP(extraction.matrix, projection.options, (progress, stage) => {
        const now = performance.now();
        if (now - lastProgressLog >= 500) {
            lastProgressLog = now;
            logger.info(`Computing UMAP projection: ${stage}`, { "progress": progress.toFixed(2) }, LOG_CTX);
        }
    });
    const onAbort = () => run.cancel();
    abortCtrl.signal.addEventListener("abort", onAbort);
    let coords;
    try {
        coords = await run.promise;
    } catch (error: any) {
        abortCtrl.signal.removeEventListener("abort", onAbort);
        logger.warn("UMAP projection failed", { "error": stringifyError(error) }, LOG_CTX);
        return [inputTable, inputDataFrame, columnGroups];
    }
    abortCtrl.signal.removeEventListener("abort", onAbort);

    // Allocate coordinate field names that don't collide with existing columns.
    const fieldNames = new Set<string>(inputTable.schema.fields.map(f => f.name));
    const xFieldName = createUniqueColumnName(`_umap_x`, fieldNames);
    const yFieldName = createUniqueColumnName(`_umap_y`, fieldNames);

    const xVector = arrow.makeVector(arrow.makeData({ type: new arrow.Float32(), data: coords.x }));
    const yVector = arrow.makeVector(arrow.makeData({ type: new arrow.Float32(), data: coords.y }));

    // Arrow side: the coordinates are row-aligned with `inputTable` (the matrix was
    // extracted from it in row order), so a direct column assign is correct.
    const outputTable = inputTable.assign(new arrow.Table({ [xFieldName]: xVector, [yFieldName]: yVector }));

    // Embedded-database side: stream the coordinates back by inserting a small keyed
    // `{rownum, x, y}` table and joining it onto the data frame on the row number.
    const database = inputDataFrame.database;
    const coordTable = new arrow.Table({
        [rowNumberFieldName]: inputTable.getChild(rowNumberFieldName)!,
        [xFieldName]: xVector,
        [yFieldName]: yVector,
    });
    const coordFrame = await DataFrame.fromArrowTable(database, coordTable, generateTableName("__umap_coords"));
    let outputDataFrame: DataFrame;
    try {
        const joinSQL =
            `SELECT base.*, coords."${xFieldName}", coords."${yFieldName}" ` +
            `FROM "${inputDataFrame.tableName}" base ` +
            `JOIN "${coordFrame.tableName}" coords USING ("${rowNumberFieldName}")`;
        outputDataFrame = await DataFrame.fromSQL(database, joinSQL, generateTableName("__umap"));
    } finally {
        await coordFrame.destroy();
    }

    // Attach the coordinate fields to the embedding column's own LIST_COLUMN group as
    // generated meta fields, exactly like `valueIdFieldName`. This keeps the coordinates
    // glued to their source column: the data-table grid renders them inline right after
    // the value/id columns (debug mode) and the scatter renderer reads them off the group.
    const inputGroupIndex = columnGroups.findIndex(group =>
        group.type == LIST_COLUMN && group.value.inputFieldName == projection.vectorColumn);
    if (inputGroupIndex < 0) {
        logger.warn("Skipping UMAP projection: no list column group for the vector column", {
            "column": projection.vectorColumn,
        }, LOG_CTX);
        return [inputTable, inputDataFrame, columnGroups];
    }
    const inputGroup = columnGroups[inputGroupIndex] as VariantKind<typeof LIST_COLUMN, ListGridColumnGroup>;
    const updatedColumnGroups: ColumnGroup[] = [...columnGroups];
    updatedColumnGroups[inputGroupIndex] = {
        type: LIST_COLUMN,
        value: {
            ...inputGroup.value,
            umapProjection: { xFieldName, yFieldName },
        }
    };

    dispatch({
        type: UMAP_COMPUTATION_SUCCEEDED,
        value: [tableId, outputTable, outputDataFrame, updatedColumnGroups]
    });

    logger.info("Computed UMAP projection", {
        "points": extraction.matrix.count.toString(),
        "dimension": extraction.matrix.dimension.toString(),
        "duration": Math.floor(performance.now() - projectionStart).toString(),
    }, LOG_CTX);

    return [outputTable, outputDataFrame, updatedColumnGroups];
}

function buildGridColumnGroups(table: arrow.Table): ColumnGroup[] {
    const columnGroups: ColumnGroup[] = [];
    for (let i = 0; i < table.schema.fields.length; ++i) {
        const field = table.schema.fields[i];
        switch (field.typeId) {
            case arrow.Type.Int:
            case arrow.Type.Int8:
            case arrow.Type.Int16:
            case arrow.Type.Int32:
            case arrow.Type.Int64:
            case arrow.Type.Uint8:
            case arrow.Type.Uint16:
            case arrow.Type.Uint32:
            case arrow.Type.Uint64:
            case arrow.Type.Float:
            case arrow.Type.Float16:
            case arrow.Type.Float32:
            case arrow.Type.Float64:
            case arrow.Type.Bool:
            case arrow.Type.Decimal:
            case arrow.Type.Date:
            case arrow.Type.DateDay:
            case arrow.Type.DateMillisecond:
            case arrow.Type.Time:
            case arrow.Type.TimeSecond:
            case arrow.Type.TimeMillisecond:
            case arrow.Type.TimeMicrosecond:
            case arrow.Type.TimeNanosecond:
            case arrow.Type.Timestamp:
            case arrow.Type.TimestampSecond:
            case arrow.Type.TimestampMillisecond:
            case arrow.Type.TimestampMicrosecond:
            case arrow.Type.TimestampNanosecond:
            case arrow.Type.DurationSecond:
            case arrow.Type.DurationMillisecond:
            case arrow.Type.DurationMicrosecond:
            case arrow.Type.DurationNanosecond:
                columnGroups.push({
                    type: ORDINAL_COLUMN,
                    value: {
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                        statsFields: null,
                        binFieldName: null,
                        binCount: BIN_COUNT
                    }
                });
                break;
            case arrow.Type.Utf8:
            case arrow.Type.LargeUtf8:
                columnGroups.push({
                    type: STRING_COLUMN,
                    value: {
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                        statsFields: null,
                        valueIdFieldName: null,
                    }
                });
                break;
            case arrow.Type.List:
            case arrow.Type.FixedSizeList:
                columnGroups.push({
                    type: LIST_COLUMN,
                    value: {
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                        statsFields: null,
                        valueIdFieldName: null,
                        umapProjection: null,
                    }
                });
                break;
            default:
                columnGroups.push({
                    type: SKIPPED_COLUMN,
                    value: {
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                    }
                });
                break;
        }
    }
    return columnGroups;
}
