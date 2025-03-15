import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/dashql-protobuf';

import { ColumnSummaryVariant, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskProgress, GridColumnGroup, ColumnPrecomputationTask } from './table_transforms.js';
import { VariantKind } from '../utils/variant.js';
import { AsyncDataFrame, ComputeWorkerBindings } from './compute_worker_bindings.js';

/// The table computation state
export interface TableComputationState {
    /// The computation id
    /// (Equals the query id)
    computationId: number;
    /// The epoch number
    localEpoch: number;

    /// The table on the main thread
    dataTable: arrow.Table;
    /// The table field index
    dataTableFieldsByName: Map<string, number>;
    /// The abort controller
    dataTableLifetime: AbortController;
    /// The data frame in the compute module
    dataFrame: AsyncDataFrame | null;
    /// The ordering constraints
    dataTableOrdering: proto.dashql_compute.pb.OrderByConstraint[];

    /// The grid columns
    columnGroups: GridColumnGroup[];
    /// The running column tasks
    columnGroupSummariesStatus: (TaskStatus | null)[];
    /// The column stats
    columnGroupSummaries: (ColumnSummaryVariant | null)[];

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
    columnPrecomputationTask: ColumnPrecomputationTask | null;
    /// The task tatus
    columnPrecomputationStatus: TaskStatus | null;
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

export function createArrowFieldIndex(table: arrow.Table): Map<string, number> {
    let out = new Map<string, number>();
    for (let i = 0; i < table.schema.fields.length; ++i) {
        out.set(table.schema.fields[i].name, i);
    }
    return out;
}

/// Create the table computation state
function createTableComputationState(computationId: number, table: arrow.Table, tableColumns: GridColumnGroup[], tableLifetime: AbortController): TableComputationState {
    return {
        computationId: computationId,
        localEpoch: 0,
        dataTable: table,
        dataTableFieldsByName: createArrowFieldIndex(table),
        columnGroups: tableColumns,
        dataTableLifetime: tableLifetime,
        dataTableOrdering: [],
        dataFrame: null,
        orderingTask: null,
        orderingTaskStatus: null,
        tableSummaryTask: null,
        tableSummaryTaskStatus: null,
        tableSummary: null,
        columnPrecomputationTask: null,
        columnPrecomputationStatus: null,
        columnGroupSummariesStatus: Array.from({ length: tableColumns.length }, () => null),
        columnGroupSummaries: Array.from({ length: tableColumns.length }, () => null)
    };
}

export const COMPUTATION_WORKER_CONFIGURED = Symbol('REGISTER_COMPUTATION');
export const COMPUTATION_WORKER_CONFIGURATION_FAILED = Symbol('COMPUTATION_WORKER_SETUP_FAILED');

export const COMPUTATION_FROM_QUERY_RESULT = Symbol('COMPUTATION_FROM_QUERY_RESULT');
export const DELETE_COMPUTATION = Symbol('DELETE_COMPUTATION');
export const CREATED_DATA_FRAME = Symbol('CREATED_DATA_FRAME');

export const PRECOMPUTATION_TASK_RUNNING = Symbol('PRECOMPUTATION_TASK_RUNNING');
export const PRECOMPUTATION_TASK_FAILED = Symbol('PRECOMPUTATION_TASK_FAILED');
export const PRECOMPUTATION_TASK_SUCCEEDED = Symbol('PRECOMPUTATION_TASK_SUCCEEDED');

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

    | VariantKind<typeof COMPUTATION_FROM_QUERY_RESULT, [number, arrow.Table, GridColumnGroup[], AbortController]>
    | VariantKind<typeof DELETE_COMPUTATION, [number]>
    | VariantKind<typeof CREATED_DATA_FRAME, [number, AsyncDataFrame]>

    | VariantKind<typeof TABLE_ORDERING_TASK_RUNNING, [number, TaskProgress]>
    | VariantKind<typeof TABLE_ORDERING_TASK_FAILED, [number, TaskProgress, any]>
    | VariantKind<typeof TABLE_ORDERING_TASK_SUCCEEDED, [number, TaskProgress, OrderedTable]>

    | VariantKind<typeof TABLE_SUMMARY_TASK_RUNNING, [number, TaskProgress]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_FAILED, [number, TaskProgress, any]>
    | VariantKind<typeof TABLE_SUMMARY_TASK_SUCCEEDED, [number, TaskProgress, TableSummary]>


    | VariantKind<typeof PRECOMPUTATION_TASK_RUNNING, [number, TaskProgress]>
    | VariantKind<typeof PRECOMPUTATION_TASK_FAILED, [number, TaskProgress, any]>
    | VariantKind<typeof PRECOMPUTATION_TASK_SUCCEEDED, [number, TaskProgress, arrow.Table, AsyncDataFrame, GridColumnGroup[]]>

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
        case COMPUTATION_FROM_QUERY_RESULT: {
            const [computationId, table, tableColumns, tableLifetime] = action.value;
            const tableState = createTableComputationState(computationId, table, tableColumns, tableLifetime);
            state.tableComputations.set(computationId, tableState);
            return {
                ...state,
                tableComputations: state.tableComputations
            };
        }
        case DELETE_COMPUTATION: {
            const [computationId] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            state.tableComputations.delete(computationId);
            return { ...state };
        }
        case CREATED_DATA_FRAME: {
            const [computationId, dataFrame] = action.value;
            const prevTableState = state.tableComputations.get(computationId)!;
            const nextTableState: TableComputationState = {
                ...prevTableState,
                dataFrame,
            };
            state.tableComputations.set(computationId, nextTableState);
            return { ...state };
        }
        case TABLE_ORDERING_TASK_SUCCEEDED: {
            const [computationId, taskProgress, orderedTable] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            if (tableState.dataFrame != null) {
                tableState.dataFrame.delete();
            }
            state.tableComputations.set(computationId, {
                ...tableState,
                dataFrame: orderedTable.dataFrame,
                dataTable: orderedTable.dataTable,
                dataTableOrdering: orderedTable.orderingConstraints,
                orderingTaskStatus: taskProgress.status,
            });
            return { ...state };
        }
        case TABLE_SUMMARY_TASK_RUNNING:
        case TABLE_SUMMARY_TASK_FAILED: {
            const [computationId, taskProgress] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            state.tableComputations.set(computationId, {
                ...tableState,
                tableSummaryTaskStatus: taskProgress.status,
            });
            return { ...state };
        }
        case TABLE_SUMMARY_TASK_SUCCEEDED: {
            const [computationId, taskProgress, tableSummary] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            state.tableComputations.set(computationId, {
                ...tableState,
                tableSummaryTaskStatus: taskProgress.status,
                tableSummary: tableSummary
            });
            return { ...state };
        }
        case PRECOMPUTATION_TASK_RUNNING:
        case PRECOMPUTATION_TASK_FAILED: {
            const [computationId, taskProgress] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            state.tableComputations.set(computationId, {
                ...tableState,
                columnPrecomputationStatus: taskProgress.status,
            });
            return { ...state };
        }
        case PRECOMPUTATION_TASK_SUCCEEDED: {
            const [computationId, taskProgress, dataTable, dataFrame, columnEntries] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            state.tableComputations.set(computationId, {
                ...tableState,
                dataTable,
                dataFrame,
                columnGroups: columnEntries,
                tableSummaryTaskStatus: taskProgress.status,

            });
            return { ...state };
        }
        case COLUMN_SUMMARY_TASK_RUNNING:
        case COLUMN_SUMMARY_TASK_FAILED: {
            const [computationId, columnId, taskProgress] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            const status = [...tableState.columnGroupSummariesStatus];
            status[columnId] = taskProgress.status;
            state.tableComputations.set(computationId, {
                ...tableState,
                columnGroupSummariesStatus: status,
            });
            return { ...state };
        }
        case COLUMN_SUMMARY_TASK_SUCCEEDED: {
            const [computationId, columnId, taskProgress, columnSummary] = action.value;
            const tableState = state.tableComputations.get(computationId);
            if (tableState === undefined) {
                return state;
            }
            const status = [...tableState.columnGroupSummariesStatus];
            const summaries = [...tableState.columnGroupSummaries];
            status[columnId] = taskProgress.status;
            summaries[columnId] = columnSummary;
            state.tableComputations.set(computationId, {
                ...tableState,
                columnGroupSummariesStatus: status,
                columnGroupSummaries: summaries
            });
            return { ...state };
        }
    }
    return state;
}
