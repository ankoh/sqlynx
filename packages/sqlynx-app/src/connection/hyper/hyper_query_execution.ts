import * as proto from '@ankoh/sqlynx-protobuf';

import { QueryExecutionArgs } from "../query_execution_args.js";
import { HyperGrpcConnectionDetails } from "./hyper_connection_state.js";
import { QueryExecutionProgress, QueryExecutionResponseStream } from '../query_execution_state.js';
import { AsyncValueTopic } from '../../utils/async_value_topic.js';

export async function executeHyperQuery(conn: HyperGrpcConnectionDetails, args: QueryExecutionArgs, updates: AsyncValueTopic<QueryExecutionProgress>): Promise<QueryExecutionResponseStream> {
    if (!conn.channel) {
        throw new Error(`hyper channel is not set up`);
    }
    const param = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
        query: args.query
    });
    return await conn.channel.executeQuery(param, updates);
}
