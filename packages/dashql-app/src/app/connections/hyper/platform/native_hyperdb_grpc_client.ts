import * as arrow from 'apache-arrow';
import * as buf from "@bufbuild/protobuf";
import * as pb from "../../../../proto.js";
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import {
    HyperDatabaseChannel,
    HyperDatabaseClient,
    HyperDatabaseConnectionContext,
    HyperQueryExecutionOptions,
    HyperQueryResultStream,
} from '../hyperdb_grpc_client.js';
import {
    NativeGrpcChannel,
    NativeGrpcClient,
    NativeGrpcProxyConfig,
    NativeGrpcServerStream,
    NativeGrpcServerStreamMessageIterator,
} from '../../../../platform/grpc/native_grpc_client.js';
import {
    createQueryResponseStreamMetrics,
    QueryExecutionProgress,
    QueryExecutionResponseStream, QueryExecutionMetrics,
    QueryExecutionStatus,
} from '../../query_execution_state.js';
import { ChannelArgs, ChannelError } from '../../../../platform/channel_common.js';
import { decodeGrpcErrorHeaders, HyperQueryError } from '../hyper_error_info.js';
import { Logger } from '../../../../platform/logger/logger.js';
import { AsyncConsumer } from '../../../../utils/async_consumer.js';
import { AsyncValue } from '../../../../utils/async_value.js';
import { yieldToBrowser } from '../../../../utils/yield_to_browser.js';

const LOG_CTX = "native_hyperdb_grpc_client";
const STREAM_YIELD_INTERVAL = 8;

export class QueryResultReader implements AsyncIterator<Uint8Array>, AsyncIterable<Uint8Array> {
    /// The gRPC stream
    grpcStream: NativeGrpcServerStream;
    /// The logger
    logger: Logger;
    /// The message iterator
    messageIterator: NativeGrpcServerStreamMessageIterator;
    /// The current status
    currentStatus: QueryExecutionStatus;
    /// The metrics
    metrics: QueryExecutionMetrics;

    constructor(stream: NativeGrpcServerStream, logger: Logger) {
        this.grpcStream = stream;
        this.logger = logger;
        this.messageIterator = new NativeGrpcServerStreamMessageIterator(this.grpcStream, logger);
        this.currentStatus = QueryExecutionStatus.RUNNING;
        this.metrics = createQueryResponseStreamMetrics();
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
            const resultMessage = buf.fromBinary(pb.salesforce_hyperdb_grpc_v1.pb.QueryResultSchema$, next.value);
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
                    this.metrics.totalDataBytesReceived += buffer.byteLength;
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
    /// The schema Promise
    resultSchema: AsyncValue<arrow.Schema<any>, Error>;

    constructor(stream: NativeGrpcServerStream, _connection: HyperDatabaseConnectionContext, logger: Logger) {
        this.resultReader = new QueryResultReader(stream, logger);
        this.resultSchema = new AsyncValue();
    }
    async cancel(): Promise<void> {
        await this.resultReader.grpcStream.destroy();
    }

    /// Get the metadata
    getMetadata(): Map<string, string> {
        return this.resultReader.metadata;
    }
    /// Get the metrics
    getMetrics(): QueryExecutionMetrics {
        return this.resultReader.metrics;
    }
    /// Get the current query status
    getStatus(): QueryExecutionStatus {
        return this.resultReader.currentStatus;
    }
    /// Await the Arrow schema
    getSchema(): Promise<arrow.Schema> {
        return this.resultSchema.getValue();
    }
    /// Produce the result batches
    async produce(batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>, _progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>, abort?: AbortSignal): Promise<void> {
        const cancel = () => { void this.cancel(); };
        abort?.addEventListener('abort', cancel, { once: true });
        try {
            const arrowReader = await arrow.AsyncRecordBatchStreamReader.from(this.resultReader);
            abort?.throwIfAborted();

            await arrowReader.open();
            abort?.throwIfAborted();
            this.resultSchema.resolve(arrowReader.schema);

            let batchesRead = 0;
            while (true) {
                const iter = await arrowReader!.next();
                abort?.throwIfAborted();
                if (iter.done) {
                    if (iter.value !== undefined) {
                        batches.resolve(this, iter.value);
                    }
                    return;
                }
                batches.resolve(this, iter.value);
                if (++batchesRead % STREAM_YIELD_INTERVAL === 0) await yieldToBrowser();
            }
        } catch (e: unknown) {
            // A failed gRPC stream surfaces as a ChannelError whose headers carry
            // the forwarded gRPC richer error model. Decode it into a structured
            // HyperQueryError so the rest of the app sees Hyper's ErrorInfo.
            if (e instanceof ChannelError) {
                const info = decodeGrpcErrorHeaders(e.headers);
                if (info) {
                    throw new HyperQueryError(info, LOG_CTX);
                }
            }
            throw e;
        } finally {
            abort?.removeEventListener('abort', cancel);
        }
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

    /// Execute a query against Hyper
    public async executeQuery(params: pb.salesforce_hyperdb_grpc_v1.pb.QueryParam, abort?: AbortSignal, options?: HyperQueryExecutionOptions): Promise<HyperQueryResultStream> {
        abort?.throwIfAborted();
        params.outputFormat = pb.salesforce_hyperdb_grpc_v1.pb.QueryParam_OutputFormat.ARROW_STREAM;
        for (const db of this.connection.getAttachedDatabases()) {
            params.database.push(buf.create(pb.salesforce_hyperdb_grpc_v1.pb.AttachedDatabaseSchema, db));
        }
        for (const [key, value] of Object.entries(this.connection.getQueryParameters())) {
            params.params[key] = value;
        }
        const stream = await this.grpcChannel.startServerStream({
            path: "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery",
            body: buf.toBinary(pb.salesforce_hyperdb_grpc_v1.pb.QueryParamSchema, params),
            readTimeoutMs: options?.readTimeoutMs,
        });
        if (abort?.aborted) {
            await stream.destroy();
            abort.throwIfAborted();
        }
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
    /// A native Hyper client
    client: NativeGrpcClient;

    constructor(config: NativeGrpcProxyConfig, logger: Logger) {
        this.logger = logger;
        this.client = new NativeGrpcClient(config, logger);
    }

    /// Create a database connection
    public async connect(hyperArgs: connection.HyperConnectionParams, connection: HyperDatabaseConnectionContext): Promise<NativeHyperDatabaseChannel> {
        const tls = hyperArgs.tls;
        const isHttps = new URL(hyperArgs.endpoint).protocol === "https:";
        const useTls = isHttps || Boolean(
            tls?.clientKeyPath || tls?.clientCertPath || tls?.caCertsPath,
        );
        if (useTls && !isHttps) {
            throw new Error("TLS certificate paths require an https:// endpoint");
        }
        const args: ChannelArgs = {
            endpoint: hyperArgs.endpoint,
            tls: useTls ? {
                keyPath: tls?.clientKeyPath,
                pubPath: tls?.clientCertPath,
                caPath: tls?.caCertsPath,
            } : undefined
        };
        const channel = await this.client.connect(args, connection);
        return new NativeHyperDatabaseChannel(channel, connection, this.logger);
    }
}
