import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-protobuf';

import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskProgress, ColumnEntryVariant, TablePrecomputationTask } from './table_transforms.js';

import { VariantKind } from '../utils/variant.js';
import { AsyncDataFrame, ComputeWorkerBindings } from './compute_worker_bindings.js';

/// The table computation state
export interface TableComputationState {
    /// The table id
    tableId: number;
    /// The epoch number
    localEpoch: number;

    /// The table on the main thread
    dataTable: arrow.Table;
    /// The data frame column information (if mapped)
    dataTableColumns: ColumnEntryVariant[];
    /// The abort controller
    dataTableLifetime: AbortController;
    /// The current ordering
    dataTableOrdering: proto.sqlynx_compute.pb.OrderByConstraint[];
    /// The data frame in the compute module
    dataFrame: AsyncDataFrame | null;

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

    /// The table precomputation task
    tablePrecomputationTask: TablePrecomputationTask | null;
    /// The task tatus
    tablePrecomputationStatus: TaskStatus | null;

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
    /// The computation worker error
    computationWorkerSetupError: Error | null;
    /// The computations
    tableComputations: Map<number, TableComputationState>;
}

/// Create the computation state
export function createComputationState(): ComputationState {
    return {
        globalEpoch: 0,
        computationWorker: null,
        computationWorkerSetupError: null,
        tableComputations: new Map(),
    };
}
/// Create the table computation state
function createTableComputationState(tableId: number, table: arrow.Table, tableColumns: ColumnEntryVariant[], tableLifetime: AbortController): TableComputationState {
    return {
        tableId,
        localEpoch: 0,
        dataTable: table,
        dataTableColumns: tableColumns,
        dataTableLifetime: tableLifetime,
        dataTableOrdering: [],
        dataFrame: null,
        orderingTask: null,
        orderingTaskStatus: null,
        tableSummaryTask: null,
        tableSummaryTaskStatus: null,
        tableSummary: null,
        tablePrecomputationTask: null,
        tablePrecomputationStatus: null,
        columnSummariesPending: [],
        columnSummariesStatus: new Map(),
        columnSummaries: []
    };
}

export const COMPUTATION_WORKER_CONFIGURED = Symbol('REGISTER_COMPUTATION');
export const COMPUTATION_WORKER_CONFIGURATION_FAILED = Symbol('COMPUTATION_WORKER_SETUP_FAILED');

export const REGISTER_COMPUTATION = Symbol('REGISTER_COMPUTATION');
export const DELETE_COMPUTATION = Symbol('DELETE_COMPUTATION');
export const CREATED_DATA_FRAME = Symbol('CREATED_DATA_FRAME');

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
    | VariantKind<typeof COMPUTATION_WORKER_CONFIGURED, ComputeWorkerBindings>
    | VariantKind<typeof COMPUTATION_WORKER_CONFIGURATION_FAILED, Error | null>

    | VariantKind<typeof REGISTER_COMPUTATION, [number, arrow.Table, ColumnEntryVariant[], AbortController]>
    | VariantKind<typeof DELETE_COMPUTATION, [number]>
    | VariantKind<typeof CREATED_DATA_FRAME, [number, AsyncDataFrame]>

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

export function reduceComputationState(state: ComputationState, action: ComputationAction): ComputationState {
    switch (action.type) {
        case COMPUTATION_WORKER_CONFIGURED:
            return {
                ...state,
                computationWorker: action.value,
            };
        case COMPUTATION_WORKER_CONFIGURATION_FAILED:
            return {
                ...state,
                computationWorkerSetupError: action.value,
            };
        case REGISTER_COMPUTATION: {
            const [tableId, table, tableColumns, tableLifetime] = action.value;
            const tableState = createTableComputationState(tableId, table, tableColumns, tableLifetime);
            state.tableComputations.set(tableId, tableState);
            return {
                ...state,
                tableComputations: state.tableComputations
            };
        }
        case DELETE_COMPUTATION: {
            const [tableId] = action.value;
            const tableState = state.tableComputations.get(tableId);
            if (tableState !== undefined) {

            }
            state.tableComputations.delete(tableId);
            return { ...state };
        }
        case CREATED_DATA_FRAME: {
            const [tableId, dataFrame] = action.value;
            const prevTableState = state.tableComputations.get(tableId)!;
            const nextTableState: TableComputationState = {
                ...prevTableState,
                dataFrame,
            };
            state.tableComputations.set(tableId, nextTableState);
            return { ...state };
        }
    }
    return state;
}
