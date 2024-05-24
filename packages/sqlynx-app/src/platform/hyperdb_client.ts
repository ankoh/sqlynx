import * as proto from "@ankoh/sqlynx-pb";

import { GrpcChannelArgs, GrpcMetadataProvider } from './grpc_common.js';
import { QueryExecutionProgress, QueryExecutionResponseStream } from "../connectors/query_execution.js";

export interface AttachedDatabase {
    path: string;
    alias: string;
}

export interface HyperDatabaseConnectionContext extends GrpcMetadataProvider {
    /// Get the attached databases for a call
    getAttachedDatabases(): AttachedDatabase[];
}

export interface HyperQueryExecutionProgress extends QueryExecutionProgress {}

export interface HyperQueryResultStream extends QueryExecutionResponseStream {}

export enum HealthCheckStatus {
    OK,
    TIMED_OUT,
    FAILED
}
export interface HyperDatabaseChannel {
    /// Perform a health check
    checkHealth(): Promise<HealthCheckStatus>;
    /// Execute Query
    executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<HyperQueryResultStream>;
    /// Destroy the connection
    close(): Promise<void>;
}

export interface HyperDatabaseClient {
    /// Create a database connection
    connect(args: GrpcChannelArgs, context: HyperDatabaseConnectionContext): Promise<HyperDatabaseChannel>;
}
