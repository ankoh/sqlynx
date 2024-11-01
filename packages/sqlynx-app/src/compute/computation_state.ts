import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-protobuf';

import { ColumnSummaryVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask, TableSummary, OrderedTable, TaskProgress, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, createOrderByTransform, createTableSummaryTransform, createColumnSummaryTransform, ColumnEntryVariant, TablePrecomputationTask, SKIPPED_COLUMN } from './computation_task.js';

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

    | VariantKind<typeof REGISTER_COMPUTATION, [number, arrow.Table, AbortController]>
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
            const [tableId, table, tableLifetime] = action.value;
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

