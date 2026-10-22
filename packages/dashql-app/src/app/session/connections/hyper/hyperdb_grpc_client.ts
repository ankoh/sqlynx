import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import * as pb from "../../../../proto.js";

import { ChannelMetadataProvider } from '../../../../platform/channel_common.js';
import { QueryExecutionProgress, QueryExecutionResponseStream } from "../query_execution_state.js";

export interface AttachedDatabase {
    path: string;
    alias?: string;
}

export interface HyperDatabaseConnectionContext extends ChannelMetadataProvider {
    /// Get the attached databases for a call
    getAttachedDatabases(): AttachedDatabase[];
    /// Get the query parameters that are added to every query
    getQueryParameters(): Record<string, string>;
}

export interface HyperQueryExecutionProgress extends QueryExecutionProgress { }

export interface HyperQueryResultStream extends QueryExecutionResponseStream { }

export interface HyperQueryExecutionOptions {
    /// Maximum time to wait for the next result batch from the native gRPC proxy.
    readTimeoutMs?: number;
}

export interface HyperDatabaseChannel {
    /// Execute Query
    executeQuery(param: pb.salesforce_hyperdb_grpc_v1.pb.QueryParam, abort?: AbortSignal, options?: HyperQueryExecutionOptions): Promise<HyperQueryResultStream>;
    /// Destroy the connection
    close(): Promise<void>;
}

export interface HyperDatabaseClient {
    /// Create a database connection
    connect(args: connection.HyperConnectionParams, context: HyperDatabaseConnectionContext): Promise<HyperDatabaseChannel>;
}
