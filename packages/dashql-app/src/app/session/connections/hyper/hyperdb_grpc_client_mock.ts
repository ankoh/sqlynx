import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import * as pb from "../../../../proto.js";

import { HyperDatabaseChannel, HyperDatabaseClient, HyperDatabaseConnectionContext, HyperQueryResultStream } from "./hyperdb_grpc_client.js";
import { QueryExecutionResponseStreamMock } from "../query_execution_mock.js";

export class HyperDatabaseChannelMock implements HyperDatabaseChannel {
    /// Execute Query
    async executeQuery(_param: pb.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<HyperQueryResultStream> {
        return new QueryExecutionResponseStreamMock();

    }
    /// Destroy the connection
    async close(): Promise<void> {

    }
}

export class HyperDatabaseClientMock implements HyperDatabaseClient {
    /// Create a database connection
    async connect(_args: connection.HyperConnectionParams, _context: HyperDatabaseConnectionContext): Promise<HyperDatabaseChannel> {
        return new HyperDatabaseChannelMock();
    }
}
