import * as arrow from 'apache-arrow';

import { Dispatch } from '../utils/variant.js';
import { Logger } from '../platform/logger.js';
import { COLUMN_SUMMARY_TASK_FAILED, COLUMN_SUMMARY_TASK_RUNNING, COLUMN_SUMMARY_TASK_SUCCEEDED, ComputationAction, TABLE_ORDERING_TASK_FAILED, TABLE_ORDERING_TASK_RUNNING, TABLE_ORDERING_TASK_SUCCEEDED, TABLE_SUMMARY_TASK_FAILED, TABLE_SUMMARY_TASK_RUNNING, TABLE_SUMMARY_TASK_SUCCEEDED, TableComputationState } from './computation_state.js';
import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskProgress, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, createOrderByTransform, createTableSummaryTransform, createColumnSummaryTransform, ColumnEntryVariant, SKIPPED_COLUMN } from './table_transforms.js';

const LOG_CTX = "computation_actions";

/// Helper to derive column entry variants from an arrow table
export function mapComputationColumnsEntries(table: arrow.Table): ColumnEntryVariant[] {
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
export async function sortTable(tableState: TableComputationState, task: TableOrderingTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
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
    }

    try {
        dispatch({
            type: TABLE_ORDERING_TASK_RUNNING,
            value: [task.tableId, taskProgress]
        });
        // Order the data frame
        const transformed = await tableState.dataFrame!.transform(transform);
        logger.info(`sorting table ${task.tableId} succeded, scanning result`, LOG_CTX);
        // Read the result
        const orderedTable = await transformed.readTable();
        logger.info(`scanning sorted table ${task.tableId} suceeded`, LOG_CTX);
        // Delete the data frame after reordering
        await transformed.delete();
        // The output table
        const out: OrderedTable = {
            orderingConstraints: task.orderingConstraints,
            orderedTable,
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
            value: [task.tableId, taskProgress, out],
        });

    } catch (error: any) {
        logger.error(`ordering table ${task.tableId} failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: TABLE_ORDERING_TASK_FAILED,
            value: [task.tableId, taskProgress, error],
        });
    }
}

/// Helper to summarize a table
export async function summarizeTable(tableState: TableComputationState, task: TableSummaryTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
    // Create the transform
    const [transform, columnEntries] = createTableSummaryTransform(task);

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
            value: [tableState.computationId, taskProgress]
        });
        // Order the data frame
        const transformedDataFrame = await tableState.dataFrame!.transform(transform);
        logger.info(`summarizing table ${tableState.computationId} succeded, scanning result`, LOG_CTX);
        // Read the result
        const transformedTable = await transformedDataFrame.readTable();
        logger.info(`scanning summary for table ${tableState.computationId} suceeded`, LOG_CTX);
        // The output table
        const summary: TableSummary = {
            columnEntries,
            transformedTable,
            transformedDataFrame,
            statsCountStarField: task.statsCountStarField
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
            value: [tableState.computationId, taskProgress, summary],
        });

    } catch (error: any) {
        logger.error(`ordering table ${tableState.computationId} failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: TABLE_SUMMARY_TASK_FAILED,
            value: [tableState.computationId, taskProgress, error],
        });
    }
}

export async function summarizeColumn(tableState: TableComputationState, task: ColumnSummaryTask, tableSummary: TableSummary, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
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
            value: [task.tableId, task.columnId, taskProgress]
        });
        // Order the data frame
        const transformedDataFrame = await tableState.dataFrame!.transform(transform);
        logger.info(`summarizing column ${task.tableId} succeded, scanning result`, LOG_CTX);
        // Read the result
        const transformedTable = await transformedDataFrame.readTable();
        logger.info(`scanning summary for column ${task.tableId}[${task.columnId}] suceeded`, LOG_CTX);
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
            value: [task.tableId, task.columnId, taskProgress, summary],
        });


    } catch (error: any) {
        logger.error(`ordering table ${tableState.computationId} failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: COLUMN_SUMMARY_TASK_FAILED,
            value: [task.tableId, task.columnId, taskProgress, error],
        });
    }
}

