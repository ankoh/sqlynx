import * as proto from '@ankoh/sqlynx-protobuf';

import { QueryExecutionArgs } from "../query_execution_args.js";
import { HyperGrpcConnectionDetails } from "./hyper_connection_state.js";
import { HyperDatabaseChannel } from "./hyperdb_client.js";
import { QueryExecutionResponseStream } from 'connectors/query_execution_state.js';

export interface HyperGrpcQueryTask {
    /// The script text
    scriptText: string;
    /// The channel
    hyperChannel: HyperDatabaseChannel;
}

export function prepareHyperGrpcQuery(state: HyperGrpcConnectionDetails, args: QueryExecutionArgs): HyperGrpcQueryTask {
    if (!state.channel) {
        throw new Error(`hyper channel is not set up`);
    }
    return {
        scriptText: args.query,
        hyperChannel: state.channel,
    }
}

export async function executeHyperQuery(task: HyperGrpcQueryTask): Promise<QueryExecutionResponseStream> {
    const param = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
        query: task.scriptText
    });
    return await task.hyperChannel.executeQuery(param);
}
