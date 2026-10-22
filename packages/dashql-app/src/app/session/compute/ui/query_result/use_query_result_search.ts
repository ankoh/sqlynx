import * as arrow from 'apache-arrow';
import * as React from 'react';

import {
    COLUMN_SEARCH_SUCCEEDED,
    RESULT_SEARCH_FAILED,
    SET_RESULT_SEARCH_PATTERN,
    type ComputationAction,
    type TableComputationState,
} from '../../../../../compute/computation_state.js';
import {
    buildColumnSearchSQL,
    collectSearchableResultColumns,
    parseColumnSearchMatches,
} from '../../../../../compute/sql/query_result_search_sql.js';
import type { Dispatch } from '../../../../../utils/variant.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../../../platform/logger/logger.js';
import { useDataFrameRegistry } from '../../../../../compute/computation_registry.js';
import { searchDataDispatched } from '../../../../../compute/computation_logic.js';

const LOG_CTX = 'query_result_search';

interface SearchExecution {
    requestId: number;
    sourceDataFrame: object;
    abort: AbortController;
}

interface SearchExecutions {
    columns: SearchExecution | null;
    data: SearchExecution | null;
}

const executionsByDispatch = new WeakMap<object, Map<number, SearchExecutions>>();

function getExecutions(dispatch: Dispatch<ComputationAction>, tableId: number): SearchExecutions {
    const owner = dispatch as object;
    let executions = executionsByDispatch.get(owner);
    if (executions == null) {
        executions = new Map();
        executionsByDispatch.set(owner, executions);
    }
    let tableExecutions = executions.get(tableId);
    if (tableExecutions == null) {
        tableExecutions = { columns: null, data: null };
        executions.set(tableId, tableExecutions);
    }
    return tableExecutions;
}

export function useQueryResultSearch(
    table: TableComputationState | null,
    dispatch: Dispatch<ComputationAction>,
) {
    const logger = useLogger();
    const dataFrameMemory = useDataFrameRegistry();
    const columns = React.useMemo(
        () => collectSearchableResultColumns(table?.columnGroups ?? []),
        [table?.columnGroups],
    );

    React.useEffect(() => {
        if (table == null || table.dataFrame == null) return;
        const search = table.columnSearch;
        const executions = getExecutions(dispatch, table.tableId);
        if (search.requestedPattern.length === 0) {
            executions.columns?.abort.abort();
            executions.columns = null;
            return;
        }
        if (search.requestId === search.appliedRequestId) return;
        if (table.dataTableLifetime.signal.aborted) return;

        const sql = buildColumnSearchSQL(columns, search.requestedPattern);
        if (sql == null) {
            dispatch({
                type: COLUMN_SEARCH_SUCCEEDED,
                value: [table.tableId, table.dataFrame, search.requestId, []],
            });
            return;
        }

        if (executions.columns?.requestId === search.requestId && executions.columns.sourceDataFrame === table.dataFrame) return;
        executions.columns?.abort.abort();
        const execution = { requestId: search.requestId, sourceDataFrame: table.dataFrame, abort: new AbortController() };
        executions.columns = execution;
        const abortForTableLifetime = () => execution.abort.abort(table.dataTableLifetime.signal.reason);
        table.dataTableLifetime.signal.addEventListener('abort', abortForTableLifetime, { once: true });
        dataFrameMemory.acquire(table.dataFrame);
        void (async () => {
            try {
                const result = await table.dataFrame!.withConnection(async connection => {
                    const bytes = await connection.queryArrowIPC(sql, execution.abort.signal);
                    return new arrow.Table(arrow.RecordBatchReader.from(bytes));
                });
                dispatch({
                    type: COLUMN_SEARCH_SUCCEEDED,
                    value: [table.tableId, table.dataFrame!, search.requestId, parseColumnSearchMatches(result)],
                });
            } catch (error) {
                if (execution.abort.signal.aborted) return;
                logger.warn('Column search failed', { error: stringifyError(error) }, LOG_CTX);
                dispatch({
                    type: RESULT_SEARCH_FAILED,
                    value: [table.tableId, table.dataFrame!, 'columns', search.requestId, stringifyError(error)],
                });
            } finally {
                table.dataTableLifetime.signal.removeEventListener('abort', abortForTableLifetime);
                dataFrameMemory.release(table.dataFrame);
                if (executions.columns === execution) executions.columns = null;
            }
        })();
    }, [columns, dataFrameMemory, dispatch, logger, table?.columnSearch?.requestId, table?.dataFrame, table?.tableId]);

    React.useEffect(() => {
        if (table == null || table.dataFrame == null || table.rowNumberColumnName == null) return;
        const search = table.dataSearch;
        const executions = getExecutions(dispatch, table.tableId);
        if (search.requestedPattern.length === 0) {
            executions.data?.abort.abort();
            executions.data = null;
            return;
        }
        if (search.requestId === search.appliedRequestId) return;
        if (table.dataTableLifetime.signal.aborted) return;

        if (executions.data?.requestId === search.requestId && executions.data.sourceDataFrame === table.dataFrame) return;
        executions.data?.abort.abort();
        const execution = { requestId: search.requestId, sourceDataFrame: table.dataFrame, abort: new AbortController() };
        executions.data = execution;
        const abortForTableLifetime = () => execution.abort.abort(table.dataTableLifetime.signal.reason);
        table.dataTableLifetime.signal.addEventListener('abort', abortForTableLifetime, { once: true });
        void (async () => {
            try {
                await searchDataDispatched({
                    tableId: table.tableId,
                    tableVersion: table.version,
                    inputDataFrame: table.dataFrame!,
                    rowNumberColumnName: table.rowNumberColumnName!,
                    columns,
                    pattern: search.requestedPattern,
                    requestId: search.requestId,
                    abortController: execution.abort,
                }, dispatch);
            } catch (error) {
                if (!execution.abort.signal.aborted) {
                    logger.warn('Data search failed', { error: stringifyError(error) }, LOG_CTX);
                }
            } finally {
                table.dataTableLifetime.signal.removeEventListener('abort', abortForTableLifetime);
                if (executions.data === execution) executions.data = null;
            }
        })();
    }, [columns, dispatch, logger, table?.dataSearch?.requestId, table?.dataFrame, table?.rowNumberColumnName, table?.tableId, table?.version]);

    const setColumnPattern = React.useCallback((pattern: string) => {
        if (table != null) {
            dispatch({ type: SET_RESULT_SEARCH_PATTERN, value: [table.tableId, 'columns', pattern] });
        }
    }, [dispatch, table?.tableId]);
    const setDataPattern = React.useCallback((pattern: string) => {
        if (table != null) {
            dispatch({ type: SET_RESULT_SEARCH_PATTERN, value: [table.tableId, 'data', pattern] });
        }
    }, [dispatch, table?.tableId]);

    return {
        columnSearch: table?.columnSearch ?? null,
        dataSearch: table?.dataSearch ?? null,
        setColumnPattern,
        setDataPattern,
    };
}
