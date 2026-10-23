import * as arrow from 'apache-arrow';

import { OrderByConstraint } from './sql/sqlframe_builder.js';
import { ColumnAggregationVariant, TableAggregationTask, TableOrderingTask, TableAggregation, TaskProgress, ColumnGroup, SystemColumnComputationTask, FilterTable, ROWNUMBER_COLUMN, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, SKIPPED_COLUMN, ColumnAggregationTask, OrderingTable, TableFilteringTask, WithProgress, TaskStatus, WithFilter, WithFilterEpoch, ComputationStateVersion, ResultSearchState, createResultSearchState, DataSearchTable, DataSearchTask } from './computation_types.js';
import { VariantKind } from '../utils/variant.js';
import { CrossFilters } from './cross_filters.js';
import { DataFrame, DataFrameRegistry } from './data_frame.js';
import { COLUMN_AGGREGATION_TASK, DATA_SEARCH_TASK, FILTERED_COLUMN_AGGREGATION_TASK, SYSTEM_COLUMN_COMPUTATION_TASK, TABLE_AGGREGATION_TASK, TABLE_FILTERING_TASK, TABLE_ORDERING_TASK, TaskVariant } from './computation_scheduler.js';
import { parseDataSearchMatches } from './sql/query_result_search_sql.js';

const LOG_CTX = 'computation_state';

/// The table computation state
export interface TableComputationState {
    /// The table id
    tableId: number;
    /// The tasks
    tasks: TableComputationTasks;

    /// The current version tracking data, filter, and ordering changes
    version: ComputationStateVersion;
    /// The table on the main thread
    dataTable: arrow.Table;
    /// The table field index
    dataTableFieldsByName: Map<string, number>;
    /// The abort controller
    dataTableLifetime: AbortController;
    /// The data frame in the compute module
    dataFrame: DataFrame | null;
    /// The grid columns
    columnGroups: ColumnGroup[];
    /// The ordering constraints
    dataTableOrdering: OrderByConstraint[];

    /// The active cross-filter selection.
    /// This is the source of truth for cross-filtering and lives here (rather than
    /// as component-local state) so that every view of the same table - the result
    /// table header plots and the visualization tab's aggregation bar - shares one
    /// selection and drives a single `filterTable`.
    crossFilters: CrossFilters;
    /// The active filter table (if any)
    filterTable: FilterTable | null;
    /// The active ordering table (if any)
    orderingTable: OrderingTable | null;
    /// Shared Columns search for every view of this result
    columnSearch: ResultSearchState;
    /// Shared Data search for every view of this result
    dataSearch: ResultSearchState;
    /// The materialized rows and matching columns for the applied Data search
    dataSearchTable: DataSearchTable | null;
    /// The row number column group
    rowNumberColumnGroup: number | null;
    /// The row number column name
    rowNumberColumnName: string | null;
    /// The table aggregation
    tableAggregation: TableAggregation | null;
    /// The column (group) aggregates
    columnAggregates: (ColumnAggregationVariant | null)[];
    /// The filtered column (group) aggregates
    filteredColumnAggregates: (WithFilterEpoch<ColumnAggregationVariant> | null)[];
    /// Indicates which filtered column aggregates are outdated for the current filter
    filteredColumnAggregatesOutdated: boolean[];
}

export interface TableComputationTasks {
    /// The table aggregation task
    tableAggregationTask: WithProgress<TableAggregationTask> | null;
    /// The task to precompute system columns
    systemColumnTask: WithProgress<SystemColumnComputationTask> | null;
    /// The filtering task
    filteringTask: WithProgress<TableFilteringTask> | null;
    /// The ordering task
    orderingTask: WithProgress<TableOrderingTask> | null;
    /// The Data-search materialization task
    dataSearchTask: WithProgress<DataSearchTask> | null;
    /// The task to compute column (group) aggregates.
    /// The array contains N entries where N is the number of column groups
    columnAggregationTasks: (WithProgress<ColumnAggregationTask> | null)[];
    /// The task to compute filtered column (group) aggregates
    filteredColumnAggregationTasks: (WithProgress<WithFilter<ColumnAggregationTask>> | null)[];
}

/// The computation registry.
/// We store the scheduler tasks here as well to allow for linking the "latest" tasks safely in the per-table computation states.
export interface ComputationState {
    /// The computations
    tableComputations: { [key: number]: TableComputationState };

    /// The scheduler tasks
    schedulerTasks: { [key: number]: TaskVariant };
    /// The next task id
    nextSchedulerTaskId: number;
}

/// Create the computation state
export function createComputationState(): ComputationState {
    return {
        tableComputations: {},
        schedulerTasks: {},
        nextSchedulerTaskId: 1,
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
export function createTableComputationState(computationId: number, table: arrow.Table, tableColumns: ColumnGroup[], tableLifetime: AbortController): TableComputationState {
    return {
        tableId: computationId,
        tasks: {
            filteringTask: null,
            orderingTask: null,
            dataSearchTask: null,
            tableAggregationTask: null,
            systemColumnTask: null,
            columnAggregationTasks: Array(tableColumns.length + 1).fill(null),
            filteredColumnAggregationTasks: Array(tableColumns.length + 1).fill(null),
        },
        dataTable: table,
        version: new ComputationStateVersion(0, 0),
        dataTableFieldsByName: createArrowFieldIndex(table),
        columnGroups: tableColumns,
        columnAggregates: Array.from({ length: tableColumns.length }, () => null),
        rowNumberColumnGroup: null,
        rowNumberColumnName: null,
        dataTableLifetime: tableLifetime,
        dataTableOrdering: [],
        crossFilters: new CrossFilters(),
        dataFrame: null,
        filterTable: null,
        orderingTable: null,
        columnSearch: createResultSearchState(),
        dataSearch: createResultSearchState(),
        dataSearchTable: null,
        filteredColumnAggregates: Array.from({ length: tableColumns.length }, () => null),
        filteredColumnAggregatesOutdated: Array.from({ length: tableColumns.length }, () => false),
        tableAggregation: null,
    };
}

export const COMPUTATION_FROM_QUERY_RESULT = Symbol('COMPUTATION_FROM_QUERY_RESULT');
export const DELETE_COMPUTATION = Symbol('DELETE_COMPUTATION');
export const CREATED_DATA_FRAME = Symbol('CREATED_DATA_FRAME');
export const SCHEDULE_TASK = Symbol('SCHEDULE_TASK');
export const UPDATE_SCHEDULER_TASK = Symbol('UPDATE_SCHEDULER_TASK');
export const UNREGISTER_SCHEDULER_TASK = Symbol('UNREGISTER_SCHEDULER_TASK');
export const TABLE_ORDERING_SUCCEDED = Symbol('TABLE_ORDERING_SUCCEDED');
export const CLEAR_TABLE_ORDERING = Symbol('CLEAR_TABLE_ORDERING');
export const TABLE_FILTERING_SUCCEEDED = Symbol('TABLE_FILTERING_SUCCEEDED');
export const TABLE_AGGREGATION_SUCCEEDED = Symbol('TABLE_AGGREGATION_SUCCEEDED');
export const SYSTEM_COLUMN_COMPUTATION_SUCCEEDED = Symbol('SYSTEM_COLUMN_COMPUTATION_SUCCEEDED');
export const UMAP_COMPUTATION_SUCCEEDED = Symbol('UMAP_COMPUTATION_SUCCEEDED');
export const COLUMN_AGGREGATION_SUCCEEDED = Symbol('COLUMN_AGGREGATION_SUCCEEDED');
export const FILTERED_COLUMN_AGGREGATION_SUCCEEDED = Symbol('FILTERED_COLUMN_AGGREGATION_SUCCEEDED');
export const SET_CROSS_FILTERS = Symbol('SET_CROSS_FILTERS');
export const SET_RESULT_SEARCH_PATTERN = Symbol('SET_RESULT_SEARCH_PATTERN');
export const COLUMN_SEARCH_SUCCEEDED = Symbol('COLUMN_SEARCH_SUCCEEDED');
export const DATA_SEARCH_SUCCEEDED = Symbol('DATA_SEARCH_SUCCEEDED');
export const DATA_SEARCH_FAILED = Symbol('DATA_SEARCH_FAILED');
export const RESULT_SEARCH_FAILED = Symbol('RESULT_SEARCH_FAILED');

export type ComputationAction =
    | VariantKind<typeof SCHEDULE_TASK, TaskVariant>
    | VariantKind<typeof UPDATE_SCHEDULER_TASK, [TaskVariant, Partial<TaskProgress>]>
    | VariantKind<typeof UNREGISTER_SCHEDULER_TASK, TaskVariant>

    | VariantKind<typeof COMPUTATION_FROM_QUERY_RESULT, [number, arrow.Table, ColumnGroup[], AbortController]>
    | VariantKind<typeof DELETE_COMPUTATION, [number]>
    | VariantKind<typeof CREATED_DATA_FRAME, [number, DataFrame]>

    | VariantKind<typeof TABLE_ORDERING_SUCCEDED, [number, OrderingTable]>
    | VariantKind<typeof CLEAR_TABLE_ORDERING, number>
    | VariantKind<typeof TABLE_FILTERING_SUCCEEDED, [number, ComputationStateVersion, FilterTable | null]>
    | VariantKind<typeof TABLE_AGGREGATION_SUCCEEDED, [number, TableAggregation]>
    | VariantKind<typeof SYSTEM_COLUMN_COMPUTATION_SUCCEEDED, [number, arrow.Table, DataFrame, ColumnGroup[]]>
    | VariantKind<typeof UMAP_COMPUTATION_SUCCEEDED, [number, arrow.Table, DataFrame, ColumnGroup[]]>
    | VariantKind<typeof COLUMN_AGGREGATION_SUCCEEDED, [number, number, ColumnAggregationVariant]>
    | VariantKind<typeof FILTERED_COLUMN_AGGREGATION_SUCCEEDED, [number, number, ComputationStateVersion, WithFilterEpoch<ColumnAggregationVariant> | null]>
    | VariantKind<typeof SET_CROSS_FILTERS, [number, CrossFilters]>
    | VariantKind<typeof SET_RESULT_SEARCH_PATTERN, [number, 'columns' | 'data', string]>
    | VariantKind<typeof COLUMN_SEARCH_SUCCEEDED, [number, DataFrame, number, number[]]>
    | VariantKind<typeof DATA_SEARCH_SUCCEEDED, [number, DataFrame, number, DataSearchTable]>
    | VariantKind<typeof DATA_SEARCH_FAILED, [number, DataFrame, number, string]>
    | VariantKind<typeof RESULT_SEARCH_FAILED, [number, DataFrame, 'columns' | 'data', number, string]>
    ;

export function reduceComputationState(state: ComputationState, action: ComputationAction, memory: DataFrameRegistry): ComputationState {
    switch (action.type) {
        case SCHEDULE_TASK: {
            const taskVariant = action.value;
            const initialProgress: TaskProgress = {
                status: TaskStatus.TASK_RUNNING,
                startedAt: new Date(),
                completedAt: null,
                failedAt: null,
                failedWithError: null,
            };
            return updateTask(state, taskVariant, initialProgress, memory, true);
        }
        case UPDATE_SCHEDULER_TASK: {
            const [taskVariant, progress] = action.value;
            return updateTask(state, taskVariant, progress, memory, false);
        }
        case UNREGISTER_SCHEDULER_TASK: {
            if (action.value.taskId === undefined) {
                return state;
            }
            if (state.schedulerTasks[action.value.taskId] !== action.value) {
                return state;
            }
            const schedulerTasks = { ...state.schedulerTasks };
            delete schedulerTasks[action.value.taskId];
            releaseTaskDataFrames(action.value, memory);
            return {
                ...state,
                schedulerTasks
            };
        }

        case COMPUTATION_FROM_QUERY_RESULT: {
            const [tableId, table, tableColumns, tableLifetime] = action.value;
            const previousTableState = state.tableComputations[tableId];
            if (previousTableState !== undefined) {
                destroyTableComputationState(previousTableState, memory);
            }
            const tableState = createTableComputationState(tableId, table, tableColumns, tableLifetime);
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: tableState
                }
            };
        }
        case DELETE_COMPUTATION: {
            const [tableId] = action.value;
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                return state;
            }
            const tableComputations = { ...state.tableComputations };
            destroyTableComputationState(tableState, memory);
            delete tableComputations[tableId];
            return {
                ...state,
                tableComputations
            };
        }
        case CREATED_DATA_FRAME: {
            const [tableId, dataFrame] = action.value;
            memory.acquire(dataFrame);

            const prevTableState = state.tableComputations[tableId]!;
            const nextTableState: TableComputationState = {
                ...prevTableState,
                version: prevTableState.version.withDataIncrement(),
                dataFrame,
            };
            memory.release(prevTableState.dataFrame);
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: nextTableState
                }
            };
        }
        case TABLE_ORDERING_SUCCEDED: {
            const [tableId, orderingTable] = action.value;
            memory.acquire(orderingTable.dataFrame);

            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                memory.release(orderingTable.dataFrame);
                return state;
            }
            // Ordering depends on both data and filter, so check both
            if (!orderingTable.version.filterMatches(tableState.version)) {
                memory.release(orderingTable.dataFrame);
                return state;
            }
            if ((tableState.dataSearchTable?.requestId ?? null) !== (orderingTable.dataSearchRequestId ?? null)) {
                memory.release(orderingTable.dataFrame);
                return state;
            }
            const requestedOrdering = tableState.tasks.orderingTask?.orderingConstraints;
            if (requestedOrdering == null || !areOrderingConstraintsEqual(requestedOrdering, orderingTable.orderingConstraints)) {
                memory.release(orderingTable.dataFrame);
                return state;
            }

            const task = !tableState.tasks.orderingTask ? null : {
                ...tableState.tasks.orderingTask,
                progress: {
                    ...tableState.tasks.orderingTask.progress,
                    status: TaskStatus.TASK_SUCCEEDED,
                    completedAt: new Date(),
                }
            };
            memory.release(tableState.orderingTable?.dataFrame);
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        orderingTable,
                        dataTableOrdering: orderingTable.orderingConstraints,
                        tasks: {
                            ...tableState.tasks,
                            orderingTask: task
                        }
                    }
                }
            };
        }
        case CLEAR_TABLE_ORDERING: {
            const tableState = state.tableComputations[action.value];
            if (tableState === undefined) {
                return state;
            }
            memory.release(tableState.orderingTable?.dataFrame);
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [action.value]: {
                        ...tableState,
                        dataTableOrdering: [],
                        orderingTable: null,
                        tasks: {
                            ...tableState.tasks,
                            orderingTask: tableState.tasks.orderingTask == null ? null : {
                                ...tableState.tasks.orderingTask,
                                orderingConstraints: [],
                            },
                        },
                    },
                },
            };
        }
        case TABLE_FILTERING_SUCCEEDED: {
            const [tableId, completedVersion, filterTable] = action.value;
            memory.acquire(filterTable?.dataFrame);
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                memory.release(filterTable?.dataFrame);
                return state;
            }
            // Reject stale filter results (must match current state exactly)
            // With pre-allocated versions, only accept results that match the current target
            if (!completedVersion.filterMatches(tableState.version)) {
                memory.release(filterTable?.dataFrame);
                return state;
            }
            return tableFilteringSucceded(state, tableId, filterTable, memory);
        }
        case TABLE_AGGREGATION_SUCCEEDED: {
            const [tableId, tableAggregation] = action.value;
            memory.acquire(tableAggregation.dataFrame);

            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                memory.release(tableAggregation.dataFrame);
                return state;
            }
            memory.release(tableState.tableAggregation?.dataFrame);

            const task = !tableState.tasks.tableAggregationTask ? null : {
                ...tableState.tasks.tableAggregationTask,
                progress: {
                    ...tableState.tasks.tableAggregationTask.progress,
                    status: TaskStatus.TASK_SUCCEEDED,
                    completedAt: new Date(),
                }
            };
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        tableAggregation: tableAggregation,
                        tasks: {
                            ...tableState.tasks,
                            tableAggregationTask: task,
                        }
                    }
                }
            };
        }
        case SYSTEM_COLUMN_COMPUTATION_SUCCEEDED: {
            const [tableId, dataTable, dataFrame, columnGroups] = action.value;
            memory.acquire(dataFrame);

            let rowNumberColumnGroup: number | null = null;
            let rowNumberColumnName: string | null = null;
            for (let i = 0; i < columnGroups.length; ++i) {
                const group = columnGroups[i];
                switch (group.type) {
                    case ROWNUMBER_COLUMN:
                        rowNumberColumnGroup = i;
                        rowNumberColumnName = group.value.rowNumberFieldName;
                        break;
                }
            }
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                memory.release(dataFrame);
                return state;
            }
            memory.release(tableState.dataFrame);

            const task = !tableState.tasks.systemColumnTask ? null : {
                ...tableState.tasks.systemColumnTask,
                progress: {
                    ...tableState.tasks.systemColumnTask.progress,
                    status: TaskStatus.TASK_SUCCEEDED,
                    completedAt: new Date(),
                }
            };
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        version: tableState.version.withDataIncrement(),
                        dataTable,
                        dataFrame,
                        columnGroups,
                        rowNumberColumnGroup,
                        rowNumberColumnName,
                        tasks: {
                            ...tableState.tasks,
                            systemColumnTask: task,
                        }
                    }
                }
            };
        }
        case UMAP_COMPUTATION_SUCCEEDED: {
            // The projection appends `x`/`y` coordinate columns to BOTH representations:
            // the main-thread arrow table (for the scatter renderer) and the embedded-database-backed
            // data frame (so the coordinates are queryable, e.g. future cross-filter /
            // ordering); the coordinate field names are recorded on the embedding
            // column's group (`umapProjection`).
            //
            // The new data frame replaces the old one, mirroring SYSTEM_COLUMN_COMPUTATION_SUCCEEDED:
            // acquire the new frame, release the previous. The version is deliberately NOT
            // incremented — the coordinates are additive columns on the same rows, so the
            // just-computed grid aggregates, filters and orderings stay valid.
            const [tableId, dataTable, dataFrame, columnGroups] = action.value;
            memory.acquire(dataFrame);

            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                memory.release(dataFrame);
                return state;
            }
            memory.release(tableState.dataFrame);
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        dataTable,
                        dataTableFieldsByName: createArrowFieldIndex(dataTable),
                        dataFrame,
                        columnGroups,
                    }
                }
            };
        }
        case COLUMN_AGGREGATION_SUCCEEDED: {
            const [tableId, columnId, columnAggregate] = action.value;
            acquireColumnAggregate(columnAggregate, memory);

            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                releaseColumnAggregate(columnAggregate, memory);
                return state;
            }
            // Column aggregation unknown?
            const currentTask = tableState.tasks.columnAggregationTasks[columnId];
            if (currentTask == null) {
                releaseColumnAggregate(columnAggregate, memory);
                return state;
            }
            // Destroy the previous column aggregate, if there is one
            const prevAggregate = tableState.columnAggregates[columnId];
            if (prevAggregate != null) {
                releaseColumnAggregate(prevAggregate, memory);
            }
            const columnAggregates: (ColumnAggregationVariant | null)[] = [...tableState.columnAggregates];
            const columnAggregationTasks = [...tableState.tasks.columnAggregationTasks];
            columnAggregates[columnId] = columnAggregate;
            const aggregationTask: WithProgress<ColumnAggregationTask> = {
                ...currentTask,
                progress: {
                    ...currentTask.progress,
                    completedAt: new Date(),
                    status: TaskStatus.TASK_SUCCEEDED,
                }
            };
            columnAggregationTasks[columnId] = aggregationTask;

            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        columnAggregates,
                        tasks: {
                            ...tableState.tasks,
                            columnAggregationTasks
                        }
                    }
                }
            };
        }
        case FILTERED_COLUMN_AGGREGATION_SUCCEEDED: {
            const [tableId, columnId, completedFilterVersion, newColumnAggregate] = action.value;
            acquireColumnAggregate(newColumnAggregate, memory);

            // Computation not registered?
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                releaseColumnAggregate(newColumnAggregate, memory);
                return state;
            }
            // Column aggregation task unknown?
            const currentTask = tableState.tasks.filteredColumnAggregationTasks[columnId];
            if (currentTask == null) {
                releaseColumnAggregate(newColumnAggregate, memory);
                return state;
            }
            if (!currentTask.tableVersion.filterMatches(completedFilterVersion)) {
                releaseColumnAggregate(newColumnAggregate, memory);
                return state;
            }
            const currentSelectionVersion = tableState.filterTable?.version ?? tableState.version;
            if (!currentSelectionVersion.filterMatches(completedFilterVersion)) {
                releaseColumnAggregate(newColumnAggregate, memory);
                return state;
            }
            if ((newColumnAggregate?.dataSearchRequestId ?? null) !== (tableState.dataSearchTable?.requestId ?? null)) {
                releaseColumnAggregate(newColumnAggregate, memory);
                return state;
            }
            if ((currentTask.dataSearchTable?.requestId ?? null) !== (tableState.dataSearchTable?.requestId ?? null)) {
                releaseColumnAggregate(newColumnAggregate, memory);
                return state;
            }

            const filteredColumnAggregates: (WithFilterEpoch<ColumnAggregationVariant> | null)[] = [...tableState.filteredColumnAggregates];
            const filteredColumnAggregatesOutdated = [...tableState.filteredColumnAggregatesOutdated];
            const filteredColumnAggregationTasks = [...tableState.tasks.filteredColumnAggregationTasks];
            const prevColumnAggregate = filteredColumnAggregates[columnId];
            filteredColumnAggregates[columnId] = newColumnAggregate;
            const task: WithProgress<WithFilter<ColumnAggregationTask>> = {
                ...currentTask,
                progress: {
                    ...currentTask.progress,
                    completedAt: new Date(),
                    status: TaskStatus.TASK_SUCCEEDED,
                }
            };
            filteredColumnAggregationTasks[columnId] = task;

            const aggregateUpToDate = newColumnAggregate != null
                && newColumnAggregate.filterVersion.filterMatches(currentSelectionVersion)
                && newColumnAggregate.dataSearchRequestId === (tableState.dataSearchTable?.requestId ?? null);
            filteredColumnAggregatesOutdated[columnId] = !aggregateUpToDate;

            // Destroy the previous column aggregate, if there is one
            if (prevColumnAggregate != null) {
                releaseColumnAggregate(prevColumnAggregate, memory);
            }
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        filteredColumnAggregates,
                        filteredColumnAggregatesOutdated,
                        tasks: {
                            ...tableState.tasks,
                            filteredColumnAggregationTasks
                        }
                    }
                },
            };
        }
        case SET_CROSS_FILTERS: {
            const [tableId, crossFilters] = action.value;
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                return state;
            }
            // No change? Keep the same state to avoid a spurious re-render / filtering pass.
            if (tableState.crossFilters.equals(crossFilters)) {
                return state;
            }
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        crossFilters,
                    }
                }
            };
        }
        case SET_RESULT_SEARCH_PATTERN: {
            const [tableId, kind, pattern] = action.value;
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined) {
                return state;
            }
            const current = kind === 'columns' ? tableState.columnSearch : tableState.dataSearch;
            if (current.requestedPattern === pattern && current.pending === (pattern.length > 0)) {
                return state;
            }
            const nextSearch: ResultSearchState = pattern.length === 0
                ? {
                    ...createResultSearchState(),
                    requestId: current.requestId + 1,
                    appliedRequestId: current.requestId + 1,
                }
                : {
                    ...current,
                    requestedPattern: pattern,
                    requestId: current.requestId + 1,
                    pending: true,
                    error: null,
                };
            if (kind === 'data') {
                tableState.tasks.dataSearchTask?.abortController.abort();
            }
            const clearAppliedDataSearch = kind === 'data' && pattern.length === 0;
            if (clearAppliedDataSearch) {
                memory.release(tableState.dataSearchTable?.dataFrame);
                memory.release(tableState.orderingTable?.dataFrame);
                memory.release(tableState.tasks.dataSearchTask?.inputDataFrame);
                if (tableState.filterTable == null) {
                    releaseColumnAggregates(tableState.filteredColumnAggregates, memory);
                }
            }
            const stateForOutdatedCheck = clearAppliedDataSearch
                ? { ...tableState, dataSearchTable: null }
                : tableState;
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        columnSearch: kind === 'columns' ? nextSearch : tableState.columnSearch,
                        dataSearch: kind === 'data' ? nextSearch : tableState.dataSearch,
                        dataSearchTable: clearAppliedDataSearch ? null : tableState.dataSearchTable,
                        orderingTable: clearAppliedDataSearch ? null : tableState.orderingTable,
                        tasks: clearAppliedDataSearch
                            ? { ...tableState.tasks, dataSearchTask: null }
                            : tableState.tasks,
                        filteredColumnAggregatesOutdated: clearAppliedDataSearch
                            ? getFilteredColumnAggregatesOutdated(stateForOutdatedCheck, null)
                            : tableState.filteredColumnAggregatesOutdated,
                        filteredColumnAggregates: clearAppliedDataSearch && tableState.filterTable == null
                            ? Array.from({ length: tableState.filteredColumnAggregates.length }, () => null)
                            : tableState.filteredColumnAggregates,
                    }
                }
            };
        }
        case COLUMN_SEARCH_SUCCEEDED: {
            const [tableId, sourceDataFrame, requestId, matchingColumnGroups] = action.value;
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined || tableState.dataFrame !== sourceDataFrame || tableState.columnSearch.requestId !== requestId) {
                return state;
            }
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        columnSearch: {
                            ...tableState.columnSearch,
                            appliedPattern: tableState.columnSearch.requestedPattern,
                            appliedRequestId: requestId,
                            matchingColumnGroups,
                            pending: false,
                            error: null,
                        }
                    }
                }
            };
        }
        case DATA_SEARCH_SUCCEEDED: {
            const [tableId, sourceDataFrame, requestId, dataSearchTable] = action.value;
            memory.acquire(dataSearchTable.dataFrame);
            const tableState = state.tableComputations[tableId];
            if (
                tableState === undefined
                || tableState.dataFrame !== sourceDataFrame
                || tableState.dataSearch.requestId !== requestId
                || !dataSearchTable.version.dataMatches(tableState.version)
            ) {
                memory.release(dataSearchTable.dataFrame);
                return state;
            }
            const matchingRows = parseDataSearchMatches(dataSearchTable.dataTable);
            memory.release(tableState.dataSearchTable?.dataFrame);
            memory.release(tableState.orderingTable?.dataFrame);
            if (tableState.filterTable == null) {
                releaseColumnAggregates(tableState.filteredColumnAggregates, memory);
            }
            const dataSearchTask = tableState.tasks.dataSearchTask == null ? null : {
                ...tableState.tasks.dataSearchTask,
                progress: {
                    ...tableState.tasks.dataSearchTask.progress,
                    status: TaskStatus.TASK_SUCCEEDED,
                    completedAt: new Date(),
                },
            };
            const effectiveVersion = tableState.filterTable?.version ?? tableState.version;
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        dataSearch: {
                            ...tableState.dataSearch,
                            appliedPattern: tableState.dataSearch.requestedPattern,
                            appliedRequestId: requestId,
                            matchingRows,
                            pending: false,
                            error: null,
                        },
                        dataSearchTable,
                        orderingTable: null,
                        filteredColumnAggregatesOutdated: getFilteredColumnAggregatesOutdated(
                            { ...tableState, version: effectiveVersion },
                            dataSearchTable,
                        ),
                        tasks: { ...tableState.tasks, dataSearchTask },
                    }
                }
            };
        }
        case DATA_SEARCH_FAILED: {
            const [tableId, sourceDataFrame, requestId, error] = action.value;
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined || tableState.dataFrame !== sourceDataFrame || tableState.dataSearch.requestId !== requestId) {
                return state;
            }
            memory.release(tableState.dataSearchTable?.dataFrame);
            memory.release(tableState.orderingTable?.dataFrame);
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        dataSearch: {
                            ...tableState.dataSearch,
                            appliedPattern: '',
                            appliedRequestId: requestId,
                            matchingRows: null,
                            pending: false,
                            error,
                        },
                        dataSearchTable: null,
                        orderingTable: null,
                        filteredColumnAggregatesOutdated: getFilteredColumnAggregatesOutdated({ ...tableState, dataSearchTable: null }, null),
                        filteredColumnAggregates: tableState.filterTable == null
                            ? Array.from({ length: tableState.filteredColumnAggregates.length }, () => null)
                            : tableState.filteredColumnAggregates,
                    },
                },
            };
        }
        case RESULT_SEARCH_FAILED: {
            const [tableId, sourceDataFrame, kind, requestId, error] = action.value;
            const tableState = state.tableComputations[tableId];
            if (tableState === undefined || tableState.dataFrame !== sourceDataFrame) {
                return state;
            }
            const current = kind === 'columns' ? tableState.columnSearch : tableState.dataSearch;
            if (current.requestId !== requestId) {
                return state;
            }
            const nextSearch: ResultSearchState = {
                ...current,
                appliedPattern: '',
                appliedRequestId: requestId,
                matchingColumnGroups: null,
                matchingRows: null,
                pending: false,
                error,
            };
            return {
                ...state,
                tableComputations: {
                    ...state.tableComputations,
                    [tableId]: {
                        ...tableState,
                        columnSearch: kind === 'columns' ? nextSearch : tableState.columnSearch,
                        dataSearch: kind === 'data' ? nextSearch : tableState.dataSearch,
                    }
                }
            };
        }
    }
}

function updateTask(state: ComputationState, task: TaskVariant, progress: Partial<TaskProgress>, memory: DataFrameRegistry, create: boolean = false) {
    const allocatedTaskId = task.taskId !== undefined;
    if (!allocatedTaskId) {
        task = {
            ...task,
            taskId: state.nextSchedulerTaskId,
        };
    }
    const tableState = state.tableComputations[task.value.tableId];
    if (tableState === undefined) {
        return state;
    }

    // Note that we acquire data frames times twice for scheduler task and table computation state
    let registerTask: (tasks: TableComputationTasks) => TableComputationTasks = (t: TableComputationTasks) => t;
    let newStateVersion = tableState.version;
    switch (task.type) {
        case TABLE_FILTERING_TASK:
            if (create) {
                memory.acquire(task.value.inputDataFrame, 2);
                // Increment filter version when scheduling (not when accepting result)
                // This ensures concurrent filter tasks get unique target versions
                newStateVersion = tableState.version.withFilterIncrement();
                // Update the task itself with the new target version
                task = {
                    ...task,
                    value: {
                        ...task.value,
                        tableVersion: newStateVersion,
                    }
                };
            }
            registerTask = (tasks: TableComputationTasks) => {
                const filterTask = task.value as TableFilteringTask;
                return ({
                    ...tasks,
                    filteringTask: {
                        tableId: filterTask.tableId,
                        tableVersion: newStateVersion,
                        inputDataTable: filterTask.inputDataTable,
                        inputDataTableFieldIndex: filterTask.inputDataTableFieldIndex,
                        inputDataFrame: filterTask.inputDataFrame,
                        rowNumberColumnName: filterTask.rowNumberColumnName,
                        filters: filterTask.filters,
                        progress: {
                            ...tasks.filteringTask?.progress,
                            ...progress,
                        } as TaskProgress,
                    }
                });
            };
            break;
        case TABLE_ORDERING_TASK:
            if (create) {
                memory.release(tableState.tasks.orderingTask?.inputDataFrame);
                memory.release(tableState.tasks.orderingTask?.filterTable?.dataFrame);
                memory.release(tableState.tasks.orderingTask?.dataSearchTable?.dataFrame);
                memory.acquire(task.value.inputDataFrame, 2);
                memory.acquire(task.value.filterTable?.dataFrame, 2);
                memory.acquire(task.value.dataSearchTable?.dataFrame, 2);
            }
            registerTask = (tasks: TableComputationTasks) => {
                const orderTask = task.value as TableOrderingTask;
                if (
                    !create
                    && tasks.orderingTask != null
                    && !areOrderingConstraintsEqual(tasks.orderingTask.orderingConstraints, orderTask.orderingConstraints)
                ) {
                    return tasks;
                }
                return ({
                    ...tasks,
                    orderingTask: {
                        tableId: orderTask.tableId,
                        tableVersion: tableState.version,
                        inputDataTable: orderTask.inputDataTable,
                        inputDataTableFieldIndex: orderTask.inputDataTableFieldIndex,
                        inputDataFrame: orderTask.inputDataFrame,
                        filterTable: orderTask.filterTable,
                        dataSearchTable: orderTask.dataSearchTable,
                        rowNumberColumnName: orderTask.rowNumberColumnName,
                        orderingConstraints: orderTask.orderingConstraints,
                        progress: {
                            ...tasks.orderingTask?.progress,
                            ...progress,
                        } as TaskProgress,
                    }
                });
            };
            break;
        case DATA_SEARCH_TASK:
            if (create) {
                tableState.tasks.dataSearchTask?.abortController.abort();
                memory.release(tableState.tasks.dataSearchTask?.inputDataFrame);
                memory.acquire(task.value.inputDataFrame, 2);
            }
            registerTask = (tasks: TableComputationTasks) => {
                const searchTask = task.value as DataSearchTask;
                if (!create && tasks.dataSearchTask?.requestId !== searchTask.requestId) {
                    return tasks;
                }
                return {
                    ...tasks,
                    dataSearchTask: {
                        ...searchTask,
                        progress: {
                            ...tasks.dataSearchTask?.progress,
                            ...progress,
                        } as TaskProgress,
                    },
                };
            };
            break;
        case TABLE_AGGREGATION_TASK:
            if (create) {
                memory.acquire(task.value.inputDataFrame, 2);
            }
            registerTask = (tasks: TableComputationTasks) => {
                const aggTask = task.value as TableAggregationTask;
                return ({
                    ...tasks,
                    tableAggregationTask: {
                        tableId: aggTask.tableId,
                        tableVersion: aggTask.tableVersion,
                        columnEntries: aggTask.columnEntries,
                        inputDataFrame: aggTask.inputDataFrame,
                        progress: {
                            ...tasks.tableAggregationTask?.progress,
                            ...progress,
                        } as TaskProgress,
                    }
                });
            };
            break;
        case SYSTEM_COLUMN_COMPUTATION_TASK:
            if (create) {
                memory.acquire(task.value.inputDataFrame, 2);
                memory.acquire(task.value.tableAggregate.dataFrame, 2);
            }
            registerTask = (tasks: TableComputationTasks) => {
                const sysTask = task.value as SystemColumnComputationTask;
                return ({
                    ...tasks,
                    systemColumnTask: {
                        tableId: sysTask.tableId,
                        tableVersion: sysTask.tableVersion,
                        columnEntries: sysTask.columnEntries,
                        inputTable: sysTask.inputTable,
                        inputDataFrame: sysTask.inputDataFrame,
                        tableAggregate: sysTask.tableAggregate,
                        progress: {
                            ...tasks.systemColumnTask?.progress,
                            ...progress,
                        } as TaskProgress,
                    }
                });
            };
            break;
        case COLUMN_AGGREGATION_TASK:
            if (create) {
                memory.acquire(task.value.inputDataFrame, 2);
                memory.acquire(task.value.tableAggregate.dataFrame, 2);
            }
            registerTask = (tasks: TableComputationTasks) => {
                const colTask = task.value as ColumnAggregationTask;
                const prev = tasks.columnAggregationTasks[colTask.columnId];
                const updated = [...tasks.columnAggregationTasks];
                updated[colTask.columnId] = {
                    tableId: colTask.tableId,
                    tableVersion: colTask.tableVersion,
                    columnId: colTask.columnId,
                    columnEntry: colTask.columnEntry,
                    inputDataFrame: colTask.inputDataFrame,
                    tableAggregate: colTask.tableAggregate,
                    progress: {
                        ...prev?.progress,
                        ...progress
                    } as TaskProgress
                };
                return ({
                    ...tasks,
                    columnAggregationTasks: updated
                })
            };
            break;
        case FILTERED_COLUMN_AGGREGATION_TASK:
            if (create) {
                const previous = tableState.tasks.filteredColumnAggregationTasks[task.value.columnId];
                memory.release(previous?.inputDataFrame);
                memory.release(previous?.filterTable?.dataFrame);
                memory.release(previous?.dataSearchTable?.dataFrame);
                releaseColumnAggregate(previous?.unfilteredAggregate, memory);
                memory.acquire(task.value.inputDataFrame, 2);
                memory.acquire(task.value.filterTable?.dataFrame, 2);
                memory.acquire(task.value.dataSearchTable?.dataFrame, 2);
                memory.acquire(task.value.tableAggregate.dataFrame, 2);
                acquireColumnAggregate(task.value.unfilteredAggregate, memory, 2);
            }
            registerTask = (tasks: TableComputationTasks) => {
                const filteredTask = task.value as WithFilter<ColumnAggregationTask>;
                const prev = tasks.filteredColumnAggregationTasks[filteredTask.columnId];
                const updated = [...tasks.filteredColumnAggregationTasks];
                updated[filteredTask.columnId] = {
                    tableId: filteredTask.tableId,
                    tableVersion: filteredTask.tableVersion,
                    columnId: filteredTask.columnId,
                    columnEntry: filteredTask.columnEntry,
                    inputDataFrame: filteredTask.inputDataFrame,
                    tableAggregate: filteredTask.tableAggregate,
                    filterTable: filteredTask.filterTable,
                    dataSearchTable: filteredTask.dataSearchTable,
                    selectionRowCount: filteredTask.selectionRowCount,
                    unfilteredAggregate: filteredTask.unfilteredAggregate,
                    progress: {
                        ...prev?.progress,
                        ...progress
                    } as TaskProgress
                };
                return ({
                    ...tasks,
                    filteredColumnAggregationTasks: updated
                })
            };
            break;
    }
    const updatedTaskId = task.taskId!;
    const updatedState: ComputationState = {
        ...state,
        nextSchedulerTaskId: (!allocatedTaskId) ? (state.nextSchedulerTaskId + 1) : state.nextSchedulerTaskId,
        schedulerTasks: {
            ...state.schedulerTasks,
            [updatedTaskId]: task
        },
        tableComputations: {
            ...state.tableComputations,
            [task.value.tableId]: {
                ...tableState,
                version: newStateVersion,
                tasks: registerTask(tableState.tasks)
            }
        }
    };
    return updatedState;
}

function releaseTaskDataFrames(task: TaskVariant, memory: DataFrameRegistry) {
    switch (task.type) {
        case TABLE_FILTERING_TASK:
        case TABLE_AGGREGATION_TASK:
        case DATA_SEARCH_TASK:
            memory.release(task.value.inputDataFrame);
            break;
        case TABLE_ORDERING_TASK:
            memory.release(task.value.inputDataFrame);
            memory.release(task.value.filterTable?.dataFrame);
            memory.release(task.value.dataSearchTable?.dataFrame);
            break;
        case SYSTEM_COLUMN_COMPUTATION_TASK:
            memory.release(task.value.inputDataFrame);
            break;
        case COLUMN_AGGREGATION_TASK:
            memory.release(task.value.inputDataFrame);
            break;
        case FILTERED_COLUMN_AGGREGATION_TASK:
            memory.release(task.value.inputDataFrame);
            memory.release(task.value.filterTable?.dataFrame);
            memory.release(task.value.dataSearchTable?.dataFrame);
            releaseColumnAggregate(task.value.unfilteredAggregate, memory);
            break;
    }
}

function areOrderingConstraintsEqual(left: OrderByConstraint[], right: OrderByConstraint[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((constraint, index) => {
        const other = right[index];
        return constraint.field === other.field
            && (constraint.ascending ?? true) === (other.ascending ?? true)
            && (constraint.nullsFirst ?? false) === (other.nullsFirst ?? false);
    });
}

function tableFilteringSucceded(state: ComputationState, tableId: number, filterTable: FilterTable | null, memory: DataFrameRegistry) {
    const tableState = state.tableComputations[tableId];
    if (tableState === undefined) {
        memory.release(filterTable?.dataFrame);
        return state;
    }

    // Mark filtering task succeeded
    const filteringTask = !tableState.tasks.filteringTask ? null : {
        ...tableState.tasks.filteringTask,
        progress: {
            ...tableState.tasks.filteringTask.progress,
            status: TaskStatus.TASK_SUCCEEDED,
            completedAt: new Date(),
        }
    };
    const obsoleteFilteredColumnAggregates: Map<number, WithFilterEpoch<ColumnAggregationVariant> | null> = new Map();
    let newFilteredColumnAggregatesOutdated = tableState.filteredColumnAggregatesOutdated;

    if (filterTable == null && tableState.dataSearchTable == null) {
        // Clear column aggregates - track existing ones for release
        for (let columnId = 0; columnId < tableState.filteredColumnAggregates.length; ++columnId) {
            const prevAggregate = tableState.filteredColumnAggregates[columnId];
            if (prevAggregate != null) {
                obsoleteFilteredColumnAggregates.set(columnId, prevAggregate);
            }
        }
        newFilteredColumnAggregatesOutdated = Array.from({ length: tableState.filteredColumnAggregatesOutdated.length }, () => false);

    } else {
        newFilteredColumnAggregatesOutdated = getFilteredColumnAggregatesOutdated(tableState, tableState.dataSearchTable, filterTable);
    }

    // When the filter is cleared, release obsolete aggregates and clear the state.
    // When the filter is active, we deliberately keep old aggregates until new ones are computed.
    // We use the filter epoch to determine that an aggregate is not yet updated.
    let newFilteredColumnAggregates = tableState.filteredColumnAggregates;
    if (filterTable == null && tableState.dataSearchTable == null) {
        // Release all obsolete filtered column aggregates
        for (const [, prevAggregate] of obsoleteFilteredColumnAggregates.entries()) {
            releaseColumnAggregate(prevAggregate, memory);
        }
        // Clear the filtered column aggregates array
        newFilteredColumnAggregates = Array.from({ length: tableState.filteredColumnAggregates.length }, () => null);
    }

    memory.release(tableState.filterTable?.dataFrame);
    memory.release(tableState.orderingTable?.dataFrame);
    return {
        ...state,
        tableComputations: {
            ...state.tableComputations,
            [tableId]: {
                ...tableState,
                // Don't increment version here - it was already incremented when scheduling the task
                // The filterTable.version should match the task's target version
                filterTable,
                orderingTable: null,
                filteredColumnAggregates: newFilteredColumnAggregates,
                filteredColumnAggregatesOutdated: newFilteredColumnAggregatesOutdated,
                tasks: {
                    ...tableState.tasks,
                    filteringTask,
                }
            }
        },
    };
}

function getFilteredColumnAggregatesOutdated(
    tableState: TableComputationState,
    dataSearchTable: DataSearchTable | null,
    filterTable: FilterTable | null = tableState.filterTable,
): boolean[] {
    if (filterTable == null && dataSearchTable == null) {
        return Array.from({ length: tableState.filteredColumnAggregatesOutdated.length }, () => false);
    }
    const outdated = [...tableState.filteredColumnAggregatesOutdated];
    const targetVersion = filterTable?.version ?? tableState.version;
    for (let columnId = 0; columnId < tableState.columnGroups.length; ++columnId) {
        const columnEntry = tableState.columnGroups[columnId];
        if (columnEntry.type == SKIPPED_COLUMN || columnEntry.type == ROWNUMBER_COLUMN || columnEntry.type == LIST_COLUMN) {
            outdated[columnId] = false;
            continue;
        }
        const unfilteredAggregate = tableState.columnAggregates[columnId];
        const previous = tableState.filteredColumnAggregates[columnId];
        outdated[columnId] = unfilteredAggregate != null && !(
            previous?.filterVersion.filterMatches(targetVersion)
            && previous.dataSearchRequestId === (dataSearchTable?.requestId ?? null)
        );
    }
    return outdated;
}

/// Acquire a column aggregate
function acquireColumnAggregate(aggregate: ColumnAggregationVariant | null | undefined, memory: DataFrameRegistry, times: number = 1) {
    if (aggregate == null || aggregate == undefined) {
        return;
    }
    switch (aggregate.type) {
        case ORDINAL_COLUMN:
            memory.acquire(aggregate.value.binnedDataFrame, times);
            break;
        case STRING_COLUMN:
            memory.acquire(aggregate.value.frequentValuesDataFrame, times);
            break;
        case LIST_COLUMN:
            memory.acquire(aggregate.value.frequentValuesDataFrame, times);
            break;
        case SKIPPED_COLUMN:
            break;
    }
}

/// Helper to release memory of a column aggregate
function releaseColumnAggregate(aggregate: ColumnAggregationVariant | null | undefined, memory: DataFrameRegistry) {
    if (aggregate == null || aggregate == undefined) {
        return;
    }
    switch (aggregate.type) {
        case ORDINAL_COLUMN:
            memory.release(aggregate.value.binnedDataFrame);
            break;
        case STRING_COLUMN:
            memory.release(aggregate.value.frequentValuesDataFrame);
            break;
        case LIST_COLUMN:
            memory.release(aggregate.value.frequentValuesDataFrame);
            break;
        case SKIPPED_COLUMN:
            break;
    }
}

/// Helper to release memory of column aggregates
function releaseColumnAggregates(aggregates: (ColumnAggregationVariant | null)[], dataFrameMemory: DataFrameRegistry) {
    for (const aggregate of aggregates) {
        if (aggregate != null) {
            releaseColumnAggregate(aggregate, dataFrameMemory);
        }
    }
}

/// Helper to destroy state of a table
function destroyTableComputationState(state: TableComputationState, memory: DataFrameRegistry) {
    state.dataTableLifetime.abort();
    // Release data frames
    memory.release(state.dataFrame);
    memory.release(state.filterTable?.dataFrame);
    memory.release(state.dataSearchTable?.dataFrame);
    memory.release(state.orderingTable?.dataFrame);
    memory.release(state.tableAggregation?.dataFrame);
    releaseColumnAggregates(state.columnAggregates, memory);
    releaseColumnAggregates(state.filteredColumnAggregates, memory);

    // Release data frames from tasks
    memory.release(state.tasks.filteringTask?.inputDataFrame);
    memory.release(state.tasks.orderingTask?.inputDataFrame);
    memory.release(state.tasks.orderingTask?.filterTable?.dataFrame);
    memory.release(state.tasks.orderingTask?.dataSearchTable?.dataFrame);
    memory.release(state.tasks.dataSearchTask?.inputDataFrame);
    memory.release(state.tasks.tableAggregationTask?.inputDataFrame);
    memory.release(state.tasks.systemColumnTask?.inputDataFrame);
    memory.releaseMany(state.tasks.columnAggregationTasks.map(task => task?.inputDataFrame));
    for (const task of state.tasks.filteredColumnAggregationTasks) {
        memory.release(task?.filterTable?.dataFrame);
        memory.release(task?.dataSearchTable?.dataFrame);
        releaseColumnAggregate(task?.unfilteredAggregate ?? null, memory);
    }
}
