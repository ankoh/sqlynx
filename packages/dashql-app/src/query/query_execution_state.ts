import * as arrow from 'apache-arrow';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import * as buf from '@bufbuild/protobuf';

import { AsyncConsumer } from '../utils/async_consumer.js';
import { removePrimitiveFromArray } from '../utils/array.js';
import { LoggableException } from '../platform/logger/logger.js';
import { VariantKind } from '../utils/variant.js';

export enum QueryExecutionStatus {
    REQUESTED = 0,
    PREPARING = 1,
    SENDING = 2,
    QUEUED = 3,
    RUNNING = 4,
    RECEIVED_FIRST_BATCH = 5,
    RECEIVED_ALL_BATCHES = 6,
    PROCESSING_RESULTS = 7,
    PROCESSED_RESULTS = 8,
    SUCCEEDED = 9,
    FAILED = 10,
    CANCELLED = 11,
}

export function queryIsDone(status: QueryExecutionStatus) {
    switch (status) {
        case QueryExecutionStatus.SUCCEEDED:
        case QueryExecutionStatus.FAILED:
        case QueryExecutionStatus.CANCELLED:
            return true;
        default:
            return false;
    }
}

export interface QueryExecutionMetrics {
    /// The total data bytes
    totalDataBytesReceived: number;
    /// The total batches received
    totalBatchesReceived: number;
    /// The total batches received
    totalRowsReceived: number;

    /// The query requests that started
    totalQueryRequestsStarted: number;
    /// The query requests that finished
    totalQueryRequestsSucceeded: number;
    /// The query requests that failed
    totalQueryRequestsFailed: number
    /// The total request duration of all requests that failed or succeeded
    totalQueryRequestDurationMs: number;

    /// The duration until the first batch
    durationUntilFirstBatchMs: number | null;
}

export interface QueryExecutionProgress {
    /// Is queued?
    isQueued: boolean | null;
    /// The query execution metrics
    metrics: QueryExecutionMetrics;
}

export interface QueryExecutionResponseStream {
    /// Ask the backend to stop the query, when the connector supports explicit cancellation.
    cancel?(): Promise<void>;
    /// Get the result metadata (after completion)
    getMetadata(): Map<string, string>;
    /// Get the stream metrics
    getMetrics(): QueryExecutionMetrics;
    /// Get the current query status
    getStatus(): QueryExecutionStatus;
    /// Await the schema message
    getSchema(): Promise<arrow.Schema | null>;
    /// Await the next record batch
    produce(batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>, progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>, abort?: AbortSignal): Promise<void>;
}

export interface QueryMetrics {
    /// The time at which we requested the query (if any)
    queryRequestedAt: Date | null;
    /// The time at which we prepared the query (if any)
    queryPreparingStartedAt: Date | null;
    /// The time at which the query was sent (if any)
    querySendingStartedAt: Date | null;
    /// The time at which the query was queued (if any)
    queryQueuedStartedAt: Date | null;
    /// The time at which we the query started running (if any)
    queryRunningStartedAt: Date | null;
    /// Received the frist batch at (if any)
    receivedFirstBatchAt: Date | null;
    /// Received all batches at (if any)
    receivedLastBatchAt: Date | null;
    /// Received all batches at (if any)
    receivedAllBatchesAt: Date | null;
    /// The time at which we started processed the results
    processingResultsStartedAt: Date | null;
    /// The time at which we processed the results
    processedResultsAt: Date | null;
    /// The time at which the query execution finished (if any)
    querySucceededAt: Date | null;
    /// The time at which the query execution failed (if any)
    queryFailedAt: Date | null;
    /// The time at which the query execution was cancelled (if any)
    queryCancelledAt: Date | null;
    /// The time at which the query execution was last updated
    lastUpdatedAt: Date | null;
    /// The number of query_status updates received
    progressUpdatesReceived: number;
    /// The total query duration
    queryDurationMs: number | null;
    /// The text length in characters
    textLength: number | null;
    /// The stream metrics
    streamMetrics: QueryExecutionMetrics;
}

/// A query hint
export enum QueryType {
    USER_PROVIDED,
    CATALOG_QUERY_INFORMATION_SCHEMA,
    CATALOG_QUERY_PG_ATTRIBUTE,
    CATALOG_QUERY_PG_PROC,
    CATALOG_QUERY_HYPER_CLOUD,
    HEALTH_CHECK,
    INTERNAL_SQLFRAME,
}

export interface QueryMetadata {
    /// The query type
    queryType: QueryType;
    /// The title of the query (if any)
    title: string | null;
    /// The description
    description: string | null;
    /// The issuer
    issuer: string | null;
    /// Authored by the user or the app?
    userProvided: boolean;
    /// The notebook that issued the query, if any.
    /// Several notebooks may share a connection, the notebook scopes the query result cache and the
    /// cleanup of the notebook's queries.
    notebookId?: string;
}

export interface QueryExecutionState {
    /// The query id
    queryId: number;
    /// The trace id for this query execution
    traceId: number;
    /// The query text
    queryText: string;
    /// The query metadata
    queryMetadata: QueryMetadata;
    /// The current status
    status: QueryExecutionStatus;
    /// The query metric counters
    metrics: QueryMetrics;
    /// The cancellation signal
    cancellation: AbortController;
    /// The response stream
    resultStream: QueryExecutionResponseStream | null;
    /// The loading error (if any)
    error: LoggableException | null;
    /// The latest update for the query execution
    latestProgressUpdate: QueryExecutionProgress | null;
    /// One-based active statement position for a core-steered script execution.
    statementIndex: number | null;
    /// Total statements in the active script execution.
    statementCount: number | null;
    /// Whether the latest script statement completed successfully.
    statementSucceeded: boolean;
    /// The number of record batches that are already buffered
    resultSchema: arrow.Schema | null;
    /// The number of record batches that are already buffered
    resultBatches: arrow.RecordBatch[];
    /// The result metadata
    resultMetadata: Map<string, string> | null;
    /// The result query_result iff the query succeeded
    resultTable: arrow.Table | null;
    /// The file-based query result cache key for this execution, or null when the query is not
    /// cacheable (or no key could be derived). Recorded so the UI can offer a "delete cached" action.
    cacheKey: string | null;
    /// Whether this result was served from the query result cache instead of the backend.
    servedFromCache: boolean;
    /// Whether the cached `.arrow` entry for this query has been deleted (via the UI). Used to
    /// disable the "delete cached" button once there is nothing left to delete.
    cacheDeleted: boolean;
    /// When the cache entry backing this result was written (`.arrow` file mtime), or null when the
    /// result did not come from the cache. Lets the UI show how old a cached result is. Note that a
    /// cache hit does not re-touch the file, so this is the write time, not a last-access time.
    cachedAt: Date | null;
}

export interface QueryExecutionTracker {
    dispatch(action: QueryExecutionAction): void;
}

export const EXECUTE_QUERY = Symbol('EXECUTE_QUERY');
export const QUERY_PREPARING = Symbol('QUERY_PREPARING');
export const QUERY_SENDING = Symbol('QUERY_SENDING');
export const QUERY_RUNNING = Symbol('QUERY_RUNNING');
export const QUERY_PROGRESS_UPDATED = Symbol('QUERY_PROGRESS_UPDATED');
export const QUERY_STATEMENT_STARTED = Symbol('QUERY_STATEMENT_STARTED');
export const QUERY_STATEMENT_SUCCEEDED = Symbol('QUERY_STATEMENT_SUCCEEDED');
export const QUERY_RECEIVED_BATCH = Symbol('QUERY_RECEIVED_BATCH');
export const QUERY_RECEIVED_ALL_BATCHES = Symbol('QUERY_RECEIVED_ALL_BATCHES');
export const QUERY_PROCESSING_RESULTS = Symbol('QUERY_PROCESSING_RESULTS');
export const QUERY_PROCESSED_RESULTS = Symbol('QUERY_PROCESSED_RESULTS');
export const QUERY_SUCCEEDED = Symbol('QUERY_SUCCEEDED');
export const QUERY_FAILED = Symbol('QUERY_FAILED');
export const QUERY_CANCELLED = Symbol('QUERY_CANCELLED');
export const QUERY_CACHE_RECORDED = Symbol('QUERY_CACHE_RECORDED');
export const QUERY_CACHE_DELETED = Symbol('QUERY_CACHE_DELETED');

export type QueryExecutionAction =
    | VariantKind<typeof EXECUTE_QUERY, [number, QueryExecutionState]>
    | VariantKind<typeof QUERY_PREPARING, [number]>
    | VariantKind<typeof QUERY_SENDING, [number]>
    | VariantKind<typeof QUERY_RUNNING, [number, QueryExecutionResponseStream | null]>
    | VariantKind<typeof QUERY_PROGRESS_UPDATED, [number, QueryExecutionProgress]>
    | VariantKind<typeof QUERY_STATEMENT_STARTED, [number, number, number]>
    | VariantKind<typeof QUERY_STATEMENT_SUCCEEDED, [number, number, number]>
    | VariantKind<typeof QUERY_RECEIVED_BATCH, [number, arrow.RecordBatch, QueryExecutionMetrics]>
    | VariantKind<typeof QUERY_RECEIVED_ALL_BATCHES, [number, arrow.Table, Map<string, string>, QueryExecutionMetrics]>
    | VariantKind<typeof QUERY_PROCESSING_RESULTS, [number]>
    | VariantKind<typeof QUERY_PROCESSED_RESULTS, [number]>
    | VariantKind<typeof QUERY_SUCCEEDED, [number]>
    | VariantKind<typeof QUERY_FAILED, [number, LoggableException, QueryExecutionMetrics | null]>
    | VariantKind<typeof QUERY_CANCELLED, [number, LoggableException, QueryExecutionMetrics | null]>
    | VariantKind<typeof QUERY_CACHE_RECORDED, [number, string, boolean, number | null]>
    | VariantKind<typeof QUERY_CACHE_DELETED, [number]>;

export interface QueryExecutionHistoryState {
    queriesActive: Map<number, QueryExecutionState>;
    queriesActiveOrdered: number[];
    queriesFinished: Map<number, QueryExecutionState>;
    queriesFinishedOrdered: number[];
    snapshotQueriesActiveFinished: number;
    metrics: connection.ConnectionMetrics;
}

export function createQueryExecutionState(
    queryId: number,
    traceId: number,
    queryText: string,
    queryMetadata: QueryMetadata,
    cancellation: AbortController,
): QueryExecutionState {
    const requestedAt = new Date();
    return {
        queryId,
        traceId,
        queryText,
        queryMetadata,
        status: QueryExecutionStatus.REQUESTED,
        cancellation,
        resultStream: null,
        error: null,
        metrics: {
            textLength: queryText.length,
            queryRequestedAt: requestedAt,
            queryPreparingStartedAt: null,
            querySendingStartedAt: null,
            queryQueuedStartedAt: null,
            queryRunningStartedAt: null,
            receivedFirstBatchAt: null,
            receivedLastBatchAt: null,
            receivedAllBatchesAt: null,
            processingResultsStartedAt: null,
            processedResultsAt: null,
            querySucceededAt: null,
            queryFailedAt: null,
            queryCancelledAt: null,
            lastUpdatedAt: requestedAt,
            progressUpdatesReceived: 0,
            queryDurationMs: null,
            streamMetrics: createQueryResponseStreamMetrics(),
        },
        latestProgressUpdate: null,
        statementIndex: null,
        statementCount: null,
        statementSucceeded: false,
        resultMetadata: null,
        resultSchema: null,
        resultBatches: [],
        resultTable: null,
        cacheKey: null,
        servedFromCache: false,
        cacheDeleted: false,
        cachedAt: null,
    };
}

export function reduceQueryAction<T extends QueryExecutionHistoryState>(state: T, action: QueryExecutionAction): T {
    const now = new Date();
    const queryId = action.value[0];

    // Initial setup?
    if (action.type == EXECUTE_QUERY) {
        state.queriesActive.set(queryId, action.value[1]);
        state.queriesActiveOrdered.push(queryId);
        state.snapshotQueriesActiveFinished += 1;
        return { ...state };
    }

    // Cache bookkeeping actions can arrive after the query has already moved to `queriesFinished`
    // (the write path fires-and-forgets, and the UI delete happens on a finished result), so resolve
    // the query from whichever map holds it and write the update back to the same map.
    if (action.type == QUERY_CACHE_RECORDED || action.type == QUERY_CACHE_DELETED) {
        const isActive = state.queriesActive.has(queryId);
        const target = isActive ? state.queriesActive : state.queriesFinished;
        const q = target.get(queryId);
        if (!q) {
            return state;
        }
        let next: QueryExecutionState;
        if (action.type == QUERY_CACHE_RECORDED) {
            const [, cacheKey, servedFromCache, cachedAtMs] = action.value;
            next = {
                ...q,
                cacheKey,
                servedFromCache,
                cachedAt: cachedAtMs != null ? new Date(cachedAtMs) : q.cachedAt,
            };
        } else {
            next = { ...q, cacheDeleted: true };
        }
        target.set(queryId, next);
        return { ...state };
    }

    let query = state.queriesActive.get(queryId);
    if (!query) {
        return state;
    }
    switch (action.type) {
        case QUERY_PREPARING: {
            query = {
                ...query,
                status: QueryExecutionStatus.PREPARING,
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    queryPreparingStartedAt: now,
                },
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_SENDING: {
            query = {
                ...query,
                status: QueryExecutionStatus.SENDING,
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    querySendingStartedAt: now,
                },
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_RUNNING: {
            query = {
                ...query,
                status: QueryExecutionStatus.RUNNING,
                resultStream: action.value[1],
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    queryRunningStartedAt: now,
                },
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_PROGRESS_UPDATED: {
            const next = {
                ...query,
                latestProgressUpdate: action.value[1],
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    progressUpdatesReceived: ++query.metrics.progressUpdatesReceived
                },
            };
            // Is the query queued for the first time?
            if (action.value[1].isQueued && next.status == QueryExecutionStatus.SENDING) {
                next.status = QueryExecutionStatus.QUEUED;
                next.metrics.queryQueuedStartedAt = now;
            }
            state.queriesActive.set(query.queryId, next);
            return { ...state };
        }
        case QUERY_STATEMENT_STARTED: {
            query = {
                ...query,
                statementIndex: action.value[1],
                statementCount: action.value[2],
                statementSucceeded: false,
                status: QueryExecutionStatus.RUNNING,
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                },
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_STATEMENT_SUCCEEDED: {
            query = {
                ...query,
                statementIndex: action.value[1],
                statementCount: action.value[2],
                statementSucceeded: true,
                status: QueryExecutionStatus.RUNNING,
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                },
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_RECEIVED_BATCH: {
            const [_queryId, batch, streamMetrics] = action.value;
            const metrics = { ...query.metrics };
            if (metrics.receivedFirstBatchAt == null) {
                metrics.receivedFirstBatchAt = now;
            }
            metrics.receivedLastBatchAt = now;
            metrics.lastUpdatedAt = now;
            metrics.streamMetrics = streamMetrics;
            query.resultBatches.push(batch);
            query = {
                ...query,
                status: QueryExecutionStatus.RECEIVED_FIRST_BATCH,
                metrics: metrics,
            };
            if (query.resultSchema == null) {
                query.resultSchema = batch.schema;
            }
            state.queriesActive.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_RECEIVED_ALL_BATCHES: {
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.receivedAllBatchesAt = now;
            metrics.streamMetrics = action.value[3];
            query = {
                ...query,
                resultMetadata: action.value[2],
                resultTable: action.value[1],
                status: QueryExecutionStatus.RECEIVED_ALL_BATCHES,
                metrics: metrics,
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state, };
        }
        case QUERY_PROCESSING_RESULTS: {
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.processingResultsStartedAt = now;
            query = {
                ...query,
                status: QueryExecutionStatus.PROCESSING_RESULTS,
                metrics: metrics,
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state, };
        }
        case QUERY_PROCESSED_RESULTS: {
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.processedResultsAt = now;
            query = {
                ...query,
                status: QueryExecutionStatus.PROCESSED_RESULTS,
                metrics: metrics,
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state, };
        }
        case QUERY_SUCCEEDED: {
            const metrics = { ...query.metrics };
            const untilNow = now.getTime() - (query.metrics.queryRunningStartedAt ?? query.metrics.queryRequestedAt ?? now).getTime();
            metrics.lastUpdatedAt = now;
            metrics.querySucceededAt = now;
            metrics.queryDurationMs = untilNow;
            query = {
                ...query,
                status: QueryExecutionStatus.SUCCEEDED,
                metrics: metrics,
            };
            state.queriesActive.delete(query.queryId);
            removePrimitiveFromArray(state.queriesActiveOrdered, query.queryId);
            state.queriesFinished.set(query.queryId, query);
            state.queriesFinishedOrdered.push(query.queryId);
            state.snapshotQueriesActiveFinished += 1;
            return query.queryMetadata.queryType == QueryType.INTERNAL_SQLFRAME
                ? { ...state }
                : {
                    ...state,
                    metrics: {
                        ...state.metrics,
                        successfulQueries: mergeQueryMetrics(state.metrics.successfulQueries!, metrics)
                    },
                };
        }
        case QUERY_CANCELLED: {
            const untilNow = now.getTime() - (query.metrics.queryRunningStartedAt ?? query.metrics.queryRequestedAt ?? now).getTime();
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.queryCancelledAt = now;
            metrics.queryDurationMs = untilNow;
            metrics.streamMetrics = action.value[2] ?? metrics.streamMetrics;
            query = {
                ...query,
                status: QueryExecutionStatus.CANCELLED,
                error: action.value[1],
                metrics
            };
            state.queriesActive.delete(query.queryId);
            removePrimitiveFromArray(state.queriesActiveOrdered, query.queryId);
            state.queriesFinished.set(query.queryId, query);
            state.queriesFinishedOrdered.push(query.queryId);
            state.snapshotQueriesActiveFinished += 1;
            return query.queryMetadata.queryType == QueryType.INTERNAL_SQLFRAME
                ? { ...state }
                : {
                    ...state,
                    metrics: {
                        ...state.metrics,
                        canceledQueries: mergeQueryMetrics(state.metrics.canceledQueries!, metrics)
                    },
                };
        }
        case QUERY_FAILED: {
            const untilNow = now.getTime() - (query.metrics.queryRunningStartedAt ?? query.metrics.queryRequestedAt ?? now).getTime();
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.queryFailedAt = now;
            metrics.queryDurationMs = untilNow;
            metrics.streamMetrics = action.value[2] ?? metrics.streamMetrics;
            query = {
                ...query,
                status: QueryExecutionStatus.FAILED,
                error: action.value[1],
                metrics
            };
            state.queriesActive.delete(query.queryId);
            removePrimitiveFromArray(state.queriesActiveOrdered, query.queryId);
            state.queriesFinished.set(query.queryId, query);
            state.queriesFinishedOrdered.push(query.queryId);
            state.snapshotQueriesActiveFinished += 1;
            return query.queryMetadata.queryType == QueryType.INTERNAL_SQLFRAME
                ? { ...state }
                : {
                    ...state,
                    metrics: {
                        ...state.metrics,
                        failedQueries: mergeQueryMetrics(state.metrics.failedQueries!, metrics)
                    },
                };
        }
    }
}

function mergeQueryMetrics(metrics: connection.ConnectionQueryMetrics, query: QueryMetrics): connection.ConnectionQueryMetrics {
    return {
        totalQueries: metrics.totalQueries + 1,
        totalBatchesReceived: metrics.totalBatchesReceived + query.streamMetrics.totalBatchesReceived,
        totalRowsReceived: metrics.totalRowsReceived + query.streamMetrics.totalRowsReceived,
        accumulatedTimeUntilFirstBatch: metrics.accumulatedTimeUntilFirstBatch + (query.streamMetrics.durationUntilFirstBatchMs ?? 0),
        accumulatedQueryDuration: metrics.accumulatedQueryDuration + (query.queryDurationMs ?? 0)
    };
}

export function createQueryResponseStreamMetrics(): QueryExecutionMetrics {
    return {
        totalDataBytesReceived: 0,
        totalBatchesReceived: 0,
        totalRowsReceived: 0,

        totalQueryRequestsStarted: 0,
        totalQueryRequestsSucceeded: 0,
        totalQueryRequestsFailed: 0,
        totalQueryRequestDurationMs: 0,

        durationUntilFirstBatchMs: null,
    };
}

export function createQueryExecutionMetrics(): connection.ConnectionMetrics {
    return {
        successfulQueries: {
            totalQueries: 0,
            totalBatchesReceived: 0,
            totalRowsReceived: 0,
            accumulatedTimeUntilFirstBatch: 0,
            accumulatedQueryDuration: 0,
        },
        canceledQueries: {
            totalQueries: 0,
            totalBatchesReceived: 0,
            totalRowsReceived: 0,
            accumulatedTimeUntilFirstBatch: 0,
            accumulatedQueryDuration: 0,
        },
        failedQueries: {
            totalQueries: 0,
            totalBatchesReceived: 0,
            totalRowsReceived: 0,
            accumulatedTimeUntilFirstBatch: 0,
            accumulatedQueryDuration: 0,
        },
    };
}
