import * as arrow from 'apache-arrow';

import {
    ConnectionState,
    EXECUTE_QUERY,
    QUERY_EXECUTION_CANCELLED,
    QUERY_EXECUTION_FAILED,
    QUERY_EXECUTION_PROGRESS_UPDATED,
    QUERY_EXECUTION_RECEIVED_BATCH,
    QUERY_EXECUTION_STARTED,
    QUERY_EXECUTION_SUCCEEDED,
    QueryExecutionAction,
} from './connection_state.js';
import { ConnectionQueryMetrics } from './connection_statistics.js';

export enum QueryExecutionStatus {
    ACCEPTED = 0,
    STARTED = 1,
    RECEIVED_FIRST_RESULT = 3,
    SUCCEEDED = 4,
    FAILED = 5,
    CANCELLED = 6,
}

export interface QueryExecutionProgress {
}

export interface QueryExecutionStreamMetrics {
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

export interface QueryExecutionResponseStream {
    /// Get the result metadata (after completion)
    getMetadata(): Map<string, string>;
    /// Get the stream metrics
    getMetrics(): QueryExecutionStreamMetrics;
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
    /// The time at which the query execution started (if any)
    startedAt: Date | null;
    /// The time at which the query execution finished (if any)
    finishedAt: Date | null;
    /// The time at which the query execution was last updated
    lastUpdatedAt: Date | null;
    /// The number of query_status updates received
    progressUpdatesReceived: number;
    /// The total query duration
    queryDurationMs: number | null;
    /// The stream metrics
    stream: QueryExecutionStreamMetrics;
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
        state.queriesRunning.set(queryId, action.value[1]);
        return { ...state };
    }

    let query = state.queriesRunning.get(queryId);
    if (!query) {
        return state;
    }
    switch (action.type) {
        case QUERY_EXECUTION_STARTED: {
            query = {
                ...query,
                status: QueryExecutionStatus.STARTED,
                resultStream: action.value[1],
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    startedAt: now,
                },
            };
            state.queriesRunning.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_EXECUTION_PROGRESS_UPDATED: {
            query = {
                ...query,
                latestProgressUpdate: action.value[1],
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    progressUpdatesReceived: ++query.metrics.progressUpdatesReceived
                },
            };
            state.queriesRunning.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_EXECUTION_RECEIVED_BATCH: {
            const [_queryId, batch, streamMetrics] = action.value;
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.stream = streamMetrics;
            query.resultBatches.push(batch);
            query = {
                ...query,
                status: QueryExecutionStatus.RECEIVED_FIRST_RESULT,
                metrics: metrics,
            };
            if (query.resultSchema == null) {
                query.resultSchema = batch.schema;
            }
            state.queriesRunning.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_EXECUTION_SUCCEEDED: {
            const metrics = { ...query.metrics };
            const untilNow = now.getTime() - (query.metrics.startedAt ?? now).getTime();
            metrics.lastUpdatedAt = now;
            metrics.finishedAt = now;
            metrics.queryDurationMs = untilNow;
            query = {
                ...query,
                resultMetadata: action.value[2],
                resultTable: action.value[1],
                status: QueryExecutionStatus.SUCCEEDED,
                metrics: metrics,
            };
            state.queriesRunning.delete(query.queryId);
            state.queriesFinished.set(query.queryId, query);
            return {
                ...state,
                metrics: {
                    ...state.metrics,
                    successfulQueries: mergeQueryMetrics(state.metrics.successfulQueries, metrics)
                },
            };
        }
        case QUERY_EXECUTION_CANCELLED: {
            const untilNow = (query.metrics.startedAt ?? now).getTime();
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.finishedAt = now;
            metrics.queryDurationMs = untilNow;
            metrics.stream = action.value[2] ?? metrics.stream;
            query = {
                ...query,
                status: QueryExecutionStatus.CANCELLED,
                error: action.value[1],
                metrics
            };
            state.queriesRunning.delete(query.queryId);
            state.queriesFinished.set(query.queryId, query);
            return {
                ...state,
                metrics: {
                    ...state.metrics,
                    canceledQueries: mergeQueryMetrics(state.metrics.canceledQueries, metrics)
                },
            };
        }
        case QUERY_EXECUTION_FAILED: {
            const untilNow = (query.metrics.startedAt ?? now).getTime();
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            metrics.finishedAt = now;
            metrics.queryDurationMs = untilNow;
            metrics.stream = action.value[2] ?? metrics.stream;
            query = {
                ...query,
                status: QueryExecutionStatus.FAILED,
                error: action.value[1],
                metrics
            };
            state.queriesRunning.delete(query.queryId);
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
        totalBatchesReceived: metrics.totalBatchesReceived + BigInt(query.stream.totalBatchesReceived),
        totalRowsReceived: metrics.totalRowsReceived + BigInt(query.stream.totalRowsReceived),
        accumulatedTimeUntilFirstBatchMs: metrics.accumulatedTimeUntilFirstBatchMs + BigInt(query.stream.durationUntilFirstBatchMs ?? 0),
        accumulatedQueryDurationMs: metrics.accumulatedQueryDurationMs + BigInt(query.queryDurationMs ?? 0)
    };
}

export function createQueryResponseStreamMetrics(): QueryExecutionStreamMetrics {
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
