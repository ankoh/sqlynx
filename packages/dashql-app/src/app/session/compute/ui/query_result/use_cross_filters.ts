import * as React from 'react';

import { ComputationAction, SET_CROSS_FILTERS, TableComputationState } from '../../../../../compute/computation_state.js';
import { CrossFilters } from '../../../../../compute/cross_filters.js';
import { Dispatch } from '../../../../../utils/variant.js';
import { FILTERED_COLUMN_AGGREGATION_TASK, TABLE_FILTERING_TASK, ORDINAL_COLUMN, STRING_COLUMN, OrdinalColumnAggregation, StringColumnAggregation, TableAggregation, TableFilteringTask, TaskStatus, WithFilter, ColumnAggregationTask, DataSearchTable, FilterTable } from '../../../../../compute/computation_types.js';
import { ScalarFilter } from '../../../../../compute/sql/sqlframe_builder.js';
import { HistogramFilterCallback } from './histogram_cell.js';
import { MostFrequentValueFilterCallback } from './mostfrequent_cell.js';
import { DataTableLayout } from './data_table_layout.js';
import { scheduleTask } from '../../../../../compute/computation_logic.js';
import { forEachIntegerValue } from './visible_rows.js';

/// Compare two scalar filter lists for equality.
function scalarFiltersEqual(left: ScalarFilter[], right: ScalarFilter[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let i = 0; i < left.length; ++i) {
        const a = left[i];
        const b = right[i];
        if (a.fieldName !== b.fieldName || a.op !== b.op || a.value !== b.value) {
            return false;
        }
    }
    return true;
}

const pendingSchedules = new WeakMap<object, Set<string>>();

interface PendingFilterTask {
    key: string;
    task: TableFilteringTask;
}

interface FilterTaskQueue {
    activeKey: string | null;
    pending: PendingFilterTask | null;
}

const filterTaskQueues = new WeakMap<object, Map<number, FilterTaskQueue>>();

/// Effects in separate consumers can run from the same state snapshot. Keep a task key
/// reserved until the scheduled operation settles so only the first consumer schedules it.
function claimSchedule(dispatch: Dispatch<ComputationAction>, key: string): (() => void) | null {
    const owner = dispatch as object;
    let schedules = pendingSchedules.get(owner);
    if (schedules == null) {
        schedules = new Set();
        pendingSchedules.set(owner, schedules);
    }
    if (schedules.has(key)) {
        return null;
    }
    schedules.add(key);
    return () => schedules!.delete(key);
}

function scalarFiltersKey(filters: ScalarFilter[]): string {
    return filters.map(filter => `${filter.fieldName}\u0000${filter.op}\u0000${filter.value}`).join('\u0001');
}

/// Run at most one filter task per table and retain only the newest request that arrives
/// while it is running. Stale brush positions never enter the scheduler.
function scheduleLatestFilter(
    dispatch: Dispatch<ComputationAction>,
    key: string,
    task: TableFilteringTask,
): void {
    const owner = dispatch as object;
    let queues = filterTaskQueues.get(owner);
    if (queues == null) {
        queues = new Map();
        filterTaskQueues.set(owner, queues);
    }
    let queue = queues.get(task.tableId);
    if (queue == null) {
        queue = { activeKey: null, pending: null };
        queues.set(task.tableId, queue);
    }

    if (queue.activeKey === key) {
        queue.pending = null;
        return;
    }
    if (queue.pending?.key === key) {
        return;
    }
    if (queue.activeKey != null) {
        queue.pending = { key, task };
        return;
    }

    const launch = (request: PendingFilterTask) => {
        queue!.activeKey = request.key;
        void scheduleTask(TABLE_FILTERING_TASK, request.task, dispatch).finally(() => {
            queue!.activeKey = null;
            const pending = queue!.pending;
            queue!.pending = null;
            if (pending != null) {
                launch(pending);
            } else {
                queues!.delete(request.task.tableId);
            }
        });
    };
    launch({ key, task });
}

export interface CrossFilterController {
    /// The active cross-filter selection (shared, read from the computation state)
    crossFilters: CrossFilters;
    /// Toggle/update a histogram filter for a column
    histogramFilter: HistogramFilterCallback;
    /// Toggle/update a most-frequent-value filter for a column
    mostFrequentValueFilter: MostFrequentValueFilterCallback;
    /// Request a filtered column aggregation for a column group
    requestFilteredColumnAggregation: (columnId: number) => void;
}

/// Cross-filter controller shared by every view of a table (the result table header
/// plots and the visualization tab's aggregation bar).
///
/// The selection lives on the shared `TableComputationState.crossFilters`, so brushing
/// in any consumer updates the single selection and drives one `filterTable`. The
/// filtering effect below is guarded so that mounting this hook from multiple consumers
/// at once (e.g. the Data and Visualization tabs in split mode) does not schedule
/// duplicate filtering tasks.
export function useCrossFilters(
    computationState: TableComputationState | null,
    dispatchComputation: Dispatch<ComputationAction>,
    gridLayout: DataTableLayout,
): CrossFilterController {
    const crossFilters = computationState?.crossFilters ?? EMPTY_CROSS_FILTERS;
    const tableId = computationState?.tableId ?? null;

    // Keep the callbacks stable by reading layout / column groups / state through refs.
    const gridLayoutRef = React.useRef(gridLayout);
    const columnGroupsRef = React.useRef(computationState?.columnGroups ?? EMPTY_COLUMN_GROUPS);
    const crossFiltersRef = React.useRef(crossFilters);
    const stateRef = React.useRef(computationState);
    gridLayoutRef.current = gridLayout;
    columnGroupsRef.current = computationState?.columnGroups ?? EMPTY_COLUMN_GROUPS;
    crossFiltersRef.current = crossFilters;
    stateRef.current = computationState;

    const histogramFilter: HistogramFilterCallback = React.useCallback((_table: TableAggregation, columnIndex: number, _column: OrdinalColumnAggregation, brush: [number, number] | null) => {
        if (tableId == null) {
            return;
        }
        const columnGroupId = gridLayoutRef.current.columnGroupByColumnIndex[columnIndex];
        const columnGroup = columnGroupsRef.current[columnGroupId];
        if (columnGroup == null || columnGroup.type != ORDINAL_COLUMN) {
            return;
        }
        const current = crossFiltersRef.current;
        if (current.containsHistogramFilter(columnGroupId, brush)) {
            return;
        }
        const cloned = current.clone();
        cloned.addHistogramFilter(columnGroupId, columnGroup.value, brush);
        dispatchComputation({ type: SET_CROSS_FILTERS, value: [tableId, cloned] });
    }, [dispatchComputation, tableId]);

    const mostFrequentValueFilter: MostFrequentValueFilterCallback = React.useCallback((_table: TableAggregation, columnIndex: number, _column: StringColumnAggregation, frequentValueId: number | null) => {
        if (tableId == null) {
            return;
        }
        const columnGroupId = gridLayoutRef.current.columnGroupByColumnIndex[columnIndex];
        const columnGroup = columnGroupsRef.current[columnGroupId];
        if (columnGroup == null || columnGroup.type != STRING_COLUMN || columnGroup.value.valueIdFieldName == null) {
            return;
        }
        const current = crossFiltersRef.current;
        const nextValueId = current.containsMostFrequentValueFilter(columnGroupId, frequentValueId)
            ? null
            : frequentValueId;
        const cloned = current.clone();
        cloned.addMostFrequentValueFilter(columnGroupId, columnGroup.value, nextValueId);
        dispatchComputation({ type: SET_CROSS_FILTERS, value: [tableId, cloned] });
    }, [dispatchComputation, tableId]);

    const crossFilterTransforms = React.useMemo(
        () => crossFilters.createFilterTransforms(),
        [crossFilters],
    );

    // Filter the immutable base table whenever cross-filters change.
    // Guarded so concurrent consumers of the shared selection don't double-schedule.
    React.useEffect(() => {
        if (!computationState || !computationState.dataFrame || !computationState.rowNumberColumnName) {
            return;
        }
        // Already reflected by the current filter table?
        const currentFilterFilters = computationState.tasks.filteringTask?.filters;
        const filterUpToDate =
            computationState.filterTable != null
            && computationState.filterTable.version.filterMatches(computationState.version)
            && currentFilterFilters != null
            && scalarFiltersEqual(currentFilterFilters, crossFilterTransforms);
        if (filterUpToDate) {
            return;
        }
        // Empty selection with no active filter table? Nothing to do.
        if (crossFilterTransforms.length === 0 && computationState.filterTable == null) {
            return;
        }
        // A filtering task for exactly these transforms is already running?
        const runningTask = computationState.tasks.filteringTask;
        const hasUpToDateRunningTask =
            runningTask?.progress.status === TaskStatus.TASK_RUNNING
            && runningTask.tableVersion.filterMatches(computationState.version)
            && scalarFiltersEqual(runningTask.filters, crossFilterTransforms);
        if (hasUpToDateRunningTask) {
            return;
        }
        const scheduleKey = `${computationState.version.toString()}:${scalarFiltersKey(crossFilterTransforms)}`;
        const filteringTask: TableFilteringTask = {
            tableId: computationState.tableId,
            tableVersion: computationState.version,
            inputDataTable: computationState.dataTable,
            inputDataTableFieldIndex: computationState.dataTableFieldsByName,
            inputDataFrame: computationState.dataFrame,
            filters: crossFilterTransforms,
            rowNumberColumnName: computationState.rowNumberColumnName,
        };
        scheduleLatestFilter(dispatchComputation, scheduleKey, filteringTask);
    }, [
        computationState?.dataFrame,
        computationState?.dataTable,
        computationState?.dataTableFieldsByName,
        computationState?.rowNumberColumnName,
        computationState?.tableId,
        computationState?.version,
        computationState?.filterTable,
        computationState?.tasks.filteringTask,
        crossFilterTransforms,
        dispatchComputation,
    ]);

    const requestFilteredColumnAggregation = React.useCallback((columnId: number) => {
        const state = stateRef.current;
        if (state == null) {
            return;
        }
        const tableAggregation = state.tableAggregation;
        const filterTable = state.filterTable;
        const dataSearchTable = state.dataSearchTable;
        const inputDataFrame = state.dataFrame;
        const columnEntry = state.columnGroups[columnId];
        const unfilteredAggregate = state.columnAggregates[columnId];
        if (
            tableAggregation == null
            || (filterTable == null && dataSearchTable == null)
            || inputDataFrame == null
            || columnEntry == null
            || unfilteredAggregate == null
        ) {
            return;
        }

        const currentTask = state.tasks.filteredColumnAggregationTasks[columnId];
        const hasUpToDateRunningTask = currentTask?.progress.status === TaskStatus.TASK_RUNNING
            && currentTask.tableVersion.filterMatches(state.version)
            && (currentTask.dataSearchTable?.requestId ?? null) === (dataSearchTable?.requestId ?? null);
        if (hasUpToDateRunningTask) {
            return;
        }

        const scheduleKey = `aggregate:${state.tableId}:${columnId}:${state.version.toString()}:${dataSearchTable?.requestId ?? ''}`;
        const releaseSchedule = claimSchedule(dispatchComputation, scheduleKey);
        if (releaseSchedule == null) {
            return;
        }

        const task: WithFilter<ColumnAggregationTask> = {
            tableId: state.tableId,
            tableVersion: filterTable?.version ?? state.version,
            columnId,
            tableAggregate: tableAggregation,
            columnEntry,
            inputDataFrame,
            filterTable,
            dataSearchTable,
            selectionRowCount: countSelectionRows(filterTable, dataSearchTable),
            unfilteredAggregate,
        };
        void scheduleTask(FILTERED_COLUMN_AGGREGATION_TASK, task, dispatchComputation).finally(releaseSchedule);
    }, [dispatchComputation]);

    return {
        crossFilters,
        histogramFilter,
        mostFrequentValueFilter,
        requestFilteredColumnAggregation,
    };
}

/// Selection row counts per filter table and data search table.
/// Weakly keyed by both Arrow tables, so a count never outlives the tables it was computed from.
const selectionRowCounts = new WeakMap<object, WeakMap<object, number>>();

function countSelectionRows(filterTable: FilterTable | null, dataSearchTable: DataSearchTable | null): number {
    if (filterTable == null) return dataSearchTable?.dataTable.numRows ?? 0;
    if (dataSearchTable == null) return filterTable.dataTable.numRows;
    let countsBySearch = selectionRowCounts.get(filterTable.dataTable);
    const cached = countsBySearch?.get(dataSearchTable.dataTable);
    if (cached !== undefined) return cached;
    const searchRows = dataSearchTable.dataTable.getChildAt(0);
    const filterRows = filterTable.dataTable.getChildAt(0);
    if (searchRows == null || filterRows == null) return 0;
    const matches = new Set<number>();
    forEachIntegerValue(searchRows, rowId => matches.add(rowId));
    let count = 0;
    forEachIntegerValue(filterRows, rowId => {
        if (matches.has(rowId)) ++count;
    });
    if (countsBySearch == null) {
        countsBySearch = new WeakMap();
        selectionRowCounts.set(filterTable.dataTable, countsBySearch);
    }
    countsBySearch.set(dataSearchTable.dataTable, count);
    return count;
}

const EMPTY_CROSS_FILTERS = new CrossFilters();
const EMPTY_COLUMN_GROUPS: TableComputationState['columnGroups'] = [];
