import * as arrow from 'apache-arrow';

import { ArrowTableFormatter } from './arrow_formatter.js';
import { DataFrame, generateTableName } from './data_frame.js';
import { AsyncValue } from '../utils/async_value.js';
import { COLUMN_AGGREGATION_TASK, DATA_SEARCH_TASK, FILTERED_COLUMN_AGGREGATION_TASK, SYSTEM_COLUMN_COMPUTATION_TASK, TABLE_AGGREGATION_TASK, TABLE_FILTERING_TASK, TABLE_ORDERING_TASK, TaskVariant } from './computation_scheduler.js';
import { COMPUTATION_FROM_QUERY_RESULT, ComputationAction, createArrowFieldIndex, CREATED_DATA_FRAME, SCHEDULE_TASK, UMAP_COMPUTATION_SUCCEEDED } from './computation_state.js';
import { ColumnAggregationVariant, ColumnAggregationTask, TableAggregationTask, TableOrderingTask, TableAggregation, OrderingTable, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, ColumnGroup, SKIPPED_COLUMN, OrdinalColumnAnalysis, StringColumnAnalysis, ListGridColumnGroup, StringGridColumnGroup, OrdinalGridColumnGroup, BinnedValuesTable, FrequentValuesTable, SystemColumnComputationTask, ROWNUMBER_COLUMN, getGridColumnTypeName, TableFilteringTask, FilterTable, WithFilter, WithFilterEpoch, ComputationStateVersion, DataSearchTask, DataSearchTable } from './computation_types.js';
import { Dispatch, VariantKind } from '../utils/variant.js';
import { LoggableException, LoggerLike, stringifyError } from '../platform/logger/logger.js';
import { assert } from '../utils/assert.js';
import { SQLFrame } from './sql/sqlframe_builder.js';
import type { EmbeddedComputeDatabase } from '../platform/database/embedded_database.js';
import { UmapRequest, projectWithUMAP } from './umap/umap_projection.js';
import { extractEmbeddingMatrix } from './umap/umap_extraction.js';
import { buildDataSearchSQL } from './sql/query_result_search_sql.js';
export type ComputeQueryExecution = <T>(queryText: string, execute: () => Promise<T>) => Promise<T>;

const LOG_CTX = "compute";

const executeDirectly: ComputeQueryExecution = (_queryText, execute) => execute();

function isTemporalType(typeId: arrow.Type): boolean {
    switch (typeId) {
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
            return true;
        default:
            return false;
    }
}

function getToNumericFn(typeId: arrow.Type): string | undefined {
    if (isTemporalType(typeId)) {
        return "EPOCH";
    }
    return typeId === arrow.Type.Bool ? "BOOLEAN" : undefined;
}

function isIntegerType(typeId: arrow.Type): boolean {
    switch (typeId) {
        case arrow.Type.Int:
        case arrow.Type.Int8:
        case arrow.Type.Int16:
        case arrow.Type.Int32:
        case arrow.Type.Int64:
        case arrow.Type.Uint8:
        case arrow.Type.Uint16:
        case arrow.Type.Uint32:
        case arrow.Type.Uint64:
            return true;
        default:
            return false;
    }
}

function getSmallIntegerDomainSize(minValue: unknown, maxValue: unknown, maxSize: number): number | null {
    if (typeof minValue === 'bigint' && typeof maxValue === 'bigint') {
        const size = maxValue - minValue + 1n;
        return size > 0n && size <= BigInt(maxSize) ? Number(size) : null;
    }
    if (typeof minValue === 'number' && typeof maxValue === 'number' && Number.isInteger(minValue) && Number.isInteger(maxValue)) {
        const size = maxValue - minValue + 1;
        return size > 0 && size <= maxSize ? size : null;
    }
    return null;
}

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
///
export async function analyzeTable(tableId: number, table: arrow.Table, dispatch: Dispatch<ComputationAction>, database: EmbeddedComputeDatabase, logger: LoggerLike, projection?: UmapRequest): Promise<void> {
    // Statements such as DDL can legitimately produce an Arrow table without columns. There is
    // nothing to summarize, and embedded databases reject importing a zero-column table.
    if (table.numCols === 0) {
        return;
    }

    let gridColumnGroups = buildGridColumnGroups(table!);
    const computeAbortCtrl = new AbortController();
    dispatch({
        type: COMPUTATION_FROM_QUERY_RESULT,
        value: [tableId, table!, gridColumnGroups, computeAbortCtrl]
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
    const [tableAggregate, initialColumnGroups] = await computeTableAggregatesDispatched(tableAggregationTask, dispatch);
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
    let [newTable, newDataFrame, updatedColumnGroups] = await computeSystemColumnsDispatched(precomputationTask, dispatch);
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
        await computeColumnAggregatesDispatched(columnAggregationTask, dispatch);
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

export async function computeSystemColumnsDispatched(task: SystemColumnComputationTask, dispatch: Dispatch<ComputationAction>): Promise<[arrow.Table, DataFrame, ColumnGroup[]]> {
    const result = new AsyncValue<[arrow.Table, DataFrame, ColumnGroup[]], LoggableException>();
    const variant: TaskVariant = {
        type: SYSTEM_COLUMN_COMPUTATION_TASK,
        value: task,
        result
    };
    dispatch({
        type: SCHEDULE_TASK,
        value: variant
    });
    return result.getValue();
}

export async function computeSystemColumns(task: SystemColumnComputationTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<[arrow.Table, DataFrame, ColumnGroup[]]> {
    try {
        const [sqlFrame, columnGroups] = buildSystemColumnSQLFrame(task.inputTable.schema, task.columnEntries, task.inputDataFrame.tableName, task.tableAggregate);

        logger.info("Computing system columns", {
            "version": task.tableVersion.toString(),
        }, LOG_CTX);
        const transformStart = performance.now();
        const tableName = generateTableName("__syscols");
        const sql = sqlFrame.toSQL();
        const transformed = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const transformEnd = performance.now();
        const transformedTable = await transformed.readTable();
        logger.info("Computed system columns", {
            "version": task.tableVersion.toString(),
            "duration": Math.floor(transformEnd - transformStart).toString(),
            "sql": sql,
        }, LOG_CTX);

        let rowNumColumnName: string | null = null;
        for (let i = 0; i < columnGroups.length; ++i) {
            const group = columnGroups[i];
            switch (group.type) {
                case ROWNUMBER_COLUMN:
                    rowNumColumnName = group.value.rowNumberFieldName;
                    break;
            }
        }
        if (!rowNumColumnName) {
            throw new LoggableException("Missing rownum column group", {}, LOG_CTX);
        }
        return [transformedTable, transformed, columnGroups];

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException("Failed to precompute column", { "error": stringifyError(error) }, LOG_CTX);
        }
    }
}

function createUniqueColumnName(prefix: string, fieldNames: Set<string>) {
    let name = prefix;
    while (true) {
        if (fieldNames.has(name)) {
            name = `_${name}`;
        } else {
            fieldNames.add(name);
            return name;
        }
    }
}

function buildSystemColumnSQLFrame(schema: arrow.Schema, columns: ColumnGroup[], inputTableName: string, tableAggregate: TableAggregation): [SQLFrame, ColumnGroup[]] {
    let fieldNames = new Set<string>();
    for (const field of schema.fields) {
        fieldNames.add(field.name);
    }

    const rowNumberFieldName = createUniqueColumnName(`_rownum`, fieldNames);
    const rowNumberGridColumn: ColumnGroup = {
        type: ROWNUMBER_COLUMN,
        value: {
            rowNumberFieldName: rowNumberFieldName
        }
    };
    let gridColumns: ColumnGroup[] = [
        rowNumberGridColumn,
        ...columns
    ];

    let frame = SQLFrame.from(inputTableName)
        .rowNumber(rowNumberFieldName);

    for (let i = 1; i <= columns.length; ++i) {
        let column = gridColumns[i];
        switch (column.type) {
            case ROWNUMBER_COLUMN:
            case SKIPPED_COLUMN:
                break;
            case ORDINAL_COLUMN: {
                const binFieldName = createUniqueColumnName(`_${i}_bin`, fieldNames);
                frame = frame.binning({
                    fieldName: column.value.inputFieldName,
                    statsTable: tableAggregate.dataFrame.tableName,
                    statsMinField: column.value.statsFields!.minAggregateFieldName!,
                    statsMaxField: column.value.statsFields!.maxAggregateFieldName!,
                    binCount: column.value.binCount,
                    minBinWidth: isIntegerType(column.value.inputFieldType.typeId) ? 1 : undefined,
                    outputAlias: binFieldName,
                    toNumericFn: getToNumericFn(column.value.inputFieldType.typeId),
                });
                gridColumns[i] = {
                    type: ORDINAL_COLUMN,
                    value: {
                        ...column.value,
                        binFieldName: binFieldName,
                    }
                };
                break;
            }
            case STRING_COLUMN: {
                const valueFieldName = createUniqueColumnName(`_${i}_id`, fieldNames);
                frame = frame.valueIdentifier(column.value.inputFieldName, valueFieldName);
                gridColumns[i] = {
                    type: STRING_COLUMN,
                    value: {
                        ...column.value,
                        valueIdFieldName: valueFieldName
                    }
                };
                break;
            }
            case LIST_COLUMN:
                // No value identifier for LIST columns: a dense_rank() over float32
                // embedding arrays sorts the whole table by full-vector comparison at
                // high cost, and nothing consumes the id (no summary is rendered).
                // Leaving valueIdFieldName null; the layout guards on `!= null`.
                break;
        }
    }

    frame = frame.orderBy([{ field: rowNumberFieldName, ascending: true }]);

    return [frame, gridColumns];
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

export async function sortTableDispatched(task: TableOrderingTask, dispatch: Dispatch<ComputationAction>): Promise<OrderingTable> {
    const result = new AsyncValue<OrderingTable, LoggableException>();
    const variant: TaskVariant = {
        type: TABLE_ORDERING_TASK,
        value: task,
        result
    };
    dispatch({
        type: SCHEDULE_TASK,
        value: variant
    });
    return result.getValue();
}

export async function sortTable(task: TableOrderingTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<OrderingTable> {
    if (task.orderingConstraints.length == 1) {
        logger.info("Sorting table by field", {
            "field": task.orderingConstraints[0].field
        }, LOG_CTX);
    } else {
        logger.info("Sorting table by multiple fields", {}, LOG_CTX);
    }

    try {
        let frame = SQLFrame.from(task.inputDataFrame.tableName);
        if (task.filterTable != null) {
            frame = frame.semiJoinFilter(
                task.rowNumberColumnName,
                task.filterTable.dataFrame.tableName,
                task.filterTable.dataTable.schema.fields[0].name,
            );
        }
        if (task.dataSearchTable != null) {
            frame = frame.semiJoinFilter(
                task.rowNumberColumnName,
                task.dataSearchTable.dataFrame.tableName,
                task.dataSearchTable.dataTable.schema.fields[0].name,
            );
        }
        const sql = frame
            .orderBy(task.orderingConstraints)
            .project([task.rowNumberColumnName])
            .toSQL();

        const sortStart = performance.now();
        const tableName = generateTableName("__ordered");
        const transformed = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const sortEnd = performance.now();
        const orderedTable = await transformed.readTable();
        logger.info("Sorted table", {
            "version": task.tableVersion.toString(),
            "duration": Math.floor(sortEnd - sortStart).toString(),
            "inputRows": task.inputDataTable.numRows.toString(),
            "outputRows": orderedTable.numRows.toString(),
        }, LOG_CTX);
        const out: OrderingTable = {
            inputRowNumberColumnName: task.rowNumberColumnName,
            orderingConstraints: task.orderingConstraints,
            dataTable: orderedTable,
            dataFrame: transformed,
            // Ordering depends on filtered data, so version stays same
            version: task.tableVersion,
            dataSearchRequestId: task.dataSearchTable?.requestId ?? null,
        };
        return out;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException(`Sorting table failed`, { "error": stringifyError(error) }, LOG_CTX);
        }
    }
}

export async function searchDataDispatched(task: DataSearchTask, dispatch: Dispatch<ComputationAction>): Promise<DataSearchTable> {
    const result = new AsyncValue<DataSearchTable, LoggableException>();
    const variant: TaskVariant = {
        type: DATA_SEARCH_TASK,
        value: task,
        result,
    };
    dispatch({ type: SCHEDULE_TASK, value: variant });
    return result.getValue();
}

export async function searchData(
    task: DataSearchTask,
    logger: LoggerLike,
    executeQuery: ComputeQueryExecution = executeDirectly,
): Promise<DataSearchTable> {
    const sql = buildDataSearchSQL(
        task.inputDataFrame.tableName,
        task.rowNumberColumnName,
        task.columns,
        task.pattern,
    );
    try {
        logger.info('Searching table data', {
            version: task.tableVersion.toString(),
            requestId: task.requestId.toString(),
        }, LOG_CTX);
        const tableName = generateTableName('__search');
        const dataFrame = await executeQuery(sql, () => DataFrame.fromSQL(
            task.inputDataFrame.database,
            sql,
            tableName,
            task.abortController.signal,
        ));
        try {
            const dataTable = await dataFrame.readTable(task.abortController.signal);
            return {
                inputRowNumberColumnName: task.rowNumberColumnName,
                dataTable,
                dataFrame,
                version: task.tableVersion,
                requestId: task.requestId,
            };
        } catch (error) {
            await dataFrame.destroy();
            throw error;
        }
    } catch (error) {
        if (error instanceof LoggableException) throw error;
        throw new LoggableException('Failed to search table data', { error: stringifyError(error) }, LOG_CTX);
    }
}

export async function filterTableDispatched(task: TableFilteringTask, dispatch: Dispatch<ComputationAction>): Promise<FilterTable | null> {
    const result = new AsyncValue<FilterTable | null, LoggableException>();
    const variant: TaskVariant = {
        type: TABLE_FILTERING_TASK,
        value: task,
        result
    };
    dispatch({
        type: SCHEDULE_TASK,
        value: variant
    });
    return result.getValue();
}

export async function filterTable(task: TableFilteringTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<FilterTable | null> {
    if (task.filters.length == 0) {
        return null;
    }

    try {
        let frame = SQLFrame.from(task.inputDataFrame.tableName);
        for (const f of task.filters) {
            frame = frame.filter(f.fieldName, f.op, f.value);
        }
        frame = frame.project([task.rowNumberColumnName]);
        const sql = frame.toSQL();

        logger.info("Filtering table", {
            "version": task.tableVersion.toString(),
        }, LOG_CTX);
        const filterStart = performance.now();
        const tableName = generateTableName("__filter");
        const transformed = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const filterEnd = performance.now();
        const filterResultTable = await transformed.readTable();

        logger.info("Filtered table", {
            "version": task.tableVersion.toString(),
            "duration": Math.floor(filterEnd - filterStart).toString(),
            "inputRows": task.inputDataTable.numRows.toString(),
            "outputRows": filterResultTable.numRows.toString(),
            "sql": sql,
        }, LOG_CTX);

        const out: FilterTable = {
            inputRowNumberColumnName: task.rowNumberColumnName,
            dataTable: filterResultTable,
            dataFrame: transformed,
            // Version is already the target - state was incremented when task was scheduled
            version: task.tableVersion,
        };
        return out;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException(`Failed to filter table`, { "error": stringifyError(error) }, LOG_CTX);
        }
    }
}

export async function computeTableAggregatesDispatched(task: TableAggregationTask, dispatch: Dispatch<ComputationAction>): Promise<[TableAggregation, ColumnGroup[]]> {
    const result = new AsyncValue<[TableAggregation, ColumnGroup[]], LoggableException>();
    const variant: TaskVariant = {
        type: TABLE_AGGREGATION_TASK,
        value: task,
        result
    };
    dispatch({
        type: SCHEDULE_TASK,
        value: variant
    });
    return result.getValue();
}

export async function computeTableAggregates(task: TableAggregationTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<[TableAggregation, ColumnGroup[]]> {
    const [sql, columnEntries, countStarColumn] = buildTableAggregationSQL(task);

    try {
        logger.info("Aggregating table", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
        }, LOG_CTX);
        const summaryStart = performance.now();
        const tableName = generateTableName("__tbl_agg");
        const transformedDataFrame = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const summaryEnd = performance.now();
        logger.info("Aggregated table", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "duration": Math.floor(summaryEnd - summaryStart).toString()
        }, LOG_CTX);

        const statsTable = await transformedDataFrame.readTable();
        const statsTableFields = createArrowFieldIndex(statsTable);
        const statsTableFormatter = new ArrowTableFormatter(statsTable.schema, statsTable.batches, logger);

        for (let i = 0; i < columnEntries.length; ++i) {
            const entry = columnEntries[i];
            if (entry.type != ORDINAL_COLUMN || !isIntegerType(entry.value.inputFieldType.typeId)) {
                continue;
            }
            const minValue = statsTable.getChild(entry.value.statsFields!.minAggregateFieldName!)?.get(0);
            const maxValue = statsTable.getChild(entry.value.statsFields!.maxAggregateFieldName!)?.get(0);
            const domainSize = getSmallIntegerDomainSize(minValue, maxValue, entry.value.binCount);
            if (domainSize != null) {
                columnEntries[i] = {
                    type: ORDINAL_COLUMN,
                    value: { ...entry.value, binCount: domainSize },
                };
            }
        }

        const summary: TableAggregation = {
            table: statsTable,
            tableFormatter: statsTableFormatter,
            tableFieldsByName: statsTableFields,
            dataFrame: transformedDataFrame,
            countStarFieldName: countStarColumn,
        };
        return [summary, columnEntries];

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException("computing aggregate failed", {
                "table": task.tableId.toString(),
                "error": stringifyError(error)
            }, LOG_CTX);
        }
    }
}

function buildTableAggregationSQL(task: TableAggregationTask): [string, ColumnGroup[], string] {
    const countColumn = `_count`;
    const aggregates: { fieldName?: string; outputAlias: string; func: "min" | "max" | "count" | "count_star"; distinct?: boolean }[] = [];

    aggregates.push({ outputAlias: `_count`, func: "count_star" });

    const updatedEntries: ColumnGroup[] = [];
    for (let i = 0; i < task.columnEntries.length; ++i) {
        const entry = task.columnEntries[i];
        switch (entry.type) {
            case SKIPPED_COLUMN:
            case ROWNUMBER_COLUMN:
                updatedEntries.push(entry);
                break;
            case ORDINAL_COLUMN: {
                const countAggregateColumn = `_${i}_count`;
                const minAggregateColumn = `_${i}_min`;
                const maxAggregateColumn = `_${i}_max`;
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: countAggregateColumn, func: "count" });
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: minAggregateColumn, func: "min" });
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: maxAggregateColumn, func: "max" });
                updatedEntries.push({
                    type: ORDINAL_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countFieldName: countAggregateColumn,
                            distinctCountFieldName: null,
                            minAggregateFieldName: minAggregateColumn,
                            maxAggregateFieldName: maxAggregateColumn,
                        }
                    }
                });
                break;
            }
            case STRING_COLUMN: {
                const countAggregateColumn = `_${i}_count`;
                const countDistinctAggregateColumn = `_${i}_countd`;
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: countAggregateColumn, func: "count" });
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: countDistinctAggregateColumn, func: "count", distinct: true });
                updatedEntries.push({
                    type: STRING_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countFieldName: countAggregateColumn,
                            distinctCountFieldName: countDistinctAggregateColumn,
                            minAggregateFieldName: null,
                            maxAggregateFieldName: null,
                        }
                    }
                });
                break;
            }
            case LIST_COLUMN:
                // No table-level aggregates for LIST columns. In particular
                // count(DISTINCT array) over float32 embeddings hashes every full
                // vector at high cost, and no summary consumes it. Leaving
                // statsFields null and passing the entry through unchanged.
                updatedEntries.push(entry);
                break;
        }
    }

    const sql = SQLFrame.from(task.inputDataFrame.tableName)
        .groupBy({
            keys: [],
            aggregates,
        })
        .toSQL();
    return [sql, updatedEntries, countColumn];
}

function analyzeOrdinalColumn(tableSummary: TableAggregation, columnEntry: OrdinalGridColumnGroup, binnedValues: BinnedValuesTable, binnedValuesFormatter: ArrowTableFormatter, filteredTotalCount: number | null = null): OrdinalColumnAnalysis {
    const totalCountVector = tableSummary.table.getChild(tableSummary.countStarFieldName!) as arrow.Vector<arrow.Int64>;

    const unfilteredTotalCount = Number(totalCountVector.get(0) ?? BigInt(0));
    const totalCount = filteredTotalCount ?? unfilteredTotalCount;
    const minFieldId = tableSummary.tableFieldsByName.get(columnEntry.statsFields!.minAggregateFieldName!)!;
    const maxFieldId = tableSummary.tableFieldsByName.get(columnEntry.statsFields!.maxAggregateFieldName!)!;
    const minValue = tableSummary.tableFormatter.getValue(0, minFieldId) ?? "";
    const maxValue = tableSummary.tableFormatter.getValue(0, maxFieldId) ?? "";

    assert(binnedValues.schema.fields[0].name == "bin");
    assert(binnedValues.schema.fields[1].name == "count");
    assert(binnedValues.schema.fields[3].name == "binLowerBound");
    const binIdVector = binnedValues.getChildAt(0) as arrow.Vector<arrow.Uint32>;
    const binCountVector = binnedValues.getChildAt(1) as arrow.Vector<arrow.Int64>;

    const nullBinRowIdx = binnedValues.numRows - 1;
    const nullBinId = Number(binIdVector.get(nullBinRowIdx) ?? -1);
    assert(binnedValues.numRows === (columnEntry.binCount + 1));
    assert(nullBinId === columnEntry.binCount);

    const countNull = Number(binCountVector.get(nullBinRowIdx) ?? BigInt(0));
    const countNotNull = filteredTotalCount == null
        ? totalCount - countNull
        : unfilteredTotalCount - countNull;

    const regularBinCount = columnEntry.binCount;
    const binLowerBounds: string[] = [];
    const binPercentages = new Float64Array(regularBinCount);
    const regularBinValueCounts = new BigInt64Array(regularBinCount);

    const isTemporal = isTemporalType(columnEntry.inputFieldType.typeId);
    const temporalFmt = isTemporal ? Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'medium' }) : null;
    const lbCol = isTemporal ? binnedValues.getChildAt(3)! : null;

    for (let i = 0; i < regularBinCount; ++i) {
        const binCount = binCountVector.get(i) ?? BigInt(0);
        let binLB: string;
        if (isTemporal && lbCol) {
            const epochMs = lbCol.get(i);
            binLB = epochMs == null ? "" : temporalFmt!.format(new Date(epochMs));
        } else {
            binLB = binnedValuesFormatter.getValue(i, 3) ?? "";
        }
        const binPercentage = (totalCount == 0) ? 0 : (Number(binCount) / totalCount);
        binLowerBounds.push(binLB);
        binPercentages[i] = binPercentage;
        regularBinValueCounts[i] = binCount;
    }

    return {
        totalCount,
        countNotNull: countNotNull,
        countNull: countNull,
        minValue: minValue,
        maxValue: maxValue,
        binCount: regularBinCount,
        binValueCounts: regularBinValueCounts,
        binPercentages: binPercentages,
        binLowerBounds: binLowerBounds,
    };
}

function analyzeStringColumn(tableSummary: TableAggregation, columnEntry: StringGridColumnGroup, frequentValueTable: FrequentValuesTable, frequentValuesFormatter: ArrowTableFormatter, filteredTotalCount: number | null = null): StringColumnAnalysis {
    const totalCountVector = tableSummary.table.getChild(tableSummary.countStarFieldName!) as arrow.Vector<arrow.Int64>;
    const notNullCountVector = tableSummary.table.getChild(columnEntry.statsFields!.countFieldName) as arrow.Vector<arrow.Int64>;
    const distinctCountVector = tableSummary.table.getChild(columnEntry.statsFields!.distinctCountFieldName!) as arrow.Vector<arrow.Int64>;

    const unfilteredTotalCount = Number(totalCountVector.get(0) ?? BigInt(0));
    const totalCount = filteredTotalCount ?? unfilteredTotalCount;
    const notNullCount = Number(notNullCountVector.get(0) ?? BigInt(0));
    const distinctCount = Number(distinctCountVector.get(0) ?? BigInt(0));

    assert(frequentValueTable.schema.fields[0].name == "key");
    assert(frequentValueTable.getChild("count") != null);

    const frequentValueCounts = frequentValueTable.getChild("count")!.toArray();
    const frequentValuePercentages = new Float64Array(frequentValueTable.numRows);
    const frequentValueStrings = [];
    for (let i = 0; i < frequentValueTable.numRows; ++i) {
        frequentValuePercentages[i] = totalCount == 0 ? 0 : (Number(frequentValueCounts[i]) / totalCount);
        frequentValueStrings.push(frequentValuesFormatter.getValue(i, 0));
    }

    const keyIdColumn = (frequentValueTable as arrow.Table).getChild("keyId");
    if (keyIdColumn == null) {
        throw new Error("Missing keyId column in frequent values table");
    }
    const frequentValueIds = keyIdColumn.toArray() as BigInt64Array;

    return {
        totalCount,
        countNotNull: notNullCount,
        countNull: unfilteredTotalCount - notNullCount,
        countDistinct: distinctCount,
        isUnique: notNullCount == distinctCount,
        frequentValueStrings: frequentValueStrings,
        frequentValueIds: frequentValueIds,
        frequentValueCounts: frequentValueCounts,
        frequentValuePercentages: frequentValuePercentages,
    };
}

export async function computeColumnAggregatesDispatched(task: ColumnAggregationTask, dispatch: Dispatch<ComputationAction>): Promise<ColumnAggregationVariant> {
    const result = new AsyncValue<ColumnAggregationVariant, LoggableException>();
    const variant: TaskVariant = {
        type: COLUMN_AGGREGATION_TASK,
        value: task,
        result
    };
    dispatch({
        type: SCHEDULE_TASK,
        value: variant
    });
    return result.getValue();
}

export async function computeFilteredColumnAggregatesDispatched(task: WithFilter<ColumnAggregationTask>, dispatch: Dispatch<ComputationAction>): Promise<WithFilterEpoch<ColumnAggregationVariant> | null> {
    const result = new AsyncValue<WithFilterEpoch<ColumnAggregationVariant> | null, LoggableException>();
    const variant: TaskVariant = {
        type: FILTERED_COLUMN_AGGREGATION_TASK,
        value: task,
        result
    };
    dispatch({
        type: SCHEDULE_TASK,
        value: variant
    });
    return result.getValue();
}

export async function computeColumnAggregates(task: ColumnAggregationTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<ColumnAggregationVariant> {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.type == ROWNUMBER_COLUMN || task.columnEntry.type == LIST_COLUMN) {
        throw new LoggableException(`Column of type cannot be aggregated`, {
            type: getGridColumnTypeName(task.columnEntry),
        }, LOG_CTX);
    }

    const sql = buildColumnAggregationSQL(task);

    try {
        const transformStart = performance.now();
        const tableName = generateTableName("__col_agg");
        const aggregateDataFrame = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const transformEnd = performance.now();

        const aggregateTable = await aggregateDataFrame.readTable();
        const aggregateTableFormatter = new ArrowTableFormatter(aggregateTable.schema, aggregateTable.batches, logger);
        const readEnd = performance.now();

        let columnAggregate: ColumnAggregationVariant;
        switch (task.columnEntry.type) {
            case ORDINAL_COLUMN: {
                const analysis = analyzeOrdinalColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter);
                columnAggregate = {
                    type: ORDINAL_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        binnedDataFrame: aggregateDataFrame,
                        binnedValues: aggregateTable,
                        binnedValuesFormatter: aggregateTableFormatter,
                        columnAnalysis: analysis,
                    }
                };
                break;
            }
            case STRING_COLUMN: {
                const analysis = analyzeStringColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter);
                columnAggregate = {
                    type: STRING_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        frequentValuesDataFrame: aggregateDataFrame,
                        frequentValuesTable: aggregateTable,
                        frequentValuesFormatter: aggregateTableFormatter,
                        analysis,
                    }
                };
                break;
            }
        }
        const analysisEnd = performance.now();
        logger.info("Aggregated table column", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "columnIndex": task.columnId.toString(),
            "columnName": task.columnEntry.value.inputFieldName,
            "groupType": getGridColumnTypeName(task.columnEntry),
            "duration": Math.floor(analysisEnd - transformStart).toString(),
            "queryDuration": Math.floor(transformEnd - transformStart).toString(),
            "readDuration": Math.floor(readEnd - transformEnd).toString(),
            "analysisDuration": Math.floor(analysisEnd - readEnd).toString(),
            "resultRows": aggregateTable.numRows.toString(),
            "sql": sql,
        }, LOG_CTX);
        return columnAggregate;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            const exception = new LoggableException("Computing column aggregate failed", {
                "table": task.tableId.toString(),
                "error": stringifyError(error),
            }, LOG_CTX);
            logger.warn(exception.message, exception.keyValues, exception.target);
            throw exception;
        }
    }
}

export const BIN_COUNT = 16;

function buildColumnAggregationSQL(task: ColumnAggregationTask, filtered: WithFilter<ColumnAggregationTask> | null = null): string {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.type == ROWNUMBER_COLUMN || task.columnEntry.value.statsFields == null) {
        throw new Error("Column summary requires precomputed table summary");
    }

    let frame = SQLFrame.from(task.inputDataFrame.tableName);

    if (filtered != null) {
        if (filtered.filterTable != null) {
            frame = frame.semiJoinFilter(
                filtered.filterTable.inputRowNumberColumnName,
                filtered.filterTable.dataFrame.tableName,
                filtered.filterTable.dataTable.schema.fields[0].name,
            );
        }
        if (filtered.dataSearchTable != null) {
            frame = frame.semiJoinFilter(
                filtered.dataSearchTable.inputRowNumberColumnName,
                filtered.dataSearchTable.dataFrame.tableName,
                filtered.dataSearchTable.dataTable.schema.fields[0].name,
            );
        }
    }

    const targetFieldName = task.columnEntry.value.inputFieldName;

    switch (task.columnEntry.type) {
        case ORDINAL_COLUMN: {
            const minField = task.columnEntry.value.statsFields.minAggregateFieldName!;
            const maxField = task.columnEntry.value.statsFields.maxAggregateFieldName!;
            frame = frame.groupBy({
                keys: [{
                    fieldName: targetFieldName,
                    outputAlias: "bin",
                    binning: {
                        preBinnedFieldName: task.columnEntry.value.binFieldName ?? undefined,
                        statsTable: task.tableAggregate.dataFrame.tableName,
                        statsMinField: minField,
                        statsMaxField: maxField,
                        binCount: task.columnEntry.value.binCount,
                        minBinWidth: isIntegerType(task.columnEntry.value.inputFieldType.typeId) ? 1 : undefined,
                        outputBinWidthAlias: "binWidth",
                        outputBinLbAlias: "binLowerBound",
                        outputBinUbAlias: "binUpperBound",
                        includeNullBin: true,
                        toNumericFn: getToNumericFn(task.columnEntry.value.inputFieldType.typeId),
                    }
                }],
                aggregates: [{
                    func: "count_star",
                    outputAlias: "count",
                }]
            }).orderBy([{ field: "bin", ascending: true }]);
            break;
        }
        case STRING_COLUMN: {
            if (task.columnEntry.value.valueIdFieldName == null) {
                throw new Error("Cannot aggregate string column without precomputed value id");
            }
            frame = frame.groupBy({
                keys: [
                    { fieldName: targetFieldName, outputAlias: "key" },
                    { fieldName: task.columnEntry.value.valueIdFieldName, outputAlias: "keyId" },
                ],
                aggregates: [{
                    func: "count_star",
                    outputAlias: "count",
                }]
            }).orderBy([{ field: "count", ascending: false }], 32);
            break;
        }
    }

    return frame.toSQL();
}

export async function computeFilteredColumnAggregates(task: WithFilter<ColumnAggregationTask>, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<WithFilterEpoch<ColumnAggregationVariant> | null> {
    if (task.columnEntry.type == SKIPPED_COLUMN || task.columnEntry.type == ROWNUMBER_COLUMN || task.columnEntry.type == LIST_COLUMN) {
        throw new LoggableException(`Column of type cannot be aggregated`, {
            type: getGridColumnTypeName(task.columnEntry),
        }, LOG_CTX);
    }

    const sql = buildColumnAggregationSQL(task, task);

    try {
        logger.info("Aggregating filtered table column", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "columnIndex": task.columnId.toString(),
            "columnName": task.columnEntry.value.inputFieldName,
            "groupType": getGridColumnTypeName(task.columnEntry),
        }, LOG_CTX);
        const transformStart = performance.now();
        const tableName = generateTableName("__filt_col_agg");
        const aggregateDataFrame = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const transformEnd = performance.now();
        logger.info("Aggregated filtered table column", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "columnIndex": task.columnId.toString(),
            "columnName": task.columnEntry.value.inputFieldName,
            "groupType": getGridColumnTypeName(task.columnEntry),
            "duration": Math.floor(transformEnd - transformStart).toString(),
            "sql": sql
        }, LOG_CTX);

        const aggregateTable = await aggregateDataFrame.readTable();
        const aggregateTableFormatter = new ArrowTableFormatter(aggregateTable.schema, aggregateTable.batches, logger);

        let columnAggregate: WithFilterEpoch<ColumnAggregationVariant>;
        switch (task.columnEntry.type) {
            case ORDINAL_COLUMN: {
                const analysis = analyzeOrdinalColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter, task.selectionRowCount);
                columnAggregate = {
                    type: ORDINAL_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        binnedDataFrame: aggregateDataFrame,
                        binnedValues: aggregateTable,
                        binnedValuesFormatter: aggregateTableFormatter,
                        columnAnalysis: analysis,
                    },
                    filterVersion: task.tableVersion.clone(),
                    dataSearchRequestId: task.dataSearchTable?.requestId ?? null,
                };
                break;
            }
            case STRING_COLUMN: {
                const analysis = analyzeStringColumn(task.tableAggregate, task.columnEntry.value, aggregateTable, aggregateTableFormatter, task.selectionRowCount);
                columnAggregate = {
                    type: STRING_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        frequentValuesDataFrame: aggregateDataFrame,
                        frequentValuesTable: aggregateTable,
                        frequentValuesFormatter: aggregateTableFormatter,
                        analysis,
                    },
                    filterVersion: task.tableVersion.clone(),
                    dataSearchRequestId: task.dataSearchTable?.requestId ?? null,
                };
                break;
            }
        }
        return columnAggregate;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            const exception = new LoggableException("Failed to compute filtered column aggregate", {
                "table": task.tableId.toString(),
                "columnIndex": task.columnId.toString(),
                "columnName": task.columnEntry.value.inputFieldName,
                "error": stringifyError(error),
            }, LOG_CTX);
            logger.warn(exception.message, exception.keyValues, exception.target);
            throw exception;
        }
    }
}
