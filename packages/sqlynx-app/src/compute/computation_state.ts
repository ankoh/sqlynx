import * as arrow from 'apache-arrow';
import * as compute from '@ankoh/sqlynx-compute';
import * as proto from '@ankoh/sqlynx-protobuf';

import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskVariant, TaskProgress, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, createOrderByTransform, createTableSummaryTransform, createColumnSummaryTransform, ColumnEntryVariant } from './computation_task.js';

import { Dispatch, VariantKind } from '../utils/variant.js';
import { AsyncDataFrame, ComputeWorkerBindings } from './compute_worker_bindings.js';
import { Logger } from '../platform/logger.js';

const LOG_CTX = "computation_state";

/// The table computation state
interface TableComputationState {
    /// The table id
    tableId: number;
    /// The epoch number
    localEpoch: number;

    /// The table on the main thread
    dataTable: arrow.Table;
    /// The data frame in the compute module
    dataFrame: AsyncDataFrame | null;
    /// The data frame column information (if mapped)
    dataFrameColumns: ColumnEntryVariant[] | null;
    /// The current data frame ordering
    dataFrameOrdering: proto.sqlynx_compute.pb.OrderByConstraint[];

    /// The ordering task
    orderingTask: TableOrderingTask | null;
    /// The ordering task status
    orderingTaskStatus: TaskStatus | null;

    /// The table stats task
    tableSummaryTask: TableSummaryTask | null;
    /// The task status
    tableSummaryTaskStatus: TaskStatus | null;
    /// The table stats
    tableSummary: TableSummary | null;

    /// The pending column tasks
    columnSummariesPending: ColumnSummaryTask[];
    /// The running column tasks
    columnSummariesStatus: Map<number, TaskStatus>;
    /// The column stats
    columnSummaries: (ColumnSummaryVariant | null)[];
}

/// The computation registry
export interface ComputationState {
    /// The epoch number
    globalEpoch: number;
    /// The computation worker
    computationWorker: ComputeWorkerBindings | null;
    /// The computations
    tableComputations: Map<number, TableComputationState>;
    /// The current task
    currentTask: TaskVariant | null;
    /// The current task status
    currentTaskStatus: TaskStatus | null;
}

export const DELETE_COMPUTATION = Symbol('DELETE_COMPUTATION');
export const REGISTER_COMPUTATION = Symbol('REGISTER_COMPUTATION');
export const CREATED_DATA_FRAME = Symbol('CREATED_DATA_FRAME');
export const SUMMARIZE_TABLE = Symbol('SUMMARIZE_TABLE');
export const SORT_TABLE = Symbol('SORT_TABLE');

export const TABLE_ORDERING_TASK_RUNNING = Symbol('TABLE_ORDERING_TASK_RUNNING');
export const TABLE_ORDERING_TASK_FAILED = Symbol('TABLE_ORDERING_TASK_FAILED');
export const TABLE_ORDERING_TASK_SUCCEEDED = Symbol('TABLE_ORDERING_TASK_SUCCEEDED');

export const TABLE_SUMMARY_TASK_RUNNING = Symbol('TABLE_SUMMARY_TASK_RUNNING');
export const TABLE_SUMMARY_TASK_FAILED = Symbol('TABLE_SUMMARY_TASK_FAILED');
export const TABLE_SUMMARY_TASK_SUCCEEDED = Symbol('TABLE_SUMMARY_TASK_SUCCEEDED');

export const COLUMN_SUMMARY_TASK_RUNNING = Symbol('COLUMN_SUMMARY_TASK_RUNNING');
export const COLUMN_SUMMARY_TASK_FAILED = Symbol('COLUMN_SUMMARY_TASK_FAILED');
export const COLUMN_SUMMARY_TASK_SUCCEEDED = Symbol('COLUMN_SUMMARY_TASK_SUCCEEDED');

export type ComputationAction =
    | VariantKind<typeof DELETE_COMPUTATION, [number]>
    | VariantKind<typeof REGISTER_COMPUTATION, [number, arrow.Table]>
    | VariantKind<typeof CREATED_DATA_FRAME, [number, compute.DataFrame]>
    | VariantKind<typeof SUMMARIZE_TABLE, [number]>
    | VariantKind<typeof SORT_TABLE, [number, TableOrderingTask]>

    | VariantKind<typeof TABLE_ORDERING_TASK_RUNNING, [number, TaskProgress]>
    | VariantKind<typeof TABLE_ORDERING_TASK_FAILED, [number, TaskProgress, any]>
    | VariantKind<typeof TABLE_ORDERING_TASK_SUCCEEDED, [number, TaskProgress, OrderedTable]>

    | VariantKind<typeof TABLE_SUMMARY_TASK_RUNNING, [number, TaskProgress]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_FAILED, [number, TaskProgress, any]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_SUCCEEDED, [number, TaskProgress, TableSummary]>

    | VariantKind<typeof COLUMN_SUMMARY_TASK_RUNNING, [number, number, TaskProgress]>
    | VariantKind<typeof COLUMN_SUMMARY_TASK_FAILED, [number, number, TaskProgress, any]>
    | VariantKind<typeof COLUMN_SUMMARY_TASK_SUCCEEDED, [number, number, TaskProgress, ColumnSummaryVariant]>
    ;

export function reduceComputationState(state: ComputationState, action: ComputationAction, _dispatch: Dispatch<ComputationAction>): ComputationState {
    const tableId = action.value[0];
    const computation = state.tableComputations.get(tableId);

    // Couldn't find computation state?
    if (!computation) {
        // If the intent is to register a new computation do so.
        if (action.type == REGISTER_COMPUTATION) {

        } else {
            // Otherwise ignore the action
            return state;
        }
    }

    return state;
}

/// Schedule the next computation
export async function scheduleNextComputation(state: ComputationState, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
    // Has a task running?
    if (state.currentTaskStatus != null && state.currentTaskStatus == TaskStatus.TASK_RUNNING) {
        return;
    }

    for (const tableState of state.tableComputations.values()) {
        // Data frame not ready yet?
        if (tableState.dataFrame == null) {
            continue;
        }
        // Pending ordering task?
        if (tableState.orderingTask != null && tableState.orderingTaskStatus == null) {
            // Reorder the table
            await sortTable(tableState, tableState.orderingTask, dispatch, logger);
            return;
        }
        // Pending table summary task?
        if (tableState.tableSummaryTask != null && tableState.tableSummaryTaskStatus == null) {
            // Compute table summary
            await summarizeTable(tableState, tableState.tableSummaryTask, dispatch, logger);
            return;
        }

        // Pending column summary task?
        if (tableState.columnSummariesPending.length > 0 && tableState.tableSummary != null) {
            // Delete task from pending
            const task = tableState.columnSummariesPending[0];
            tableState.columnSummariesPending.shift();
            // Table summary is empty?
            if (tableState.tableSummary == null) {
                continue
            }
            // Compute column summary
            await summarizeColumn(tableState, task, tableState.tableSummary, dispatch, logger);
            return;
        }
    }
}

/// Helper to sort a table
async function sortTable(tableState: TableComputationState, task: TableOrderingTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
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
            value: [tableState.tableId, taskProgress]
        });
        // Order the data frame
        const transformed = await tableState.dataFrame!.transform(transform);
        logger.info(`sorting table ${tableState.tableId} succeded, scanning result`, LOG_CTX);
        // Read the result
        const orderedTable = await transformed.readTable();
        logger.info(`scanning sorted table ${tableState.tableId} suceeded`, LOG_CTX);
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
            value: [tableState.tableId, taskProgress, out],
        });

    } catch (error: any) {
        logger.error(`ordering table ${tableState.tableId} failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: TABLE_ORDERING_TASK_FAILED,
            value: [tableState.tableId, taskProgress, error],
        });
    }
}

/// Helper to summarize a table
async function summarizeTable(tableState: TableComputationState, task: TableSummaryTask, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
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
            value: [tableState.tableId, taskProgress]
        });
        // Order the data frame
        const transformedDataFrame = await tableState.dataFrame!.transform(transform);
        logger.info(`summarizing table ${tableState.tableId} succeded, scanning result`, LOG_CTX);
        // Read the result
        const transformedTable = await transformedDataFrame.readTable();
        logger.info(`scanning summary for table ${tableState.tableId} suceeded`, LOG_CTX);
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
            value: [tableState.tableId, taskProgress, summary],
        });

    } catch (error: any) {
        logger.error(`ordering table ${tableState.tableId} failed with error: ${error.toString()}`);
        taskProgress = {
            status: TaskStatus.TASK_FAILED,
            startedAt,
            completedAt: null,
            failedAt: new Date(),
            failedWithError: error,
        };
        dispatch({
            type: TABLE_SUMMARY_TASK_FAILED,
            value: [tableState.tableId, taskProgress, error],
        });
    }
}

async function summarizeColumn(tableState: TableComputationState, task: ColumnSummaryTask, tableSummary: TableSummary, dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
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
        logger.error(`ordering table ${tableState.tableId} failed with error: ${error.toString()}`);
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

