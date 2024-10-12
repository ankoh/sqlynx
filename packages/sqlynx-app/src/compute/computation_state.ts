import * as arrow from 'apache-arrow';
import * as compute from '@ankoh/sqlynx-compute';

import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskVariant, TASK_RUNNING } from './computation_task.js';

import { Dispatch, VariantKind } from '../utils/variant.js';
import { ComputeWorkerBindings } from './compute_worker_bindings.js';
import { Logger } from '../platform/logger.js';

/// The table computation state
interface TableComputationState {
    /// The table id
    tableId: number;
    /// The table on the main thread
    table: arrow.Table;
    /// The epoch number
    localEpoch: number;

    /// The data frame in the compute module
    dataFrame: compute.DataFrame | null;

    /// The ordering task
    orderingTask: TableOrderingTask | null;
    /// The ordering task status
    orderingTaskStatus: TaskStatus | null;
    /// The ordered table
    orderedTable: OrderedTable | null;

    /// The table stats task
    tableSummaryTask: TableSummaryTask | null;
    /// The task status
    tableSummaryTaskStatus: TaskStatus | null;
    /// The table stats
    tableSummary: TableSummary | null;

    /// The pending column tasks
    columnSummariesPending: Map<number, ColumnSummaryTask>;
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

    | VariantKind<typeof TABLE_ORDERING_TASK_RUNNING, [number, TaskStatus]>
    | VariantKind<typeof TABLE_ORDERING_TASK_FAILED, [number, TaskStatus]>
    | VariantKind<typeof TABLE_ORDERING_TASK_SUCCEEDED, [number, TaskStatus, OrderedTable]>

    | VariantKind<typeof TABLE_SUMMARY_TASK_RUNNING, [number, TaskStatus]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_FAILED, [number, TaskStatus]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_SUCCEEDED, [number, TaskStatus, TableSummary]>

    | VariantKind<typeof COLUMN_SUMMARY_TASK_RUNNING, [number, number, TaskStatus]>
    | VariantKind<typeof COLUMN_SUMMARY_TASK_FAILED, [number, number, TaskStatus]>
    | VariantKind<typeof COLUMN_SUMMARY_TASK_SUCCEEDED, [number, number, TaskStatus, ColumnSummaryVariant]>
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
    if (state.currentTaskStatus != null && state.currentTaskStatus.type == TASK_RUNNING) {
        return;
    }

    for (const tableState of state.tableComputations.values()) {
        // Pending ordering task?
        if (tableState.orderingTask != null && tableState.orderingTaskStatus == null) {
            // Reorder the table
            await sortTable(state, tableState, tableState.orderingTask, dispatch, logger);
            return;
        }
        // Pending table summary task?
        if (tableState.tableSummaryTask != null && tableState.tableSummaryTaskStatus == null) {
            // Compute table summary
            await summarizeTable(state, tableState, tableState.tableSummaryTask, dispatch, logger);
            return;
        }
        // Pending column summary task
        if (tableState.columnSummariesPending.size > 0) {
            // Delete task from pending
            const [k, v] = tableState.columnSummariesPending.entries().next().value!;
            tableState.columnSummariesPending.delete(k);
            // Compute column summary
            await summarizeColumn(state, tableState, v, dispatch, logger);
            return;
        }
    }
}

/// Helper to sort a table
async function sortTable(state: ComputationState, tableState: TableComputationState, task: TableOrderingTask, _dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {
}

/// Helper to summarize a table
async function summarizeTable(state: ComputationState, tableState: TableComputationState, task: TableSummaryTask, _dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> {

}

async function summarizeColumn(state: ComputationState, tableState: TableComputationState, task: ColumnSummaryTask, _dispatch: Dispatch<ComputationAction>, logger: Logger): Promise<void> { }

