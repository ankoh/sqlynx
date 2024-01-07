import * as arrow from 'apache-arrow';

import { VariantKind } from '../utils';
import { SALESFORCE_DATA_CLOUD } from './connector';
import { ExecuteDataCloudQueryTask } from './salesforce_query_execution';

export type QueryExecutionTaskVariant = VariantKind<typeof SALESFORCE_DATA_CLOUD, ExecuteDataCloudQueryTask>;

export enum QueryExecutionTaskStatus {
    STARTED = 0,
    RECEIVED_SCHEMA = 1,
    RECEIVED_FIRST_RESULT = 2,
    SUCCEEDED = 3,
    FAILED = 4,
    CANCELLED = 5,
}

export interface QueryExecutionProgress {}

export interface QueryExecutionResponseStream {
    /// Await the next progress update
    nextProgressUpdate(): Promise<QueryExecutionProgress | null>;
    /// Await the next record batch
    nextRecordBatch(): Promise<arrow.RecordBatch | null>;
}

export interface QueryExecutionTaskState {
    /// The task key
    taskId: number;
    /// The script text that is executed
    task: QueryExecutionTaskVariant;
    /// The status
    status: QueryExecutionTaskStatus;
    /// The cancellation signal
    cancellation: AbortController;
    /// The response stream
    resultStream: QueryExecutionResponseStream;
    /// The loading error (if any)
    error: Error | null;
    /// The time at which the query execution started (if any)
    startedAt: Date | null;
    /// The time at which the query execution finished (if any)
    finishedAt: Date | null;
    /// The time at which the query execution was last updated
    lastUpdatedAt: Date | null;
    /// The latest update for the query execution
    latestProgressUpdate: QueryExecutionProgress;
    /// The number of record batches that are already buffered
    resultSchema: arrow.Schema;
    /// The number of record batches that are already buffered
    resultBatches: Immutable.List<arrow.RecordBatch>;
}

export interface QueryExecutionResult {
    /// The time at which the query execution started (if any)
    startedAt: Date | null;
    /// The time at which the query execution finished (if any)
    finishedAt: Date | null;
    /// The latest update for the query execution
    latestProgressUpdate: QueryExecutionProgress;
    /// The result table
    resultTable: arrow.Table;
}
