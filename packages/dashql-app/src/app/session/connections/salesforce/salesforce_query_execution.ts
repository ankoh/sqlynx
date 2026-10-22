import * as proto from '../../../../proto.js';
import * as buf from "@bufbuild/protobuf";

import { QueryExecutionArgs } from "../query_execution_args.js";
import { SalesforceConnectionStateDetails } from "./salesforce_connection_state.js";
import { QueryExecutionResponseStream } from '../query_execution_state.js';

export async function executeSalesforceQuery(conn: SalesforceConnectionStateDetails, args: QueryExecutionArgs, abort?: AbortSignal): Promise<QueryExecutionResponseStream> {
    const channel = args.channelOverride?.type === 'salesforce' ? args.channelOverride.channel : conn.channel;
    if (!channel) {
        throw new Error(`Hyper channel is not set up`);
    }
    const param = buf.create(proto.salesforce_hyperdb_grpc_v1.pb.QueryParamSchema, {
        query: args.query
    });
    return await channel.executeQuery(param, abort);
}
