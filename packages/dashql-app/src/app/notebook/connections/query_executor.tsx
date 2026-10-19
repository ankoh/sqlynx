import * as arrow from 'apache-arrow';
import * as React from 'react';

import { findNotebookForAttachedDatabase, resolveNotebookExecutionDatabase, useAttachedDatabaseDispatch, useAttachedDatabaseRegistryStore, useDynamicAttachedDatabaseDispatch } from './attached_database_registry.js';
import {
    createQueryResponseStreamMetrics,
    QUERY_CACHE_RECORDED,
    QUERY_PROCESSING_RESULTS,
    QUERY_PROCESSED_RESULTS,
    QUERY_PROGRESS_UPDATED,
    QUERY_STATEMENT_STARTED,
    QUERY_STATEMENT_SUCCEEDED,
    QUERY_RECEIVED_ALL_BATCHES,
    QUERY_RECEIVED_BATCH,
    QueryExecutionResponseStream,
    QueryExecutionTracker,
} from '../../../query/query_execution_state.js';
import { useComputationDispatch } from '../../../compute/computation_registry.js';
import { analyzeTable } from '../../../compute/computation_logic.js';
import { DELETE_COMPUTATION } from '../../../compute/computation_state.js';
import { useComputeDatabase } from '../../../compute/compute_connection_provider.js';
import { useStorageReader } from '../persistence/storage_provider.js';
import { createNotebookQueryResultCache } from '../persistence/notebook_query_result_cache.js';
import type { CachedQueryResult } from '../../../query/query_result_cache.js';
import { getConnectionParamsFromStateDetails, createConnectionParamsSignature } from './connection_params.js';
import { ConnectionStateDetailsVariant } from './connection_state_details.js';
import { computeQueryResultCacheKey } from '../../../query/query_result_cache_key.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { createTrace, type TraceContext } from '../../../platform/logger/trace_context.js';
import { QueryExecutionArgs } from './query_execution_args.js';
import { LoggableException, stringifyError, type TracedLogger } from '../../../platform/logger/logger.js';
import type { LogRecord } from '../../../platform/logger/log_buffer.js';
import { allocateQueryId, executeTrackedQuery } from '../../../query/tracked_query_execution.js';
import { consumeQueryResponseStream, executeConnectionQuery } from './query_execution.js';
import { executeScriptQuery } from './script_query_execution.js';
import { yieldToBrowser } from '../../../utils/yield_to_browser.js';

const LOG_CTX = 'query_executor';

export function logQueryFailure(logger: TracedLogger, error: unknown, queryId: number, notebookId: string): void {
    if (error instanceof LoggableException) {
        logger.error(error.message, {
            ...error.keyValues,
            queryId: queryId.toString(),
            notebookId,
        }, error.target);
    } else {
        logger.error('Query failed with unknown error', {
            queryId: queryId.toString(),
            notebookId,
            raw: stringifyError(error),
        }, LOG_CTX);
    }
}

/// Compute the file-based cache key for a query against a connection, or null when the connection has
/// no recoverable params/signature (e.g. before setup completes). This is the same derivation the
/// executor uses on its cacheable path. Never throws — a failure to derive the key is reported as
/// null (treat as "not cacheable / a miss").
export async function computeQueryCacheKeyForConnection(
    details: ConnectionStateDetailsVariant,
    cacheSignature: string,
): Promise<string | null> {
    try {
        const params = getConnectionParamsFromStateDetails(details);
        const sig = params ? createConnectionParamsSignature(params) : null;
        if (sig == null) {
            return null;
        }
        return await computeQueryResultCacheKey(sig, cacheSignature);
    } catch {
        return null;
    }
}

/// The query executor function
export type QueryExecutor = (connectionId: string, args: QueryExecutionArgs) => [number, Promise<arrow.Table | null>];
export type CancelQuery = (connectionId: string, queryId: number) => Promise<void>;
interface QueryExecutionRuntime {
    cancellation: AbortController;
    resultStream: QueryExecutionResponseStream | null;
    execution: Promise<arrow.Table | null> | null;
}
/// The React context to resolve the active query executor
interface QueryExecutorContextValue {
    execute: QueryExecutor;
    cancel: CancelQuery;
}
const EXECUTOR_CTX = React.createContext<QueryExecutorContextValue | null>(null);
/// The hook to resolve the query executor
export const useQueryExecutor = () => React.useContext(EXECUTOR_CTX)!.execute;
export const useCancelQuery = () => React.useContext(EXECUTOR_CTX)!.cancel;
/// Use the query state
export function useQueryState(notebookId: string | null, queryId: number | null) {
    // Subscribe to the single query instead of the registry.
    // The registry changes with every lifecycle event of every query, including the internal queries of computations.
    const store = useAttachedDatabaseRegistryStore();
    const getQueryState = React.useCallback(() => {
        if (queryId == null) return null;
        const database = resolveNotebookExecutionDatabase(store.current, notebookId);
        return database?.queriesActive.get(queryId) ?? database?.queriesFinished.get(queryId) ?? null;
    }, [store, notebookId, queryId]);
    return React.useSyncExternalStore(store.subscribe, getQueryState);
}

function createConnectionQueryExecutionTracker(connectionId: string, dispatch: ReturnType<typeof useDynamicAttachedDatabaseDispatch>[1]): QueryExecutionTracker {
    return {
        dispatch: action => dispatch(connectionId, action),
    };
}

export function QueryExecutorProvider(props: { children?: React.ReactElement }) {
    const logger = useLogger();

    // The connection registry changes frequently.
    // This executor resolves everything ad-hoc through the registry store and never re-renders for registry changes.
    const connStore = useAttachedDatabaseRegistryStore();
    const connDispatch = useAttachedDatabaseDispatch();

    const computeDispatch = useComputationDispatch();
    const computeDb = useComputeDatabase();
    const storageReader = useStorageReader();
    const queryRuntimes = React.useRef(new Map<number, QueryExecutionRuntime>());

    // Execute a query with pre-allocated query id
    const executeImpl = React.useCallback(async (connectionId: string, args: QueryExecutionArgs, queryId: number, runtime: QueryExecutionRuntime, trace: TraceContext): Promise<arrow.Table | null> => {
        const traced = logger.withTrace(trace);
        if (!computeDb) {
            throw new Error(`Compute database is not yet ready`);
        }
        const conn = connStore.current.attachedDatabases.get(connectionId);
        if (!conn) {
            traced.error("Connection not configured", { connectionId, "query": queryId.toString() }, LOG_CTX);
            throw new Error(`Couldn't find a connection with id ${connectionId}`);
        }
        const notebookId = findNotebookForAttachedDatabase(connStore.current, connectionId);
        if (notebookId == null) {
            throw new Error(`Couldn't find a notebook for database ${connectionId}`);
        }
        const queryTracker = createConnectionQueryExecutionTracker(connectionId, connDispatch);
        const execution = await executeTrackedQuery({
            query: args.query,
            metadata: args.metadata,
            tracker: queryTracker,
            queryId,
            trace,
            cancellation: runtime.cancellation,
            autoStart: false,
            errorTarget: LOG_CTX,
            execute: async tracked => {
                const initialState = tracked.initialState;
                let queryExecutionStartedAt: number | null = null;
                let queryExecutionReported = false;
                const startQueryExecution = () => {
                    queryExecutionStartedAt = performance.now();
                };
                const reportQueryExecution = () => {
                    if (queryExecutionStartedAt == null || queryExecutionReported) return;
                    queryExecutionReported = true;
                    try {
                        args.onTiming?.('Results', performance.now() - queryExecutionStartedAt);
                    } catch {
                        // Timing observers must not interrupt query execution.
                    }
                };
                const measurePostprocessing = async (process: () => Promise<void>) => {
                    const startedAt = performance.now();
                    try {
                        await process();
                    } finally {
                        try {
                            args.onTiming?.('Postprocess', performance.now() - startedAt);
                        } catch {
                            // Timing observers must not interrupt query execution.
                        }
                    }
                };
                let resultsReady = false;
                const reportResultsReady = () => {
                    if (resultsReady) return;
                    resultsReady = true;
                    try {
                        args.onResultsReady?.();
                    } catch {
                        // Scheduler notifications must not interrupt query execution.
                    }
                };
                traced.info("Executing query", {
                    notebookId,
                    "query": queryId.toString(),
                    "text": args.query
                }, LOG_CTX);

                let cacheHash: string | null = null;
                if (args.cacheable && args.cacheSignature) {
                    cacheHash = await computeQueryCacheKeyForConnection(conn.details, args.cacheSignature);
                }
                const resultCache = cacheHash == null
                    ? null
                    : createNotebookQueryResultCache(storageReader.backend, notebookId);

                if (args.scriptExecution != null) {
                    try {
                        if (cacheHash != null) {
                            let cached: CachedQueryResult | null = null;
                            try {
                                cached = await resultCache!.load(cacheHash);
                            } catch (e: any) {
                                traced.warn("Failed to read query cache", { query: queryId.toString(), error: stringifyError(e) }, LOG_CTX);
                            }
                            initialState.cancellation.signal.throwIfAborted();
                            if (cached != null) {
                                let table: arrow.Table;
                                try {
                                    table = arrow.tableFromIPC(cached.bytes);
                                } catch (error) {
                                    args.scriptExecution.destroy();
                                    throw error;
                                }
                                // executeScriptQuery normally owns this cleanup, but a hit skips it entirely.
                                args.scriptExecution.destroy();
                                void resultCache!.touch(cacheHash).catch((e: any) => {
                                    traced.warn("Failed to record query cache access", { query: queryId.toString(), error: stringifyError(e) }, LOG_CTX);
                                });
                                queryTracker.dispatch({
                                    type: QUERY_RECEIVED_ALL_BATCHES,
                                    value: [queryId, table, new Map<string, string>(), createQueryResponseStreamMetrics()],
                                });
                                queryTracker.dispatch({
                                    type: QUERY_CACHE_RECORDED,
                                    value: [queryId, cacheHash, true, cached.cachedAtMs],
                                });
                                reportResultsReady();
                                if (args.analyzeResults) {
                                    if (args.replaceComputationId != null && args.replaceComputationId !== queryId) {
                                        computeDispatch({ type: DELETE_COMPUTATION, value: [args.replaceComputationId] });
                                    }
                                    queryTracker.dispatch({ type: QUERY_PROCESSING_RESULTS, value: [queryId] });
                                    await measurePostprocessing(async () => {
                                        await yieldToBrowser();
                                        await analyzeTable(queryId, table, computeDispatch, computeDb, traced, args.projection);
                                        initialState.cancellation.signal.throwIfAborted();
                                    });
                                    queryTracker.dispatch({ type: QUERY_PROCESSED_RESULTS, value: [queryId] });
                                }
                                return table;
                            }
                        }
                        startQueryExecution();
                        const table = await executeScriptQuery({
                            execution: args.scriptExecution,
                            queryArgs: args,
                            abortSignal: initialState.cancellation.signal,
                            logger: traced,
                            notebookId,
                            queryId,
                            logTarget: LOG_CTX,
                            callbacks: {
                                onStatementStarted: (index, statementCount) => queryTracker.dispatch({
                                    type: QUERY_STATEMENT_STARTED,
                                    value: [queryId, index, statementCount],
                                }),
                                onStatementSucceeded: (index, statementCount) => queryTracker.dispatch({
                                    type: QUERY_STATEMENT_SUCCEEDED,
                                    value: [queryId, index, statementCount],
                                }),
                                setResultStream: stream => {
                                    runtime.resultStream = stream;
                                },
                                executeStatement: async (statementArgs, producesOutput) => {
                                    tracked.sending();
                                    const stream = await executeConnectionQuery(
                                        conn.details,
                                        statementArgs,
                                        initialState.cancellation.signal,
                                    );
                                    runtime.resultStream = stream;
                                    tracked.running(stream);
                                    const statementTable = await consumeQueryResponseStream({
                                        stream,
                                        abort: initialState.cancellation.signal,
                                        publishResults: producesOutput,
                                        onProgress: progress => queryTracker.dispatch({
                                            type: QUERY_PROGRESS_UPDATED,
                                            value: [queryId, progress],
                                        }),
                                        onBatch: (batch, batchStream) => queryTracker.dispatch({
                                            type: QUERY_RECEIVED_BATCH,
                                            value: [queryId, batch, batchStream.getMetrics()],
                                        }),
                                    });
                                    if (statementTable != null) {
                                        queryTracker.dispatch({
                                            type: QUERY_RECEIVED_ALL_BATCHES,
                                            value: [queryId, statementTable, stream.getMetadata(), stream.getMetrics()],
                                        });
                                    }
                                    return statementTable;
                                },
                            },
                        });
                        reportQueryExecution();
                        reportResultsReady();
                        if (table && args.analyzeResults) {
                            if (args.replaceComputationId != null && args.replaceComputationId !== queryId) {
                                computeDispatch({ type: DELETE_COMPUTATION, value: [args.replaceComputationId] });
                            }
                            queryTracker.dispatch({ type: QUERY_PROCESSING_RESULTS, value: [queryId] });
                            await measurePostprocessing(async () => {
                                await yieldToBrowser();
                                await analyzeTable(queryId, table, computeDispatch, computeDb, traced, args.projection);
                                initialState.cancellation.signal.throwIfAborted();
                            });
                            queryTracker.dispatch({ type: QUERY_PROCESSED_RESULTS, value: [queryId] });
                        }
                        if (cacheHash != null && table != null) {
                            const bytes = arrow.tableToIPC(table, 'stream');
                            void resultCache!.store(cacheHash, bytes).then(() => {
                                queryTracker.dispatch({
                                    type: QUERY_CACHE_RECORDED,
                                    value: [queryId, cacheHash!, false, null],
                                });
                            }).catch((e: any) => {
                                traced.warn("Failed to write query cache", { query: queryId.toString(), error: stringifyError(e) }, LOG_CTX);
                            });
                        }
                        return table;
                    } catch (error: any) {
                        const cancelled = initialState.cancellation.signal.aborted || error?.name === 'AbortError' || error?.message === 'AbortError';
                        const metrics = runtime.resultStream?.getMetrics() ?? null;
                        if (cancelled) tracked.cancel(error, metrics);
                        else {
                            logQueryFailure(traced, error, queryId, notebookId);
                            tracked.fail(error, metrics);
                        }
                        if (args.throwOnError) throw error;
                        return null;
                    } finally {
                        runtime.resultStream = null;
                    }
                }

                // Compute the cache key up front for cacheable queries. This is best-effort: if the
                // connection has no recoverable params/signature (e.g. before setup completes) we simply skip
                // caching and execute normally. Never let a cache concern surface into the query path.
                // XXX Add explicit query preparation here later

                // Execute the query and consume the results
                let resultStream: QueryExecutionResponseStream | null = null;
                let table: arrow.Table | null = null;
                let servedFromCache = false;
                try {
                    // Cache read path: on a hit, load the Arrow IPC bytes and drive the state machine as if
                    // the result had just streamed in, skipping the backend entirely.
                    if (cacheHash != null) {
                        let cached: CachedQueryResult | null = null;
                        try {
                            cached = await resultCache!.load(cacheHash);
                        } catch (e: any) {
                            traced.warn("Failed to read query cache", { query: queryId.toString(), error: stringifyError(e) }, LOG_CTX);
                        }
                        // A user cancel during the async cache read should behave like any other cancel:
                        // let the catch below route it to QUERY_CANCELLED.
                        if (initialState.cancellation.signal.aborted) {
                            throw new Error('AbortError');
                        }
                        if (cached != null) {
                            table = arrow.tableFromIPC(cached.bytes);
                            servedFromCache = true;
                            // Record the access so eviction sees this as a recently-used (LRU) entry. This
                            // bumps only the empty `.last_access` marker, never the payload, so it is cheap and
                            // leaves the payload's "cached at" write time intact. Best-effort: a failure here
                            // must never surface into the query path (it only means the entry looks colder to
                            // eviction than it is).
                            void resultCache!.touch(cacheHash).catch((e: any) => {
                                traced.warn("Failed to record query cache access", { query: queryId.toString(), error: stringifyError(e) }, LOG_CTX);
                            });
                            traced.info("Served query from cache", {
                                notebookId,
                                "query": queryId.toString(),
                                "numRows": table.numRows.toString(),
                                "numCols": table.numCols.toString(),
                                "cachedAt": new Date(cached.cachedAtMs).toISOString(),
                            }, LOG_CTX);
                            // No live stream, so synthesize empty metadata and zeroed stream metrics.
                            queryTracker.dispatch({
                                type: QUERY_RECEIVED_ALL_BATCHES,
                                value: [queryId, table, new Map<string, string>(), createQueryResponseStreamMetrics()],
                            });
                            // Record the cache key and the entry's write time so the UI can show how old the
                            // cached result is and offer to delete it.
                            queryTracker.dispatch({
                                type: QUERY_CACHE_RECORDED,
                                value: [queryId, cacheHash, true, cached.cachedAtMs],
                            });
                        }
                    }

                    if (!servedFromCache) {
                        tracked.sending();

                        // Start the query
                        startQueryExecution();
                        resultStream = await executeConnectionQuery(conn.details, args, initialState.cancellation.signal);
                        if (initialState.cancellation.signal.aborted) {
                            await resultStream?.cancel?.();
                            initialState.cancellation.signal.throwIfAborted();
                        }
                        traced.debug("Received query results", {
                            notebookId,
                            "query": queryId.toString()
                        }, LOG_CTX);

                        if (resultStream != null) {
                            runtime.resultStream = resultStream;
                            tracked.running(resultStream);

                            // Subscribe to query_status and result messages
                            table = await consumeQueryResponseStream({
                                stream: resultStream,
                                abort: initialState.cancellation.signal,
                                publishResults: args.publishResults !== false,
                                onProgress: progress => queryTracker.dispatch({
                                    type: QUERY_PROGRESS_UPDATED,
                                    value: [queryId, progress],
                                }),
                                onBatch: (batch, stream) => queryTracker.dispatch({
                                    type: QUERY_RECEIVED_BATCH,
                                    value: [queryId, batch, stream.getMetrics()],
                                }),
                                onResultsReceived: reportQueryExecution,
                                logger: traced,
                                logContext: { notebookId, queryId, target: LOG_CTX },
                            });

                            traced.info("Executed query", {
                                notebookId,
                                "query": queryId.toString(),
                                "numRows": table?.numRows.toString(),
                                "numCols": table?.numCols.toString(),
                                "batchesReceived": resultStream.getMetrics().totalBatchesReceived.toString(),
                                "dataBytesReceived": resultStream.getMetrics().totalDataBytesReceived.toString(),
                            }, LOG_CTX);

                            // Is there any metadata?
                            const metadata = resultStream.getMetadata();
                            if (table != null) queryTracker.dispatch({
                                type: QUERY_RECEIVED_ALL_BATCHES,
                                value: [queryId, table!, metadata, resultStream!.getMetrics()],
                            });
                        } else {
                            reportQueryExecution();
                            traced.warn("Query returned no results", { notebookId, "query": queryId.toString() }, LOG_CTX);
                        }
                    }
                } catch (e: any) {
                    if (initialState.cancellation.signal.aborted || e?.name === 'AbortError' || e?.message === 'AbortError') {
                        const cancellationError = e instanceof LoggableException
                            ? e
                            : new LoggableException('Query was cancelled', {}, LOG_CTX);
                        traced.warn("Cancelled query", {
                            query: queryId.toString(),
                            notebookId
                        }, LOG_CTX);
                        tracked.cancel(cancellationError, resultStream?.getMetrics() ?? null);
                    } else {
                        logQueryFailure(traced, e, queryId, notebookId);
                        tracked.fail(e, resultStream?.getMetrics() ?? null);
                    }
                    if (args.throwOnError) {
                        throw e;
                    }
                    return null;
                }

                reportResultsReady();

                // Compute all table summaries of the result
                if (table && args.analyzeResults) {
                    try {
                        if (args.replaceComputationId != null && args.replaceComputationId !== queryId) {
                            computeDispatch({
                                type: DELETE_COMPUTATION,
                                value: [args.replaceComputationId],
                            });
                        }
                        queryTracker.dispatch({
                            type: QUERY_PROCESSING_RESULTS,
                            value: [queryId],
                        });

                        await measurePostprocessing(async () => {
                            await yieldToBrowser();
                            await analyzeTable(queryId, table!, computeDispatch, computeDb, traced, args.projection);
                            initialState.cancellation.signal.throwIfAborted();
                        });

                        queryTracker.dispatch({
                            type: QUERY_PROCESSED_RESULTS,
                            value: [queryId],
                        });
                    } catch (e: any) {
                        if (initialState.cancellation.signal.aborted || e?.name === 'AbortError') {
                            const cancellationError = e instanceof LoggableException
                                ? e
                                : new LoggableException('Query was cancelled', {}, LOG_CTX);
                            traced.warn("Cancelled query during result processing", {
                                query: queryId.toString(),
                                notebookId,
                            }, LOG_CTX);
                            tracked.cancel(cancellationError, resultStream?.getMetrics() ?? null);
                            if (args.throwOnError) throw e;
                            return null;
                        }
                        const processingError = e instanceof LoggableException
                            ? e
                            : new LoggableException("Query result processing failed", {
                                error: stringifyError(e),
                            }, LOG_CTX);
                        traced.warn("Query result processing failed", {
                            query: queryId.toString(),
                            notebookId,
                            error: processingError.message,
                            ...processingError.keyValues,
                        }, LOG_CTX);
                        tracked.fail(processingError);
                        throw processingError;
                    }
                }

                // Cache write path: after a successful miss, store the result for next time. Fire-and-forget
                // (not awaited) so a large eviction scan never stalls the caller's promise, and never fatal —
                // a quota/permission failure just logs.
                if (!servedFromCache && cacheHash != null && table != null) {
                    const bytes = arrow.tableToIPC(table, 'stream');
                    void resultCache!.store(cacheHash, bytes).then(() => {
                        // The write landed: record the key (but not servedFromCache — this run hit the
                        // backend) so the UI can offer to delete the freshly-cached entry. The "cached at"
                        // time is the write we just made; a later hit reads the precise mtime from disk.
                        queryTracker.dispatch({
                            type: QUERY_CACHE_RECORDED,
                            value: [queryId, cacheHash, false, null],
                        });
                    }).catch((e: any) => {
                        traced.warn("Failed to write query cache", { query: queryId.toString(), error: stringifyError(e) }, LOG_CTX);
                    });
                }

                return table;
            },
        });
        return execution;

    }, [computeDb, connStore, connDispatch, computeDispatch, logger, storageReader]);

    // Allocate the next query id and start the execution
    const execute = React.useCallback<QueryExecutor>((connectionId: string, args: QueryExecutionArgs): [number, Promise<arrow.Table | null>] => {
        const queryId = allocateQueryId();
        const trace = createTrace();
        const runtime: QueryExecutionRuntime = {
            cancellation: new AbortController(),
            resultStream: null,
            execution: null,
        };
        const cancelFromCaller = () => runtime.cancellation.abort(args.abortSignal?.reason);
        if (args.abortSignal?.aborted) {
            cancelFromCaller();
        } else {
            args.abortSignal?.addEventListener('abort', cancelFromCaller, { once: true });
        }
        queryRuntimes.current.set(queryId, runtime);
        const logObserver = args.onLog == null ? null : (record: LogRecord) => {
            try {
                args.onLog?.(record.message);
            } catch {
                // A progress surface must never interrupt query execution or logger delivery.
            }
        };
        if (logObserver != null) logger.buffer.subscribeTrace(trace.traceId, logObserver);
        const execution = executeImpl(connectionId, args, queryId, runtime, trace);
        runtime.execution = execution;
        const removeRuntime = () => {
            args.abortSignal?.removeEventListener('abort', cancelFromCaller);
            queryRuntimes.current.delete(queryId);
            if (logObserver != null) logger.buffer.unsubscribeTrace(trace.traceId, logObserver);
        };
        void execution.then(removeRuntime, removeRuntime);
        return [queryId, execution];
    }, [executeImpl, logger]);

    const cancel = React.useCallback<CancelQuery>(async (connectionId, queryId) => {
        const runtime = queryRuntimes.current.get(queryId);
        if (runtime == null) return;
        runtime.cancellation.abort();
        const cancellation = runtime.resultStream?.cancel?.();
        await cancellation?.catch((e: any) => {
            logger.warn('Failed to cancel query at the backend', {
                query: queryId.toString(),
                connectionId,
                error: stringifyError(e),
            }, LOG_CTX);
        });
        await runtime.execution?.catch(() => null);
    }, [logger]);

    const value = React.useMemo(() => ({ execute, cancel }), [execute, cancel]);

    return (
        <EXECUTOR_CTX.Provider value={value}>
            {props.children}
        </EXECUTOR_CTX.Provider>
    );
}
