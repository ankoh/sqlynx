import * as arrow from 'apache-arrow';

import {
    QUERY_PROCESSED_RESULTS,
    QUERY_PROCESSING_RESULTS,
    QUERY_RECEIVED_ALL_BATCHES,
    createQueryResponseStreamMetrics,
    type QueryExecutionTracker,
} from '../query/query_execution_state.js';
import type { EmbeddedConnection } from '../platform/database/embedded_database.js';
import { DashQLShellEnvironment } from '../shell/api.js';
import { executeTrackedQuery } from '../query/tracked_query_execution.js';
import { EMPTY_RESULT_IPC, reportShellTiming, SHELL_QUERY_METADATA, shouldShowResultUI, type ShellOutputMode } from '../shell/shell_result.js';

interface EmbeddedDatabaseShellEnvironmentOptions {
    getOutputMode?: () => ShellOutputMode;
    getTerminalColumns?: () => number;
    prepareResult?: (queryId: number, table: arrow.Table) => void | Promise<void>;
}

export function createEmbeddedDatabaseShellEnvironment(
    connection: EmbeddedConnection,
    queryExecutions?: QueryExecutionTracker,
    options: EmbeddedDatabaseShellEnvironmentOptions = {},
): DashQLShellEnvironment {
    return {
        executeQuery: async (query, signal, onProgress, onResult, onTiming) => {
            const reportTiming = (label: string, elapsedMs: number) => reportShellTiming(onTiming, label, elapsedMs);
            const cancellation = new AbortController();
            const abort = () => cancellation.abort();
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            const tracker = queryExecutions ?? { dispatch: () => {} };
            try {
                return await executeTrackedQuery({
                    query,
                    tracker,
                    cancellation,
                    errorTarget: 'standalone_shell',
                    metadata: { ...SHELL_QUERY_METADATA },
                    execute: async tracked => {
                        onProgress?.('Executing query');
                        const queryStartedAt = performance.now();
                        let queryResult = await connection.queryArrowIPC(query, cancellation.signal);
                        reportTiming('Results', performance.now() - queryStartedAt);
                        cancellation.signal.throwIfAborted();
                        const postprocessingStartedAt = performance.now();
                        try {
                            const totalDataBytesReceived = queryResult.byteLength;
                            if (queryResult.byteLength === 0) {
                                queryResult = EMPTY_RESULT_IPC;
                            }
                            const table = arrow.tableFromIPC(queryResult);
                            const metrics = createQueryResponseStreamMetrics();
                            metrics.totalDataBytesReceived = totalDataBytesReceived;
                            metrics.totalBatchesReceived = table.batches.length;
                            metrics.totalRowsReceived = table.numRows;
                            tracked.dispatch({
                                type: QUERY_RECEIVED_ALL_BATCHES,
                                value: [tracked.queryId, table, new Map(), metrics],
                            });
                            const outputMode = options.getOutputMode?.() ?? 'auto';
                            const showUI = shouldShowResultUI(
                                outputMode,
                                table,
                                options.getTerminalColumns?.() ?? 100,
                            );
                            if (showUI && table.numCols > 0 && onResult != null) {
                                if (options.prepareResult != null) {
                                    tracked.dispatch({
                                        type: QUERY_PROCESSING_RESULTS,
                                        value: [tracked.queryId],
                                    });
                                    await options.prepareResult(tracked.queryId, table);
                                    cancellation.signal.throwIfAborted();
                                    tracked.dispatch({
                                        type: QUERY_PROCESSED_RESULTS,
                                        value: [tracked.queryId],
                                    });
                                }
                                onResult(tracked.queryId, table.numRows);
                                return EMPTY_RESULT_IPC;
                            }
                            if (outputMode === 'off') return EMPTY_RESULT_IPC;
                            return queryResult;
                        } finally {
                            reportTiming('Postprocess', performance.now() - postprocessingStartedAt);
                        }
                    },
                });
            } finally {
                signal?.removeEventListener('abort', abort);
            }
        },
    };
}
