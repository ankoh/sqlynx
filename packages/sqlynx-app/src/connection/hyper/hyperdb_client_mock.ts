import * as proto from "@ankoh/sqlynx-protobuf";

import { ChannelArgs } from '../../platform/channel_common.js';
import { HealthCheckResult, HyperDatabaseChannel, HyperDatabaseClient, HyperDatabaseConnectionContext, HyperQueryResultStream } from "./hyperdb_client.js";
import { QueryExecutionResponseStreamMock } from "../query_execution_mock.js";

export class HyperDatabaseChannelMock implements HyperDatabaseChannel {
    /// Perform a health check
    async checkHealth(): Promise<HealthCheckResult> {
        return {
            ok: true,
            error: null,
        };
    }
    /// Execute Query
    async executeQuery(_param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<HyperQueryResultStream> {
        return new QueryExecutionResponseStreamMock();

    }
    /// Destroy the connection
    async close(): Promise<void> {

    }
}

export class HyperDatabaseClientMock implements HyperDatabaseClient {
    /// Create a database connection
    async connect(_args: ChannelArgs, _context: HyperDatabaseConnectionContext): Promise<HyperDatabaseChannel> {
        return new HyperDatabaseChannelMock();
    }
}
