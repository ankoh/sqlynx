import * as React from 'react';

import type { QueryExecutionState } from '../../../connections/query_execution_state.js';
import { useComputationRegistry } from '../../../../../compute/computation_registry.js';
import type { ComputationAction, TableComputationState } from '../../../../../compute/computation_state.js';
import type { Dispatch } from '../../../../../utils/variant.js';
import { QueryResultSearchControls } from './query_result_search_controls.js';
import { useQueryResultSearch } from './use_query_result_search.js';

interface Props {
    query: QueryExecutionState;
    children?: React.ReactNode;
}

export function QueryResultToolbar(props: Props): React.ReactNode {
    const [computationState, dispatch] = useComputationRegistry();
    const table = computationState.tableComputations[props.query.queryId] ?? null;
    return <TableSearchToolbar table={table} dispatch={dispatch}>{props.children}</TableSearchToolbar>;
}

interface TableSearchToolbarProps {
    table: TableComputationState | null;
    dispatch: Dispatch<ComputationAction>;
    children?: React.ReactNode;
}

/// The column and data search of any analyzed table, not only of query results
export function TableSearchToolbar(props: TableSearchToolbarProps) {
    const { table, dispatch } = props;
    const search = useQueryResultSearch(table, dispatch);
    if (search.columnSearch == null || search.dataSearch == null) return props.children;
    const dataMatchCount = getMatchingRowCount(table);
    return (
        <>
            <QueryResultSearchControls
                columnSearch={search.columnSearch}
                dataSearch={search.dataSearch}
                onColumnPatternChange={search.setColumnPattern}
                onDataPatternChange={search.setDataPattern}
                columnMatchCount={search.columnSearch.matchingColumnGroups?.length ?? null}
                dataMatchCount={dataMatchCount}
            />
            {props.children}
        </>
    );
}

export function useQueryResultRowCounts(query: QueryExecutionState | null) {
    const [computationState] = useComputationRegistry();
    const table = query == null ? null : computationState.tableComputations[query.queryId] ?? null;
    const totalRows = table?.dataTable.numRows ?? null;
    const currentRows = getMatchingRowCount(table) ?? table?.filterTable?.dataTable.numRows ?? totalRows;
    const matchingRows = getMatchingRowCount(table);
    return { totalRows, currentRows, matchingRows };
}

export function getMatchingRowCount(table: ReturnType<typeof useComputationRegistry>[0]['tableComputations'][number] | null): number | null {
    const dataMatches = table?.dataSearch?.matchingRows;
    if (table == null || dataMatches == null) return null;
    if (table.filterTable == null) return dataMatches.size;
    const rowIds = table.filterTable.dataTable.getChildAt(0);
    if (rowIds == null) return 0;
    let count = 0;
    for (let i = 0; i < rowIds.length; ++i) {
        if (dataMatches.has(Number(rowIds.get(i)))) ++count;
    }
    return count;
}
