import * as arrow from 'apache-arrow';

import { VariantKind } from '../utils/index.js';
import { DEMO_CONNECTOR, HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR } from './connector_info.js';
import {
    ConnectionState,
    EXECUTE_QUERY,
    QUERY_EXECUTION_CANCELLED,
    QUERY_EXECUTION_FAILED,
    QUERY_EXECUTION_PROGRESS_UPDATED,
    QUERY_EXECUTION_RECEIVED_BATCH,
    QUERY_EXECUTION_RECEIVED_SCHEMA,
    QUERY_EXECUTION_STARTED,
    QUERY_EXECUTION_SUCCEEDED,
    QueryExecutionAction,
} from './connection_state.js';
import { ConnectionQueryMetrics } from './connection_statistics.js';
import { HyperDatabaseChannel } from '../platform/hyperdb_client.js';
import { DemoDatabaseChannel } from './demo/demo_database_channel.js';

export type QueryExecutionTaskVariant =
    | VariantKind<typeof DEMO_CONNECTOR, ExecuteDemoQueryTask>
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, ExecuteDataCloudQueryTask>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcQueryTask>;

export interface ExecuteDemoQueryTask {
    /// The script text
    scriptText: string;
    /// The channel
    demoChannel: DemoDatabaseChannel;
}

export interface ExecuteDataCloudQueryTask {
    /// The script text
    scriptText: string;
    /// The channel
    hyperChannel: HyperDatabaseChannel;
}

export interface HyperGrpcQueryTask {
    /// The script text
    scriptText: string;
    /// The channel
    hyperChannel: HyperDatabaseChannel;
}

export enum QueryExecutionStatus {
    ACCEPTED = 0,
    STARTED = 1,
    RECEIVED_SCHEMA = 2,
    RECEIVED_FIRST_RESULT = 3,
    SUCCEEDED = 4,
    FAILED = 5,
    CANCELLED = 6,
}

export interface QueryExecutionProgress { }

export interface QueryExecutionResponseStreamMetrics {
    /// The total data bytes
    dataBytes: number;
}

export interface QueryExecutionResponseStream {
    /// Get the result metadata (after completion)
    getMetadata(): Map<string, string>;
    /// Get the stream metrics
    getMetrics(): QueryExecutionResponseStreamMetrics;
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
    /// The number of data bytes received
    dataBytesReceived: number;
    /// The number of batches received
    batchesReceived: number;
    /// The number of rows received
    rowsReceived: number;
    /// The number of query_status updates received
    progressUpdatesReceived: number;
    /// The duration until the first batch
    durationUntilSchemaMs: number | null;
    /// The duration until the first batch
    durationUntilFirstBatchMs: number | null;
    /// The total query duration
    queryDurationMs: number | null;
}

export interface QueryExecutionState {
    /// The query id
    queryId: number;
    /// The script text that is executed
    task: QueryExecutionTaskVariant;
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
        case QUERY_EXECUTION_RECEIVED_SCHEMA: {
            query = {
                ...query,
                status: QueryExecutionStatus.RECEIVED_SCHEMA,
                resultSchema: action.value[1],
                metrics: {
                    ...query.metrics,
                    lastUpdatedAt: now,
                    durationUntilSchemaMs: now.getTime() - (query.metrics.startedAt ?? now).getTime(),
                },
            };
            state.queriesRunning.set(query.queryId, query);
            return { ...state };
        }
        case QUERY_EXECUTION_RECEIVED_BATCH: {
            const batch = action.value[1];
            const metrics = { ...query.metrics };
            metrics.lastUpdatedAt = now;
            if (metrics.batchesReceived == 0) {
                metrics.durationUntilFirstBatchMs = now.getTime() - (query.metrics.startedAt ?? now).getTime();
            }
            metrics.batchesReceived += 1;
            metrics.rowsReceived += batch.numRows;
            metrics.dataBytesReceived = action.value[2]?.dataBytes ?? metrics.dataBytesReceived;
            query.resultBatches.push(batch);
            query = {
                ...query,
                status: QueryExecutionStatus.RECEIVED_FIRST_RESULT,
                metrics: metrics,
            };
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
            metrics.dataBytesReceived = action.value[2]?.dataBytes ?? metrics.dataBytesReceived;
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
            metrics.dataBytesReceived = action.value[2]?.dataBytes ?? metrics.dataBytesReceived;
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
        totalBatchesReceived: metrics.totalBatchesReceived + BigInt(query.batchesReceived),
        totalRowsReceived: metrics.totalRowsReceived + BigInt(query.rowsReceived),
        accumulatedTimeUntilSchemaMs: metrics.accumulatedTimeUntilSchemaMs + BigInt(query.durationUntilSchemaMs ?? 0),
        accumulatedTimeUntilFirstBatchMs: metrics.accumulatedTimeUntilFirstBatchMs + BigInt(query.durationUntilFirstBatchMs ?? 0),
        accumulatedQueryDurationMs: metrics.accumulatedQueryDurationMs + BigInt(query.queryDurationMs ?? 0)
    };
}
