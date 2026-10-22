import * as arrow from 'apache-arrow';

import { CancelQuery, QueryExecutor } from '../connections/query_executor.js';
import { QueryType } from '../connections/query_execution_state.js';
import type { DashQLShellEnvironment } from '../../../shell/api.js';
import {
    shouldShowResultUI,
    type ShellOutputMode,
} from '../../../shell/shell_result.js';

const EMPTY_RESULT_IPC = arrow.tableToIPC(arrow.tableFromArrays({}), 'file');

export function createNotebookShellEnvironment(
    notebookId: string,
    connectionId: string,
    executeQuery: QueryExecutor,
    cancelQuery: CancelQuery,
    getOutputMode: () => ShellOutputMode = () => 'auto',
    getTerminalColumns: () => number = () => 100,
): DashQLShellEnvironment {
    return {
        async executeQuery(query, signal, onProgress, onResult, onTiming) {
            const reportTiming = (label: string, elapsedMs: number) => {
                try {
                    onTiming?.(label, elapsedMs);
                } catch {
                    // Timing observers must not interrupt query execution.
                }
            };
            const [queryId, execution] = executeQuery(connectionId, {
                query,
                analyzeResults: true,
                cacheable: false,
                throwOnError: true,
                onLog: onProgress,
                onTiming: reportTiming,
                metadata: {
                    queryType: QueryType.USER_PROVIDED,
                    title: 'Shell Query',
                    description: null,
                    issuer: 'DashQL Shell',
                    userProvided: true,
                    notebookId,
                },
            });
            const abort = () => cancelQuery(connectionId, queryId);
            if (signal?.aborted) {
                abort();
            } else {
                signal?.addEventListener('abort', abort, { once: true });
            }
            try {
                const table = await execution;
                if (table == null) {
                    if (signal?.aborted) throw new DOMException('Query was cancelled', 'AbortError');
                    throw new Error('Query failed without an error');
                }
                const outputStartedAt = performance.now();
                try {
                    const outputMode = getOutputMode();
                    if (table.numCols > 0 && shouldShowResultUI(outputMode, table, getTerminalColumns())) {
                        onResult?.(queryId, table.numRows);
                        return EMPTY_RESULT_IPC;
                    }
                    if (outputMode === 'off') return EMPTY_RESULT_IPC;
                    return arrow.tableToIPC(table, 'file');
                } finally {
                    reportTiming('Postprocess', performance.now() - outputStartedAt);
                }
            } finally {
                signal?.removeEventListener('abort', abort);
            }
        },
    };
}
