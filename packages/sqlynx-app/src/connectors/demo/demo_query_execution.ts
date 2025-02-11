import * as proto from '@ankoh/sqlynx-protobuf';

import { QueryExecutionArgs } from "connectors/query_execution_args.js";
import { DemoConnectionParams } from "./demo_connection_state.js";
import { DemoDatabaseChannel } from "./demo_database_channel.js";
import { QueryExecutionResponseStream } from "../query_execution_state.js";

export interface DemoQueryTask {
    /// The script text
    scriptText: string;
    /// The channel
    demoChannel: DemoDatabaseChannel;
}

export function prepareDemoQuery(state: DemoConnectionParams, args: QueryExecutionArgs): DemoQueryTask {
    if (!state.channel) {
        throw new Error(`hyper channel is not set up`);
    }
    return {
        scriptText: args.query,
        demoChannel: state.channel,
    }
}

export async function executeDemoQuery(task: DemoQueryTask): Promise<QueryExecutionResponseStream> {
    const param = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
        query: task.scriptText
    });
    return await task.demoChannel.executeQuery(param);
}
