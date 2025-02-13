import * as arrow from 'apache-arrow';
import * as proto from '@ankoh/sqlynx-protobuf';

import {
    HealthCheckResult,
    HyperDatabaseChannel,
    HyperDatabaseClient,
    HyperDatabaseConnectionContext,
    HyperQueryResultStream,
} from '../connection/hyper/hyperdb_client.js';
import {
    NativeGrpcChannel,
    NativeGrpcClient,
    NativeGrpcProxyConfig,
    NativeGrpcServerStream,
    NativeGrpcServerStreamMessageIterator,
} from './native_grpc_client.js';
import {
    QueryExecutionProgress,
    QueryExecutionResponseStream, QueryExecutionResponseStreamMetrics,
    QueryExecutionStatus,
} from '../connection/query_execution_state.js';
import { ChannelArgs } from './channel_common.js';
import { Logger } from './logger.js';

const LOG_CTX = "native_hyperdb_client";

export class QueryResultReader implements AsyncIterator<Uint8Array>, AsyncIterable<Uint8Array> {
    /// The gRPC stream
    grpcStream: NativeGrpcServerStream;
    /// The logger
    logger: Logger;
    /// The message iterator
    messageIterator: NativeGrpcServerStreamMessageIterator;
    /// The current status
    currentStatus: QueryExecutionStatus;
    /// The total data bytes
    dataBytes: number;

    constructor(stream: NativeGrpcServerStream, logger: Logger) {
        this.grpcStream = stream;
        this.logger = logger;
        this.messageIterator = new NativeGrpcServerStreamMessageIterator(this.grpcStream, logger);
        this.currentStatus = QueryExecutionStatus.STARTED;
        this.dataBytes = 0;
    }

    /// Get the result metadata (if any)
    get metadata() { return this.messageIterator.metadata; }
    /// Get the next binary result chunk
    async next(): Promise<IteratorResult<Uint8Array>> {
        while (true) {
            const next = await this.messageIterator.next();
            if (next.value == null) {
                return { done: true, value: null };
            }
            const resultMessage = proto.salesforce_hyperdb_grpc_v1.pb.QueryResult.fromBinary(next.value);
            switch (resultMessage.result.case) {
                // We skip any dedicated header prefix
                case "header":
                    continue;
                // Skip qsv1 chunks
                case "qsv1Chunk":
                    throw new Error("invalid result data message. expected arrowChunk, received qsv1Chunk");
                // Unpack an arrow chunk
                case "arrowChunk": {
                    const buffer = resultMessage.result.value.data;
                    this.dataBytes += buffer.byteLength;
                    return { done: false, value: buffer };
                }
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

    constructor(stream: NativeGrpcServerStream, _connection: HyperDatabaseConnectionContext, logger: Logger) {
        this.resultReader = new QueryResultReader(stream, logger);
        this.arrowReader = null;
    }

    /// Open the stream if the setup is pending
    protected async setupArrowReader(): Promise<void> {
        this.arrowReader = await arrow.AsyncRecordBatchStreamReader.from(this.resultReader);
        await this.arrowReader.open();
    }
    /// Get the metadata
    getMetadata(): Map<string, string> {
        return this.resultReader.metadata;
    }
    /// Get the metrics
    getMetrics(): QueryExecutionResponseStreamMetrics {
        return {
            dataBytes: this.resultReader.dataBytes
        };
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
        const result = await this.arrowReader!.next();
        if (result.done) {
            return null;
        } else {
            return result.value;
        }
    }
    /// Await the next query_status update
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
    public async checkHealth(): Promise<HealthCheckResult> {
        try {
            const result = await this.executeQuery(new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
                query: "select 1 as healthy"
            }));
            const schema = await result.getSchema();
            if (schema == null) {
                return { ok: false, errorMessage: "query result did not include a schema" };
            }
            if (schema.fields.length != 1) {
                return { ok: false, errorMessage: `unexpected number of fields in the query result schema: expected 1, received ${schema.fields.length}` };
            }
            const field = schema.fields[0];
            if (field.name != "healthy") {
                return { ok: false, errorMessage: `unexpected field name in the query result schema: expected 'healthy', received '${field.name}'` };
            }
            const batch = await result.nextRecordBatch();
            if (batch == null) {
                return { ok: false, errorMessage: "query result did not include a record batch" };
            }
            const healthyColumn = batch.getChildAt(0)!;
            if (healthyColumn == null) {
                return { ok: false, errorMessage: "query result batch did not include any data" };
            }
            if (healthyColumn.length != 1) {
                return { ok: false, errorMessage: `query result batch contains an unexpected number of rows: expected 1, received ${healthyColumn.length}` };
            }
            const healthyRow = healthyColumn.get(0);
            if (healthyRow !== 1) {
                return { ok: false, errorMessage: `health check query returned an unexpected result` };
            }
            return { ok: true, errorMessage: null };
        } catch (e: any) {
            if (e.grpcStatus) {
                this.logger.warn(`health check failed: grcp_status=${e.grpcStatus}`, LOG_CTX);
            } else {
                this.logger.warn(`health check failed: message=${e.message}`, LOG_CTX);
            }
            return { ok: false, errorMessage: e.toString() };
        }
    }

    /// Execute a query against Hyper
    public async executeQuery(params: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<HyperQueryResultStream> {
        params.outputFormat = proto.salesforce_hyperdb_grpc_v1.pb.QueryParam_OutputFormat.ARROW_STREAM;
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
    public async connect(args: ChannelArgs, connection: HyperDatabaseConnectionContext): Promise<NativeHyperDatabaseChannel> {
        const channel = await this.client.connect(args, connection);
        return new NativeHyperDatabaseChannel(channel, connection, this.logger);
    }
}
