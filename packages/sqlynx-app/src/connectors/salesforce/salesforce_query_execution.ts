import * as proto from '@ankoh/sqlynx-protobuf';

import { HyperDatabaseChannel } from "../hyper/hyperdb_client.js";
import { QueryExecutionArgs } from "../query_execution_args.js";
import { SalesforceConnectionDetails } from "./salesforce_connection_state.js";
import { QueryExecutionResponseStream } from 'connectors/query_execution_state.js';

export interface SalesforceQueryTask {
    /// The script text
    scriptText: string;
    /// The channel
    hyperChannel: HyperDatabaseChannel;
}

export function prepareSalesforceQuery(state: SalesforceConnectionDetails, args: QueryExecutionArgs): SalesforceQueryTask {
    if (!state.channel) {
        throw new Error(`hyper channel is not set up`);
    }
    return {
        scriptText: args.query,
        hyperChannel: state.channel,
    }
}

export async function executeSalesforceQuery(task: SalesforceQueryTask): Promise<QueryExecutionResponseStream> {
    const param = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
        query: task.scriptText
    });
    return await task.hyperChannel.executeQuery(param);
}
