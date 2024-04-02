import * as proto from "@ankoh/sqlynx-pb";

import { HyperDatabaseClient, HyperDatabaseConnection, HyperQueryExecutionStatus, HyperQueryResultStream } from "./hyperdb_client.js";
import { NativeGrpcChannel, NativeGrpcClient, NativeGrpcProxyConfig, NativeGrpcServerStream, NativeGrpcServerStreamMessageIterator } from './native_grpc_client.js';
import { GrpcChannelArgs } from './grpc_common.js';
import { Logger } from "./logger.js";


class NativeHyperQueryResultStream implements HyperQueryResultStream {
    logger: Logger;
    grpcStream: NativeGrpcServerStream;
    messageIterator: NativeGrpcServerStreamMessageIterator;
    currentStatus: HyperQueryExecutionStatus;

    constructor(stream: NativeGrpcServerStream, logger: Logger) {
        this.logger = logger;
        this.grpcStream = stream;
        this.messageIterator = new NativeGrpcServerStreamMessageIterator(this.grpcStream, logger);
        this.currentStatus = HyperQueryExecutionStatus.STARTED;
    }

    /// Get the query execution status
    public getStatus(): HyperQueryExecutionStatus {
        return this.currentStatus;
    }

    /// Get the next result chunk
    protected async getNextResultChunk(): Promise<Uint8Array | null> {
        while (true) {
            const next = await this.messageIterator.next();
            if (next.value == null) {
                return null;
            }
            const resultMessage = proto.salesforce_hyperdb_grpc_v1.pb.QueryResult.fromBinary(next.value);
            switch (resultMessage.result.case) {
                case "header":
                case "qsv1Chunk":
                    break;
                case "arrowChunk":
                    return resultMessage.result.value.data;
            }
        }
    }

    /// Get the next buffer
    public async next(): Promise<IteratorResult<Uint8Array>> {
        const next = await this.getNextResultChunk();
        if (next == null) {
            return { value: undefined, done: true };
        } else {
            return { value: next, done: false };
        }
    }
}

class NativeHyperDatabaseConnection implements HyperDatabaseConnection {
    logger: Logger;
    grpcChannel: NativeGrpcChannel;

    constructor(channel: NativeGrpcChannel, logger: Logger) {
        this.logger = logger;
        this.grpcChannel = channel;
    }

    /// Execute a query against Hyper
    public async executeQuery(params: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<NativeHyperQueryResultStream> {
        const stream = await this.grpcChannel.startServerStream({
            path: "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery",
            body: params.toBinary(),
        });
        return new NativeHyperQueryResultStream(stream, this.logger);
    }

    /// Close the connection
    public async close(): Promise<void> {
        await this.grpcChannel.close();
    }
}

export class NativeHyperDatabaseClient implements HyperDatabaseClient {
    logger: Logger;
    client: NativeGrpcClient;

    constructor(config: NativeGrpcProxyConfig, logger: Logger) {
        this.logger = logger;
        this.client = new NativeGrpcClient(config, logger);
    }

    /// Create a database connection
    public async connect(args: GrpcChannelArgs): Promise<NativeHyperDatabaseConnection> {
        const channel = await this.client.connect(args);
        return new NativeHyperDatabaseConnection(channel, this.logger);
    }
}
