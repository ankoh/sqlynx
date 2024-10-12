import * as arrow from 'apache-arrow';
import * as compute from '@ankoh/sqlynx-compute';

import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, TableOrdering } from './computation_task.js';
import { VariantKind } from '../utils/variant.js';

/// The table computation state
interface TableComputationState {
    /// The table id
    tableId: number;
    /// The table on the main thread
    table: arrow.Table;
    /// The data frame in the compute module
    dataFrame: compute.DataFrame | null;

    /// The ordering task status
    orderingTaskStatus: TaskStatus | null;
    /// The ordering task
    orderingTask: TableOrderingTask | null;
    /// The ordered table
    orderedTable: arrow.Table | null;

    /// The task status
    tableSummaryTaskStatus: TaskStatus | null;
    /// The table stats task
    tableSummaryTask: TableSummaryTask | null;
    /// The table stats
    tableSummary: TableSummary | null;

    /// The pending column tasks
    columnSummariesPending: Map<number, ColumnSummaryTask>;
    /// The running column tasks
    columnSummariesRunning: Map<number, ColumnSummaryTask>;
    /// The column stats
    columnSummaries: (ColumnSummaryVariant | TaskStatus | null)[];
}

/// The computation registry
export interface ComputationRegistry {
    /// The computations
    tableComputations: Map<number, TableComputationState>;
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

export type TableComputationAction =
    | VariantKind<typeof DELETE_COMPUTATION, number>
    | VariantKind<typeof REGISTER_COMPUTATION, [number, arrow.Table]>
    | VariantKind<typeof CREATED_DATA_FRAME, [number, compute.DataFrame]>
    | VariantKind<typeof SUMMARIZE_TABLE, number>
    | VariantKind<typeof SORT_TABLE, [number, TableOrderingTask]>

    | VariantKind<typeof TABLE_ORDERING_TASK_RUNNING, [number, TaskStatus]>
    | VariantKind<typeof TABLE_ORDERING_TASK_FAILED, [number, TaskStatus]>
    | VariantKind<typeof TABLE_ORDERING_TASK_SUCCEEDED, [number, TaskStatus, TableOrdering]>

    | VariantKind<typeof TABLE_SUMMARY_TASK_RUNNING, [number, TaskStatus]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_FAILED, [number, TaskStatus]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_SUCCEEDED, [number, TaskStatus, TableSummary]>

    | VariantKind<typeof COLUMN_SUMMARY_TASK_RUNNING, [number, number, TaskStatus]>
    | VariantKind<typeof COLUMN_SUMMARY_TASK_FAILED, [number, number, TaskStatus]>
    | VariantKind<typeof COLUMN_SUMMARY_TASK_SUCCEEDED, [number, number, TaskStatus, ColumnSummaryVariant]>
    ;

export function reduceComputationState(state: TableComputationState, _action: TableComputationAction): TableComputationState {
    return state;
}
