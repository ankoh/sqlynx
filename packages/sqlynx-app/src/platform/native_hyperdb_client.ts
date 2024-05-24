import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-pb';

import {
    HealthCheckStatus,
    HyperDatabaseChannel,
    HyperDatabaseClient,
    HyperDatabaseConnectionContext,
    HyperQueryResultStream,
} from './hyperdb_client.js';
import {
    NativeGrpcChannel,
    NativeGrpcClient,
    NativeGrpcProxyConfig,
    NativeGrpcServerStream,
    NativeGrpcServerStreamMessageIterator,
} from './native_grpc_client.js';
import {
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionStatus,
} from '../connectors/query_execution.js';
import { GrpcChannelArgs } from './grpc_common.js';
import { Logger } from './logger.js';

export class QueryResultReader implements AsyncIterator<Uint8Array>, AsyncIterable<Uint8Array> {
    /// The gRPC stream
    grpcStream: NativeGrpcServerStream;
    /// The logger
    logger: Logger;
    /// The message iterator
    messageIterator: NativeGrpcServerStreamMessageIterator;
    /// The current status
    currentStatus: QueryExecutionStatus;

    constructor(stream: NativeGrpcServerStream, logger: Logger) {
        this.grpcStream = stream;
        this.logger = logger;
        this.messageIterator = new NativeGrpcServerStreamMessageIterator(this.grpcStream, logger);
        this.currentStatus = QueryExecutionStatus.STARTED;
    }

    /// Get the next binary result chunk
    async next(): Promise<IteratorResult<Uint8Array>> {
        while (true) {
            const next = await this.messageIterator.next();
            if (next.value == null) {
                return { done: true, value: null };
            }
            const resultMessage = proto.salesforce_hyperdb_grpc_v1.pb.QueryResult.fromBinary(next.value);
            switch (resultMessage.result.case) {
                case "header":
                case "qsv1Chunk":
                    break;
                case "arrowChunk":
                    return { done: false, value: resultMessage.result.value.data };
            }
        }
    }

    /// Get the async iterator
    [Symbol.asyncIterator]() {
        return this;
    }
}

/// A native Hyper query result stream
export class NativeHyperQueryResultStream implements QueryExecutionResponseStream {
    /// The query result iterator
    resultReader: QueryResultReader;
    /// An arrow reader
    arrowReader: arrow.RecordBatchReader | null;

    constructor(stream: NativeGrpcServerStream, connection: HyperDatabaseConnectionContext, logger: Logger) {
        this.resultReader = new QueryResultReader(stream, logger);
        this.arrowReader = null;
    }

    /// Open the stream if the setup is pending
    protected async setupArrowReader(): Promise<void> {
        this.arrowReader = await arrow.AsyncRecordBatchStreamReader.from(this.resultReader);
        await this.arrowReader.open();
    }
    /// Get the current query status
    getStatus(): QueryExecutionStatus {
        return this.resultReader.currentStatus;
    }
    /// Await the Arrow schema
    async getSchema(): Promise<arrow.Schema> {
        if (this.arrowReader == null) {
            await this.setupArrowReader();
        }
        return this.arrowReader!.schema;
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        if (this.arrowReader == null) {
            await this.setupArrowReader();
        }
        return this.arrowReader!.next();
    }
    /// Await the next progress update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return null;
    }
}

/// A native Hyper database connection
class NativeHyperDatabaseChannel implements HyperDatabaseChannel {
    /// A gRPC channel
    grpcChannel: NativeGrpcChannel;
    /// The connection context
    connection: HyperDatabaseConnectionContext;
    /// A logger
    logger: Logger;

    constructor(channel: NativeGrpcChannel, connection: HyperDatabaseConnectionContext, logger: Logger) {
        this.grpcChannel = channel;
        this.connection = connection;
        this.logger = logger;
    }

    /// Check if Hyper is reachable
    public async checkHealth(): Promise<HealthCheckStatus> {
        return HealthCheckStatus.OK;
    }

    /// Execute a query against Hyper
    public async executeQuery(params: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<HyperQueryResultStream> {
        for (const db of this.connection.getAttachedDatabases()) {
            params.database.push(new proto.salesforce_hyperdb_grpc_v1.pb.AttachedDatabase(db))
        }
        const stream = await this.grpcChannel.startServerStream({
            path: "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery",
            body: params.toBinary(),
        });
        return new NativeHyperQueryResultStream(stream, this.connection, this.logger);
    }

    /// Close the connection
    public async close(): Promise<void> {
        await this.grpcChannel.close();
    }
}

/// A native Hyper database client
export class NativeHyperDatabaseClient implements HyperDatabaseClient {
    /// A logger
    logger: Logger;
    /// A native Hyper gRPC client
    client: NativeGrpcClient;

    constructor(config: NativeGrpcProxyConfig, logger: Logger) {
        this.logger = logger;
        this.client = new NativeGrpcClient(config, logger);
    }

    /// Create a database connection
    public async connect(args: GrpcChannelArgs, connection: HyperDatabaseConnectionContext): Promise<NativeHyperDatabaseChannel> {
        const channel = await this.client.connect(args, connection);
        return new NativeHyperDatabaseChannel(channel, connection, this.logger);
    }
}
