import * as arrow from 'apache-arrow';

import { CancelQuery, QueryExecutor } from '../../connections/query_executor.js';
import type { DashQLShellEnvironment } from '../../../shell/api.js';
import {
    EMPTY_RESULT_IPC,
    reportShellTiming,
    SHELL_QUERY_METADATA,
    shouldShowResultUI,
    type ShellOutputMode,
} from '../../../shell/shell_result.js';

export function createSessionShellEnvironment(
    sessionId: string,
    connectionId: string,
    executeQuery: QueryExecutor,
    cancelQuery: CancelQuery,
    getOutputMode: () => ShellOutputMode = () => 'auto',
    getTerminalColumns: () => number = () => 100,
): DashQLShellEnvironment {
    return {
        async executeQuery(query, signal, onProgress, onResult, onTiming) {
            const reportTiming = (label: string, elapsedMs: number) => reportShellTiming(onTiming, label, elapsedMs);
            const [queryId, execution] = executeQuery(connectionId, {
                query,
                analyzeResults: true,
                cacheable: false,
                throwOnError: true,
                onLog: onProgress,
                onTiming: reportTiming,
                metadata: { ...SHELL_QUERY_METADATA, sessionId },
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
