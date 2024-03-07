import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/hyperdb-proto";

export enum HyperQueryExecutionStatus {
    ACCEPTED = 0,
    STARTED = 1,
    RECEIVED_SCHEMA = 2,
    RECEIVED_FIRST_RESULT = 3,
    SUCCEEDED = 4,
    FAILED = 5,
    CANCELLED = 6,
}

export interface HyperQueryExecutionProgress { }

export interface HyperQueryResultStream {
    /// Get the schema message
    getSchema(): Promise<arrow.Schema | null>;
    /// Get the query execution status
    getStatus(): Promise<HyperQueryExecutionStatus | null>;
    /// Get the next progress update
    nextProgressUpdate(): Promise<HyperQueryExecutionProgress | null>;
    /// Get the next record batch
    nextRecordBatch(): Promise<arrow.RecordBatch<any> | null>;
}

export interface HyperDatabaseConnection {
    /// Execute Query
    executeQuery(param: proto.pb.QueryParam): Promise<HyperQueryResultStream>;
}

export interface HyperDatabaseClient {
    /// Create a database connection
    connect(): Promise<HyperDatabaseConnection>;
}
