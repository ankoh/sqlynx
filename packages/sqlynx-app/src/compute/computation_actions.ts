import * as arrow from 'apache-arrow';

import { Dispatch } from '../utils/variant.js';
import { Logger } from '../platform/logger.js';
import { COLUMN_SUMMARY_TASK_FAILED, COLUMN_SUMMARY_TASK_RUNNING, COLUMN_SUMMARY_TASK_SUCCEEDED, COMPUTATION_FROM_QUERY_RESULT, ComputationAction, CREATED_DATA_FRAME, TABLE_ORDERING_TASK_FAILED, TABLE_ORDERING_TASK_RUNNING, TABLE_ORDERING_TASK_SUCCEEDED, TABLE_SUMMARY_TASK_FAILED, TABLE_SUMMARY_TASK_RUNNING, TABLE_SUMMARY_TASK_SUCCEEDED } from './computation_state.js';
import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskProgress, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, createOrderByTransform, createTableSummaryTransform, createColumnSummaryTransform, ColumnEntryVariant, SKIPPED_COLUMN, getColumnEntryTypeScript } from './table_transforms.js';
import { AsyncDataFrame, ComputeWorkerBindings } from './compute_worker_bindings.js';

const LOG_CTX = "compute";

/// Compute all table summaries
export async function analyzeTable(computationId: number, table: arrow.Table, dispatch: Dispatch<ComputationAction>, worker: ComputeWorkerBindings, logger: Logger): Promise<void> {
    // Register the table with compute
    const mappedColumns = mapComputationColumnsEntries(table!);
    const computeAbortCtrl = new AbortController();
    dispatch({
        type: COMPUTATION_FROM_QUERY_RESULT,
        value: [computationId, table!, mappedColumns, computeAbortCtrl]
    });

    // Create a Data Frame from a table
    const dataFrame = await worker.createDataFrameFromTable(table);
    dispatch({
        type: CREATED_DATA_FRAME,
        value: [computationId, dataFrame]
    });

    // Summarize the table
    const tableSummaryTask: TableSummaryTask = {
        computationId,
        columnEntries: mappedColumns,
    };
    const tableSummary = await summarizeTable(computationId, dataFrame, tableSummaryTask, dispatch, logger);

    // Summarize the columns
    for (let columnId = 0; columnId < tableSummary.columnEntries.length; ++columnId) {
        const columnSummaryTask: ColumnSummaryTask = {
            computationId,
            columnId,
            columnEntry: tableSummary.columnEntries[columnId]
        };
        await summarizeColumn(computationId, dataFrame, columnSummaryTask, tableSummary, dispatch, logger);
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
                        binningFields: null,
                        statsFields: null
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
                        binningFields: null,
                        statsFields: null
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
                        binningFields: null,
                        statsFields: null
                    }
                });
                break;
            default:
                tableColumns.push({
                    type: SKIPPED_COLUMN,
                    value: {
                        inputFieldId: i,
                        inputFieldName: field.name,
                    }
                });
                break;
        }
    }
    return tableColumns;
}

/// Helper to sort a table
export async function sortTable(computationId: number, dataFrame: AsyncDataFrame, task: TableOrderingTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
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
        const transformed = await dataFrame!.transform(transform);
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
export async function summarizeTable(computationId: number, dataFrame: AsyncDataFrame, task: TableSummaryTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<TableSummary> {
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
            value: [computationId, taskProgress]
        });
        // Order the data frame
        const summaryStart = performance.now();
        const transformedDataFrame = await dataFrame!.transform(transform);
        const summaryEnd = performance.now();
        logger.info(`summarized table ${computationId} in ${Math.floor(summaryEnd - summaryStart)} ms`, LOG_CTX);
        // Read the result
        const transformedTable = await transformedDataFrame.readTable();
        // The output table
        const summary: TableSummary = {
            columnEntries,
            transformedTable,
            transformedDataFrame,
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
            value: [computationId, taskProgress, summary],
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
            type: TABLE_SUMMARY_TASK_FAILED,
            value: [computationId, taskProgress, error],
        });
        throw error;
    }
}

export async function summarizeColumn(computationId: number, dataFrame: AsyncDataFrame, task: ColumnSummaryTask, tableSummary: TableSummary, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<ColumnSummaryVariant> {
    // Create the transform
    const transform = createColumnSummaryTransform(task, tableSummary);

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
        const transformedDataFrame = await dataFrame!.transform(transform, tableSummary.transformedDataFrame);
        const summaryEnd = performance.now();
        logger.info(`summarized table ${task.computationId} column ${task.columnId} (${getColumnEntryTypeScript(task.columnEntry)}) in ${Math.floor(summaryEnd - summaryStart)} ms`, LOG_CTX);
        // Read the result
        const transformedTable = await transformedDataFrame.readTable();
        // Delete the data frame after reordering
        transformedDataFrame.delete();
        // Create the summary variant
        let summary: ColumnSummaryVariant;
        switch (task.columnEntry.type) {
            case ORDINAL_COLUMN:
                summary = {
                    type: ORDINAL_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        binnedValues: transformedTable,
                    }
                };
                break;
            case STRING_COLUMN:
                summary = {
                    type: STRING_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        frequentValues: transformedTable,
                    }
                };
                break;
            case LIST_COLUMN:
                summary = {
                    type: LIST_COLUMN,
                    value: {
                        columnEntry: task.columnEntry.value,
                        binnedLengths: transformedTable,
                    }
                };
                break;
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

