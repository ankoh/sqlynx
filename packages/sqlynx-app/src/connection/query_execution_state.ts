import * as arrow from 'apache-arrow';

import {
    ConnectionState,
    EXECUTE_QUERY,
    QUERY_CANCELLED,
    QUERY_FAILED,
    QUERY_PROGRESS_UPDATED,
    QUERY_RECEIVED_BATCH,
    QUERY_RUNNING,
    QUERY_RECEIVED_ALL_BATCHES,
    QueryExecutionAction,
    QUERY_SUCCEEDED,
    QUERY_PROCESSED_RESULTS,
    QUERY_QUEUED,
    QUERY_PREPARING,
    QUERY_SENDING,
    QUERY_PROCESSING_RESULTS,
} from './connection_state.js';
import { ConnectionQueryMetrics } from './connection_statistics.js';

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
    /// Get the result metadata (after completion)
    getMetadata(): Map<string, string>;
    /// Get the stream metrics
    getMetrics(): QueryExecutionMetrics;
    /// Get the current query status
    getStatus(): QueryExecutionStatus;
    /// Await the schema message
    getSchema(): Promise<arrow.Schema | null>;
    /// Await the next query_status update
    nextProgressUpdate(): Promise<QueryExecutionProgress | null>;
    /// Await the next record batch
    nextRecordBatch(): Promise<arrow.RecordBatch | null>;
}

export interface QueryMetrics {
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

export interface QueryMetadata {
    /// The title of the query (if any)
    title: string | null;
    /// The description
    description: string | null;
    /// The issuer
    issuer: string | null;
    /// Authored by the user or the app?
    userProvided: boolean;
}

export interface QueryExecutionState {
    /// The query id
    queryId: number;
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
    error: Error | null;
    /// The latest update for the query execution
    latestProgressUpdate: QueryExecutionProgress | null;
    /// The number of record batches that are already buffered
    resultSchema: arrow.Schema | null;
    /// The number of record batches that are already buffered
    resultBatches: arrow.RecordBatch[];
    /// The result metadata
    resultMetadata: Map<string, string> | null;
    /// The result query_result iff the query succeeded
    resultTable: arrow.Table | null;
}

export function reduceQueryAction(state: ConnectionState, action: QueryExecutionAction): ConnectionState {
    const now = new Date();
    const queryId = action.value[0];

    // Initial setup?
    if (action.type == EXECUTE_QUERY) {
        state.queriesActive.set(queryId, action.value[1]);
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
        case QUERY_QUEUED: {
            query = {
                ...query,
                status: QueryExecutionStatus.QUEUED,
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    queryQueuedStartedAt: now,
                },
            };
            state.queriesActive.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_RUNNING: {
            query = {
                ...query,
                status: QueryExecutionStatus.RECEIVED_FIRST_BATCH,
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
            query = {
                ...query,
                latestProgressUpdate: action.value[1],
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    progressUpdatesReceived: ++query.metrics.progressUpdatesReceived
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
                status: QueryExecutionStatus.RECEIVED_ALL_BATCHES,
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
            const untilNow = now.getTime() - (query.metrics.queryRunningStartedAt ?? now).getTime();
            metrics.lastUpdatedAt = now;
            metrics.querySucceededAt = now;
            metrics.queryDurationMs = untilNow;
            query = {
                ...query,
                status: QueryExecutionStatus.SUCCEEDED,
                metrics: metrics,
            };
            state.queriesActive.delete(query.queryId);
            state.queriesFinished.set(query.queryId, query);
            return {
                ...state,
                metrics: {
                    ...state.metrics,
                    successfulQueries: mergeQueryMetrics(state.metrics.successfulQueries, metrics)
                },
            };
        }
        case QUERY_CANCELLED: {
            const untilNow = (query.metrics.queryRunningStartedAt ?? now).getTime();
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
            state.queriesFinished.set(query.queryId, query);
            return {
                ...state,
                metrics: {
                    ...state.metrics,
                    canceledQueries: mergeQueryMetrics(state.metrics.canceledQueries, metrics)
                },
            };
        }
        case QUERY_FAILED: {
            const untilNow = (query.metrics.queryRunningStartedAt ?? now).getTime();
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
            state.queriesFinished.set(query.queryId, query);
            return {
                ...state,
                metrics: {
                    ...state.metrics,
                    failedQueries: mergeQueryMetrics(state.metrics.failedQueries, metrics)
                },
            };
        }
    }
}

function mergeQueryMetrics(metrics: ConnectionQueryMetrics, query: QueryMetrics): ConnectionQueryMetrics {
    return {
        totalQueries: metrics.totalQueries + BigInt(1),
        totalBatchesReceived: metrics.totalBatchesReceived + BigInt(query.streamMetrics.totalBatchesReceived),
        totalRowsReceived: metrics.totalRowsReceived + BigInt(query.streamMetrics.totalRowsReceived),
        accumulatedTimeUntilFirstBatchMs: metrics.accumulatedTimeUntilFirstBatchMs + BigInt(query.streamMetrics.durationUntilFirstBatchMs ?? 0),
        accumulatedQueryDurationMs: metrics.accumulatedQueryDurationMs + BigInt(query.queryDurationMs ?? 0)
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
