import * as React from 'react';

import { CLEAR_TABLE_ORDERING, type ComputationAction, type TableComputationState } from '../../../../../compute/computation_state.js';
import { sortTableDispatched } from '../../../../../compute/computation_logic.js';
import type { TableOrderingTask } from '../../../../../compute/computation_types.js';
import { TaskStatus } from '../../../../../compute/computation_types.js';
import type { OrderByConstraint } from '../../../../../compute/sql/sqlframe_builder.js';
import type { Dispatch } from '../../../../../utils/variant.js';

export function getColumnSortDirection(field: string, ordering: OrderByConstraint[]): boolean | null {
    if (ordering.length !== 1 || ordering[0].field !== field) return null;
    return ordering[0].ascending ?? true;
}

export function getNextColumnSortDirection(field: string, ordering: OrderByConstraint[]): boolean | null {
    const currentDirection = getColumnSortDirection(field, ordering);
    if (currentDirection == null) return true;
    return currentDirection ? false : null;
}

function areOrderingConstraintsEqual(left: OrderByConstraint[], right: OrderByConstraint[]): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; ++i) {
        const a = left[i];
        const b = right[i];
        if (
            a.field !== b.field
            || (a.ascending ?? true) !== (b.ascending ?? true)
            || (a.nullsFirst ?? false) !== (b.nullsFirst ?? false)
        ) {
            return false;
        }
    }
    return true;
}

function createOrderingTask(
    table: TableComputationState,
    orderingConstraints: OrderByConstraint[],
): TableOrderingTask | null {
    if (!table.dataFrame || !table.rowNumberColumnName) return null;
    return {
        tableId: table.tableId,
        tableVersion: table.version,
        inputDataTable: table.dataTable,
        inputDataTableFieldIndex: table.dataTableFieldsByName,
        inputDataFrame: table.dataFrame,
        filterTable: table.filterTable,
        dataSearchTable: table.dataSearchTable,
        rowNumberColumnName: table.rowNumberColumnName,
        orderingConstraints,
    };
}

export function useDataTableOrdering(
    table: TableComputationState,
    dispatchComputation: Dispatch<ComputationAction>,
) {
    const activeOrderingConstraints = React.useMemo<OrderByConstraint[]>(() => {
        const taskOrdering = table.tasks.orderingTask?.orderingConstraints;
        return taskOrdering != null && taskOrdering.length > 0 ? taskOrdering : table.dataTableOrdering;
    }, [table.dataTableOrdering, table.tasks.orderingTask?.orderingConstraints]);

    React.useEffect(() => {
        if (activeOrderingConstraints.length === 0) return;
        const orderingTask = createOrderingTask(table, activeOrderingConstraints);
        if (orderingTask == null) return;

        const currentTask = table.tasks.orderingTask;
        const currentOrdering = table.orderingTable;
        const filterVersion = table.filterTable?.version ?? null;
        const dataSearchRequestId = table.dataSearchTable?.requestId ?? null;
        const taskMatchesInput = currentTask?.tableVersion.filterMatches(table.version)
            && (filterVersion
                ? (currentTask.filterTable?.version?.filterMatches(filterVersion) ?? false)
                : currentTask.filterTable === null)
            && (currentTask.dataSearchTable?.requestId ?? null) === dataSearchRequestId;
        const hasUpToDateOrdering = currentOrdering != null
            && currentTask?.progress.status === TaskStatus.TASK_SUCCEEDED
            && taskMatchesInput
            && areOrderingConstraintsEqual(currentOrdering.orderingConstraints, activeOrderingConstraints);
        const hasUpToDateRunningTask = currentTask?.progress.status === TaskStatus.TASK_RUNNING
            && taskMatchesInput
            && areOrderingConstraintsEqual(currentTask.orderingConstraints, activeOrderingConstraints);
        if (hasUpToDateOrdering || hasUpToDateRunningTask) return;
        void sortTableDispatched(orderingTask, dispatchComputation);
    }, [activeOrderingConstraints, table, dispatchComputation]);

    const orderByColumn = React.useCallback((fieldId: number) => {
        const fieldName = table.dataTable.schema.fields[fieldId].name;
        const nextSortDirection = getNextColumnSortDirection(fieldName, activeOrderingConstraints);
        if (nextSortDirection == null) {
            dispatchComputation({ type: CLEAR_TABLE_ORDERING, value: table.tableId });
            return;
        }
        const orderingTask = createOrderingTask(table, [{
            field: fieldName,
            ascending: nextSortDirection,
            nullsFirst: false,
        }]);
        if (orderingTask != null) void sortTableDispatched(orderingTask, dispatchComputation);
    }, [activeOrderingConstraints, table, dispatchComputation]);

    const getSortDirection = React.useCallback((fieldId: number) => {
        const fieldName = table.dataTable.schema.fields[fieldId].name;
        return getColumnSortDirection(fieldName, activeOrderingConstraints);
    }, [activeOrderingConstraints, table.dataTable.schema.fields]);

    return { orderByColumn, getSortDirection };
}
