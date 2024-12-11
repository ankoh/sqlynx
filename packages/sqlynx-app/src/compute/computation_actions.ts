import * as arrow from 'apache-arrow';

import { Dispatch } from '../utils/variant.js';
import { Logger } from '../platform/logger.js';
import { COLUMN_SUMMARY_TASK_FAILED, COLUMN_SUMMARY_TASK_RUNNING, COLUMN_SUMMARY_TASK_SUCCEEDED, COMPUTATION_FROM_QUERY_RESULT, ComputationAction, CREATED_DATA_FRAME, PRECOMPUTATION_TASK_FAILED, PRECOMPUTATION_TASK_RUNNING, PRECOMPUTATION_TASK_SUCCEEDED, TABLE_ORDERING_TASK_FAILED, TABLE_ORDERING_TASK_RUNNING, TABLE_ORDERING_TASK_SUCCEEDED, TABLE_SUMMARY_TASK_FAILED, TABLE_SUMMARY_TASK_RUNNING, TABLE_SUMMARY_TASK_SUCCEEDED } from './computation_state.js';
import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskProgress, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, createOrderByTransform, createTableSummaryTransform, createColumnSummaryTransform, ColumnEntryVariant, SKIPPED_COLUMN, OrdinalColumnAnalysis, StringColumnAnalysis, ListColumnAnalysis, ListColumnEntry, StringColumnEntry, OrdinalColumnEntry, BinnedValuesTable, FrequentValuesTable, createPrecomputationTransform, ColumnPrecomputationTask, BIN_COUNT } from './table_transforms.js';
import { AsyncDataFrame, ComputeWorkerBindings } from './compute_worker_bindings.js';
import { ArrowTableFormatter } from '../view/query_result/arrow_formatter.js';
import { assert } from '../utils/assert.js';

const LOG_CTX = "compute";

/// Compute all table summaries
export async function analyzeTable(computationId: number, table: arrow.Table, dispatch: Dispatch<ComputationAction>, worker: ComputeWorkerBindings, logger: Logger): Promise<void> {
    // Register the table with compute
    let columns = mapComputationColumnsEntries(table!);
    const computeAbortCtrl = new AbortController();
    dispatch({
        type: COMPUTATION_FROM_QUERY_RESULT,
        value: [computationId, table!, columns, computeAbortCtrl]
    });

    // Create a Data Frame from a table
    let dataFrame = await worker.createDataFrameFromTable(table);
    dispatch({
        type: CREATED_DATA_FRAME,
        value: [computationId, dataFrame]
    });

    // Summarize the table
    const tableSummaryTask: TableSummaryTask = {
        computationId,
        columnEntries: columns,
        inputDataFrame: dataFrame
    };
    const [tableSummary, columnEntries] = await computeTableSummary(tableSummaryTask, dispatch, logger);
    columns = columnEntries;

    // Precompute column expressions
    const precomputationTask: ColumnPrecomputationTask = {
        computationId,
        columnEntries: columns,
        inputTable: table,
        inputDataFrame: dataFrame,
        tableSummary
    };
    const [newDataFrame, newColumnEntries] = await precomputeSystemColumnExpressions(precomputationTask, dispatch, logger);
    columns = newColumnEntries;

    // Summarize the columns
    for (let columnId = 0; columnId < columnEntries.length; ++columnId) {
        const columnSummaryTask: ColumnSummaryTask = {
            computationId,
            columnId,
            tableSummary: tableSummary,
            columnEntry: newColumnEntries[columnId],
            inputDataFrame: newDataFrame,
        };
        await computeColumnSummary(computationId, columnSummaryTask, dispatch, logger);
    }
}

/// Precompute expressions for column summaries
async function precomputeSystemColumnExpressions(task: ColumnPrecomputationTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<[AsyncDataFrame, ColumnEntryVariant[]]> {
    let startedAt = new Date();
    let taskProgress: TaskProgress = {
        status: TaskStatus.TASK_RUNNING,
        startedAt,
        completedAt: null,
        failedAt: null,
        failedWithError: null,
    };
    try {
        dispatch({
            type: PRECOMPUTATION_TASK_RUNNING,
            value: [task.computationId, taskProgress]
        });
        const [transform, newColumns] = createPrecomputationTransform(task.inputTable.schema, task.columnEntries, task.tableSummary.statsTable);

        const transformStart = performance.now();
        const transformed = await task.inputDataFrame.transform(transform, task.tableSummary.statsDataFrame);
        const transformEnd = performance.now();
        const transformedTable = await transformed.readTable();
        logger.info(`precomputed system columns in ${Math.floor(transformEnd - transformStart)} ms`, LOG_CTX);

        dispatch({
            type: PRECOMPUTATION_TASK_SUCCEEDED,
            value: [task.computationId, taskProgress, transformedTable, transformed, newColumns],
        });
        return [transformed, newColumns];
    } catch (error: any) {
        logger.error(`column precomputation failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: PRECOMPUTATION_TASK_FAILED,
            value: [task.computationId, taskProgress, error],
        });
        throw error;
    }
}

/// Helper to derive column entry variants from an arrow table
function mapComputationColumnsEntries(table: arrow.Table): ColumnEntryVariant[] {
    const tableColumns: ColumnEntryVariant[] = [];
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
                tableColumns.push({
                    type: ORDINAL_COLUMN,
                    value: {
                        inputFieldId: i,
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                        binningFields: null,
                        statsFields: null,
                        binCount: BIN_COUNT
                    }
                });
                break;
            case arrow.Type.Utf8:
            case arrow.Type.LargeUtf8:
                tableColumns.push({
                    type: STRING_COLUMN,
                    value: {
                        inputFieldId: i,
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                        statsFields: null,
                    }
                });
                break;
            case arrow.Type.List:
            case arrow.Type.FixedSizeList:
                tableColumns.push({
                    type: LIST_COLUMN,
                    value: {
                        inputFieldId: i,
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                        statsFields: null,
                    }
                });
                break;
            default:
                tableColumns.push({
                    type: SKIPPED_COLUMN,
                    value: {
                        inputFieldId: i,
                        inputFieldName: field.name,
                        inputFieldType: field.type,
                        inputFieldNullable: field.nullable,
                    }
                });
                break;
        }
    }
    return tableColumns;
}

/// Helper to sort a table
export async function sortTable(task: TableOrderingTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
    // Create the transform
    const transform = createOrderByTransform(task.orderingConstraints);

    // Mark task as running
    let startedAt = new Date();
    let taskProgress: TaskProgress = {
        status: TaskStatus.TASK_RUNNING,
        startedAt,
        completedAt: null,
        failedAt: null,
        failedWithError: null,
    };

    if (task.orderingConstraints.length == 1) {
        logger.info(`sorting table by field "${task.orderingConstraints[0].fieldName}"`, LOG_CTX);
    } else {
        logger.info(`sorting table by multiple fields`, LOG_CTX);
    }

    try {
        dispatch({
            type: TABLE_ORDERING_TASK_RUNNING,
            value: [task.computationId, taskProgress]
        });
        // Order the data frame
        const sortStart = performance.now();
        const transformed = await task.inputDataFrame!.transform(transform);
        const sortEnd = performance.now();
        logger.info(`sorted table in ${Math.floor(sortEnd - sortStart)} ms`, LOG_CTX);
        // Read the result
        const orderedTable = await transformed.readTable();

        // The output table
        const out: OrderedTable = {
            orderingConstraints: task.orderingConstraints,
            dataTable: orderedTable,
            dataFrame: transformed,
        };
        // Mark the task as running
        taskProgress = {
            status: TaskStatus.TASK_SUCCEEDED,
            startedAt,
            completedAt: new Date(),
            failedAt: null,
            failedWithError: null,
        };
        dispatch({
            type: TABLE_ORDERING_TASK_SUCCEEDED,
            value: [task.computationId, taskProgress, out],
        });

    } catch (error: any) {
        logger.error(`sorting table failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: TABLE_ORDERING_TASK_FAILED,
            value: [task.computationId, taskProgress, error],
        });
    }
}

/// Helper to summarize a table
export async function computeTableSummary(task: TableSummaryTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<[TableSummary, ColumnEntryVariant[]]> {
    // Create the transform
    const [transform, columnEntries, countStarColumn] = createTableSummaryTransform(task);

    // Mark task as running
    let startedAt = new Date();
    let taskProgress: TaskProgress = {
        status: TaskStatus.TASK_RUNNING,
        startedAt,
        completedAt: null,
        failedAt: null,
        failedWithError: null,
    }

    try {
        dispatch({
            type: TABLE_SUMMARY_TASK_RUNNING,
            value: [task.computationId, taskProgress]
        });
        // Order the data frame
        const summaryStart = performance.now();
        const transformedDataFrame = await task.inputDataFrame!.transform(transform);
        const summaryEnd = performance.now();
        logger.info(`aggregated table ${task.computationId} in ${Math.floor(summaryEnd - summaryStart)} ms`, LOG_CTX);
        // Read the result
        const statsTable = await transformedDataFrame.readTable();
        const statsTableFormatter = new ArrowTableFormatter(statsTable.schema, statsTable.batches);
        // The output table
        const summary: TableSummary = {
            statsTable,
            statsTableFormatter,
            statsDataFrame: transformedDataFrame,
            statsCountStarField: countStarColumn,
        };
        // Mark the task as succeeded
        taskProgress = {
            status: TaskStatus.TASK_SUCCEEDED,
            startedAt,
            completedAt: new Date(),
            failedAt: null,
            failedWithError: null,
        };
        dispatch({
            type: TABLE_SUMMARY_TASK_SUCCEEDED,
            value: [task.computationId, taskProgress, summary],
        });
        return [summary, columnEntries];

    } catch (error: any) {
        logger.error(`ordering table ${task.computationId} failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: TABLE_SUMMARY_TASK_FAILED,
            value: [task.computationId, taskProgress, error],
        });
        throw error;
    }
}

function analyzeOrdinalColumn(tableSummary: TableSummary, columnEntry: OrdinalColumnEntry, binnedValues: BinnedValuesTable, binnedValuesFormatter: ArrowTableFormatter): OrdinalColumnAnalysis {
    const totalCountVector = tableSummary.statsTable.getChildAt(tableSummary.statsCountStarField!) as arrow.Vector<arrow.Int64>;
    const notNullCountVector = tableSummary.statsTable.getChildAt(columnEntry.statsFields!.countField) as arrow.Vector<arrow.Int64>;

    const totalCount = Number(totalCountVector.get(0) ?? BigInt(0));
    const notNullCount = Number(notNullCountVector.get(0) ?? BigInt(0));
    const minValue = tableSummary.statsTableFormatter.getValue(0, columnEntry.statsFields!.minAggregateField) ?? "";
    const maxValue = tableSummary.statsTableFormatter.getValue(0, columnEntry.statsFields!.maxAggregateField) ?? "";

    assert(binnedValues.schema.fields[1].name == "count");
    assert(binnedValues.schema.fields[3].name == "binLowerBound");
    const binCountVector = binnedValues.getChildAt(1) as arrow.Vector<arrow.Int64>;
    const binLowerBounds: string[] = [];
    const binPercentages = new Float64Array(binnedValues.numRows);
    for (let i = 0; i < binnedValues.numRows; ++i) {
        const binCount = binCountVector.get(i) ?? BigInt(0);
        const binLB = binnedValuesFormatter.getValue(i, 3) ?? "";
        const binPercentage = (totalCount == 0) ? 0 : (Number(binCount) / totalCount);
        binLowerBounds.push(binLB);
        binPercentages[i] = binPercentage;
    }
    return {
        countNotNull: notNullCount,
        countNull: totalCount - notNullCount,
        minValue: minValue,
        maxValue: maxValue,
        binCount: binnedValues.numRows,
        binValueCounts: binCountVector.toArray(),
        binPercentages: binPercentages,
        binLowerBounds: binLowerBounds,
    };
}

function analyzeStringColumn(tableSummary: TableSummary, columnEntry: StringColumnEntry, frequentValueTable: FrequentValuesTable): StringColumnAnalysis {
    const totalCountVector = tableSummary.statsTable.getChildAt(tableSummary.statsCountStarField!) as arrow.Vector<arrow.Int64>;
    const notNullCountVector = tableSummary.statsTable.getChildAt(columnEntry.statsFields!.countField) as arrow.Vector<arrow.Int64>;
    const distinctCountVector = tableSummary.statsTable.getChildAt(columnEntry.statsFields!.distinctCountField!) as arrow.Vector<arrow.Int64>;

    const totalCount = Number(totalCountVector.get(0) ?? BigInt(0));
    const notNullCount = Number(notNullCountVector.get(0) ?? BigInt(0));
    const distinctCount = Number(distinctCountVector.get(0) ?? BigInt(0));
    const minValue = tableSummary.statsTableFormatter.getValue(0, columnEntry.statsFields!.minAggregateField) ?? "";
    const maxValue = tableSummary.statsTableFormatter.getValue(0, columnEntry.statsFields!.maxAggregateField) ?? "";

    assert(frequentValueTable.schema.fields[0].name == "key");
    assert(frequentValueTable.schema.fields[1].name == "count");

    const frequentValueIsNull = new Uint8Array(frequentValueTable.numRows);
    const frequentValueKeys = frequentValueTable.getChild("key")!;
    const frequentValueCounts = frequentValueTable.getChild("count")!.toArray();
    const frequentValuePercentages = new Float64Array(frequentValueTable.numRows);
    for (let i = 0; i < frequentValueTable.numRows; ++i) {
        frequentValuePercentages[i] = totalCount == 0 ? 0 : (Number(frequentValueCounts[i]) / totalCount);
        if (frequentValueKeys.nullable) {
            for (let i = 0; i < frequentValueTable.numRows; ++i) {
                frequentValueIsNull[i] = frequentValueKeys.isValid(i) ? 0 : 1;
            }
        }
    }

    return {
        countNotNull: notNullCount,
        countNull: totalCount - notNullCount,
        countDistinct: distinctCount,
        minValue: minValue,
        maxValue: maxValue,
        isUnique: notNullCount == distinctCount,
        frequentValueIsNull: frequentValueIsNull,
        frequentValueCounts: frequentValueCounts,
        frequentValuePercentages: frequentValuePercentages,
    };
}

function analyzeListColumn(tableSummary: TableSummary, columnEntry: ListColumnEntry, frequentValueTable: FrequentValuesTable): ListColumnAnalysis {
    const totalCountVector = tableSummary.statsTable.getChildAt(tableSummary.statsCountStarField!) as arrow.Vector<arrow.Int64>;
    const notNullCountVector = tableSummary.statsTable.getChildAt(columnEntry.statsFields!.countField) as arrow.Vector<arrow.Int64>;
    const distinctCountVector = tableSummary.statsTable.getChildAt(columnEntry.statsFields!.distinctCountField!) as arrow.Vector<arrow.Int64>;

    const totalCount = Number(totalCountVector.get(0) ?? BigInt(0));
    const notNullCount = Number(notNullCountVector.get(0) ?? BigInt(0));
    const distinctCount = Number(distinctCountVector.get(0) ?? BigInt(0));
    const minValue = tableSummary.statsTableFormatter.getValue(0, columnEntry.statsFields!.minAggregateField) ?? "";
    const maxValue = tableSummary.statsTableFormatter.getValue(0, columnEntry.statsFields!.maxAggregateField) ?? "";

    assert(frequentValueTable.schema.fields[0].name == "key");
    assert(frequentValueTable.schema.fields[1].name == "count");

    const frequentValueIsNull = new Uint8Array(frequentValueTable.numRows);
    const frequentValueKeys = frequentValueTable.getChild("key")!;
    const frequentValueCounts = frequentValueTable.getChild("count")!.toArray();
    const frequentValuePercentages = new Float64Array(frequentValueTable.numRows);
    for (let i = 0; i < frequentValueTable.numRows; ++i) {
        frequentValuePercentages[i] = totalCount == 0 ? 0 : (Number(frequentValueCounts[i]) / totalCount);
        if (frequentValueKeys.nullable) {
            for (let i = 0; i < frequentValueTable.numRows; ++i) {
                frequentValueIsNull[i] = frequentValueKeys.isValid(i) ? 0 : 1;
            }
        }
    }

    return {
        countNotNull: Number(notNullCount),
        countNull: Number(totalCount - notNullCount),
        countDistinct: Number(distinctCount),
        minValue: minValue,
        maxValue: maxValue,
        isUnique: notNullCount == distinctCount,
        frequentValueIsNull: frequentValueIsNull,
        frequentValueCounts: frequentValueCounts,
        frequentValuePercentages: frequentValuePercentages,
    };
}

export async function computeColumnSummary(computationId: number, task: ColumnSummaryTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<ColumnSummaryVariant> {
    // Create the transform
    const columnSummaryTransform = createColumnSummaryTransform(task);

    // Mark task as running
    let startedAt = new Date();
    let taskProgress: TaskProgress = {
        status: TaskStatus.TASK_RUNNING,
        startedAt,
        completedAt: null,
        failedAt: null,
        failedWithError: null,
    }

    try {
        dispatch({
            type: COLUMN_SUMMARY_TASK_RUNNING,
            value: [task.computationId, task.columnId, taskProgress]
        });
        // Order the data frame
        const summaryStart = performance.now();
        const columnSummaryDataFrame = await task.inputDataFrame!.transform(columnSummaryTransform, task.tableSummary.statsDataFrame);
        const summaryEnd = performance.now();
        logger.info(`aggregated table ${task.computationId} column ${task.columnId} in ${Math.floor(summaryEnd - summaryStart)} ms`, LOG_CTX);
        // Read the result
        const columnSummaryTable = await columnSummaryDataFrame.readTable();
        const columnSummaryTableFormatter = new ArrowTableFormatter(columnSummaryTable.schema, columnSummaryTable.batches);
        // Delete the data frame after reordering
        columnSummaryDataFrame.delete();
        // Create the summary variant
        let summary: ColumnSummaryVariant;
        switch (task.columnEntry.type) {
            case ORDINAL_COLUMN: {
                const analysis = analyzeOrdinalColumn(task.tableSummary, task.columnEntry.value, columnSummaryTable, columnSummaryTableFormatter);
                summary = {
                    type: ORDINAL_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        binnedValues: columnSummaryTable,
                        binnedValuesFormatter: columnSummaryTableFormatter,
                        analysis,
                    }
                };
                break;
            }
            case STRING_COLUMN: {
                const analysis = analyzeStringColumn(task.tableSummary, task.columnEntry.value, columnSummaryTable);
                summary = {
                    type: STRING_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        frequentValues: columnSummaryTable,
                        frequentValuesFormatter: columnSummaryTableFormatter,
                        analysis,
                    }
                };
                break;
            }
            case LIST_COLUMN: {
                const analysis = analyzeListColumn(task.tableSummary, task.columnEntry.value, columnSummaryTable);
                summary = {
                    type: LIST_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        frequentValues: columnSummaryTable,
                        frequentValuesFormatter: columnSummaryTableFormatter,
                        analysis,
                    }
                };
                break;
            }
            case SKIPPED_COLUMN:
                summary = {
                    type: SKIPPED_COLUMN,
                    value: null
                };
                break;
        }
        // Mark the task as succeeded
        taskProgress = {
            status: TaskStatus.TASK_SUCCEEDED,
            startedAt,
            completedAt: new Date(),
            failedAt: null,
            failedWithError: null,
        };
        dispatch({
            type: COLUMN_SUMMARY_TASK_SUCCEEDED,
            value: [task.computationId, task.columnId, taskProgress, summary],
        });

        return summary;

    } catch (error: any) {
        logger.error(`ordering table ${computationId} failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: COLUMN_SUMMARY_TASK_FAILED,
            value: [task.computationId, task.columnId, taskProgress, error],
        });

        throw error;
    }
}

