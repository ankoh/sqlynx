import * as proto from "@ankoh/sqlynx-proto";
import { GrpcChannelArgs } from './grpc_common.js';

export enum HyperQueryExecutionStatus {
    ACCEPTED = 0,
    STARTED = 1,
    RECEIVED_RESULT_CHUNK = 3,
    SUCCEEDED = 4,
    FAILED = 5,
    CANCELLED = 6,
}

export interface HyperQueryExecutionProgress { }

export interface HyperQueryResultStream extends AsyncIterator<Uint8Array> {
    /// Get the query execution status
    getStatus(): HyperQueryExecutionStatus;
}

export interface HyperDatabaseConnection {
    /// Execute Query
    executeQuery(param: proto.pb.QueryParam): Promise<HyperQueryResultStream>;
}

export interface HyperDatabaseClient {
    /// Create a database connection
    connect(args: GrpcChannelArgs): Promise<HyperDatabaseConnection>;
}
