import * as arrow from 'apache-arrow';

import { VariantKind } from '../utils';
import { SALESFORCE_DATA_CLOUD } from './connector';
import { ExecuteDataCloudQueryTask } from './salesforce_query_execution';

export type QueryExecutionTaskVariant = VariantKind<typeof SALESFORCE_DATA_CLOUD, ExecuteDataCloudQueryTask>;

export enum QueryExecutionTaskStatus {
    STARTED = 0,
    SUCCEEDED = 2,
    FAILED = 3,
    CANCELLED = 4,
}

export interface QueryExecutionTaskState {
    /// The task key
    taskId: number;
    /// The task
    task: QueryExecutionTaskVariant;
    /// The status
    status: QueryExecutionTaskStatus;
    /// The cancellation signal
    cancellation: AbortController;
    /// The loading error (if any)
    error: Error | null;
    /// The time at which the query execution started (if any)
    startedAt: Date | null;
    /// The time at which the query execution finished (if any)
    finishedAt: Date | null;
    /// The time at which the query execution was last updated
    lastUpdatedAt: Date | null;
}

export interface QueryExecutionProgress {}

export interface QueryExecutionResponse {
    /// Await the next progress update
    nextProgressUpdate(): Promise<QueryExecutionProgress | null>;
    /// Await the next record batch
    nextRecordBatch(): Promise<arrow.RecordBatch | null>;
}
