import * as proto from "@ankoh/sqlynx-protobuf";

import { ChannelMetadataProvider as ChannelMetadataProvider } from "../../platform/channel_common.js";
import { QueryExecutionProgress, QueryExecutionResponseStream } from "../../connectors/query_execution_state.js";


export interface AttachedDatabase {
    path: string;
    alias?: string;
}

export interface TrinoDatabaseConnectionContext extends ChannelMetadataProvider {
    /// Get the attached databases for a call
    getAttachedDatabases(): AttachedDatabase[];
}

export interface TrinoQueryExecutionProgress extends QueryExecutionProgress { }

export interface TrinoQueryResultStream extends QueryExecutionResponseStream { }

export interface TrinoHealthCheckResult {
    ok: boolean;
    errorMessage: string | null;
}

export interface TrinoChannel {
    /// Perform a health check
    checkHealth(): Promise<TrinoHealthCheckResult>;
    /// Execute Query
    executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<TrinoQueryResultStream>;
    /// Destroy the connection
    close(): Promise<void>;
}
