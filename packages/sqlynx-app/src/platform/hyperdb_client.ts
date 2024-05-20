import * as proto from "@ankoh/sqlynx-pb";

import { GrpcChannelArgs } from './grpc_common.js';
import { QueryExecutionProgress, QueryExecutionResponseStream } from "../connectors/query_execution.js";

export interface HyperQueryExecutionProgress extends QueryExecutionProgress { }

export interface HyperQueryResultStream extends QueryExecutionResponseStream { }

export interface HyperDatabaseConnection {
    /// Execute Query
    executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<HyperQueryResultStream>;
    /// Destroy the connection
    close(): Promise<void>;
}

export interface HyperDatabaseClient {
    /// Create a database connection
    connect(args: GrpcChannelArgs): Promise<HyperDatabaseConnection>;
}
