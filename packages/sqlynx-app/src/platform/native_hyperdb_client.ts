import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/hyperdb-proto";

import { HyperDatabaseClient, HyperDatabaseConnection, HyperQueryExecutionProgress, HyperQueryExecutionStatus, HyperQueryResultStream } from "./platform_hyperdb_client.js";
import { NativeGrpcChannel, NativeGrpcClient, NativeGrpcProxyConfig, NativeGrpcServerStream } from './native_grpc_client.js';
import { GrpcChannelArgs } from './grpc_common.js';

class NativeHyperQueryResultStream implements HyperQueryResultStream {
    grpcStream: NativeGrpcServerStream;

    constructor(stream: NativeGrpcServerStream) {
        this.grpcStream = stream;
    }

    /// Get the schema message
    public async getSchema(): Promise<arrow.Schema | null> {
        return null;
    }
    /// Get the query execution status
    public async getStatus(): Promise<HyperQueryExecutionStatus | null> {
        return null;
    }
    /// Get the next progress update
    public async nextProgressUpdate(): Promise<HyperQueryExecutionProgress | null> {
        return null;
    }
    /// Get the next record batch
    public async nextRecordBatch(): Promise<arrow.RecordBatch<any> | null> {
        return null;
    }
}

class NativeHyperDatabaseConnection implements HyperDatabaseConnection {
    channel: NativeGrpcChannel;

    constructor(channel: NativeGrpcChannel) {
        this.channel = channel;
    }

    /// Execute a query against Hyper
    public async executeQuery(params: proto.pb.QueryParam): Promise<HyperQueryResultStream> {
        const stream = await this.channel.startServerStream({
            path: "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery",
            body: params.toBinary(),
        });
        return new NativeHyperQueryResultStream(stream);
    }
}

export class NativeHyperDatabaseClient implements HyperDatabaseClient {
    client: NativeGrpcClient;

    constructor(config: NativeGrpcProxyConfig) {
        this.client = new NativeGrpcClient(config);
    }

    /// Create a database connection
    public async connect(args: GrpcChannelArgs): Promise<HyperDatabaseConnection> {
        const channel = await this.client.connect(args);
        return new NativeHyperDatabaseConnection(channel);
    }
}
