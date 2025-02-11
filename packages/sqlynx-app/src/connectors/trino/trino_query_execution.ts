import * as proto from '@ankoh/sqlynx-protobuf';

import { QueryExecutionResponseStream } from "../query_execution_state.js";
import { QueryExecutionArgs } from "../query_execution_args.js";
import { TrinoChannelInterface } from "./trino_channel.js";
import { TrinoConnectionDetails } from "./trino_connection_state.js";

export interface TrinoQueryTask {
    /// The script text
    scriptText: string;
    /// Trino channel
    trinoChannel: TrinoChannelInterface;
}

export function prepareTrinoQuery(state: TrinoConnectionDetails, args: QueryExecutionArgs): TrinoQueryTask {
    if (!state.channel) {
        throw new Error(`trino channel is not set up`);
    }
    return {
        scriptText: args.query,
        trinoChannel: state.channel,
    }
}

export async function executeTrinoQuery(task: TrinoQueryTask): Promise<QueryExecutionResponseStream> {
    const param = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
        query: task.scriptText
    });
    return await task.trinoChannel.executeQuery(param);
}
