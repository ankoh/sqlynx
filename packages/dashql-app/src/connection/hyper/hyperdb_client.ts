import * as proto from "@ankoh/dashql-protobuf";

import { ChannelArgs, ChannelMetadataProvider } from '../../platform/channel_common.js';
import { QueryExecutionProgress, QueryExecutionResponseStream } from "../../connection/query_execution_state.js";
import { DetailedError } from "../../utils/error.js";

export interface AttachedDatabase {
    path: string;
    alias?: string;
}

export interface HyperDatabaseConnectionContext extends ChannelMetadataProvider {
    /// Get the attached databases for a call
    getAttachedDatabases(): AttachedDatabase[];
}

export interface HyperQueryExecutionProgress extends QueryExecutionProgress { }

export interface HyperQueryResultStream extends QueryExecutionResponseStream { }

export interface HealthCheckResult {
    ok: boolean;
    error: DetailedError | null;
}
export interface HyperDatabaseChannel {
    /// Perform a health check
    checkHealth(): Promise<HealthCheckResult>;
    /// Execute Query
    executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam, abort?: AbortSignal): Promise<HyperQueryResultStream>;
    /// Destroy the connection
    close(): Promise<void>;
}

export interface HyperDatabaseClient {
    /// Create a database connection
    connect(args: ChannelArgs, context: HyperDatabaseConnectionContext): Promise<HyperDatabaseChannel>;
}
