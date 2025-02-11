import * as proto from '@ankoh/sqlynx-protobuf';

import { QueryExecutionArgs } from "../query_execution_args.js";
import { SalesforceConnectionDetails } from "./salesforce_connection_state.js";
import { QueryExecutionResponseStream } from 'connectors/query_execution_state.js';

export async function executeSalesforceQuery(conn: SalesforceConnectionDetails, args: QueryExecutionArgs): Promise<QueryExecutionResponseStream> {
    // Is the Hyper missing?
    if (!conn.channel) {
        throw new Error(`hyper channel is not set up`);
    }
    // Execute a query
    const param = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
        query: args.query
    });
    return await conn.channel.executeQuery(param);
}
