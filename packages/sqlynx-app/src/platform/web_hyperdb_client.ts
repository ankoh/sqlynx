import * as hyper from '@ankoh/sqlynx-protobuf';
import * as arrow from 'apache-arrow';
import * as bufconnect from '@connectrpc/connect-web';

import { createPromiseClient, PromiseClient } from '@connectrpc/connect';
import { Logger } from "./logger.js";
import {
    createQueryResponseStreamMetrics,
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionMetrics,
    QueryExecutionStatus,
} from '../connection/query_execution_state.js';
import { AsyncConsumer } from '../utils/async_consumer.js';
import { AsyncValue } from 'utils/async_value.js';

export class QueryResultReader implements AsyncIterator<Uint8Array>, AsyncIterable<Uint8Array> {
    /// The logger
    logger: Logger;
    /// The query result messages
    stream: AsyncIterator<hyper.salesforce_hyperdb_grpc_v1.pb.QueryResult>;
    /// The current status
    currentStatus: QueryExecutionStatus;
    /// The metrics
    metrics: QueryExecutionMetrics;

    constructor(stream: AsyncIterator<hyper.salesforce_hyperdb_grpc_v1.pb.QueryResult>, logger: Logger) {
        this.stream = stream;
        this.logger = logger;
        this.currentStatus = QueryExecutionStatus.RUNNING;
        this.metrics = createQueryResponseStreamMetrics();
    }

    async next(): Promise<IteratorResult<Uint8Array>> {
        while (true) {
            const next = await this.stream.next();
            if (next.done) {
                return { done: true, value: null };
            } else {
                switch (next.value.result.case) {
                    case 'header':
                    case 'qsv1Chunk':
                        break;
                    case 'arrowChunk': {
                        const buffer = next.value.result.value.data;
                        this.metrics.totalDataBytesReceived += buffer.byteLength;
                        return { done: false, value: buffer };
                    }
                }
            }
        }
    }

    [Symbol.asyncIterator]() {
        return this;
    }
}

export class WebHyperQueryResultStream implements QueryExecutionResponseStream {
    /// The query result iterator
    resultReader: QueryResultReader;
    /// The schema Promise
    resultSchema: AsyncValue<arrow.Schema<any>, Error>;

    constructor(stream: AsyncIterator<hyper.salesforce_hyperdb_grpc_v1.pb.QueryResult>, logger: Logger) {
        this.resultReader = new QueryResultReader(stream, logger);
        this.resultSchema = new AsyncValue();
    }

    /// Get the metadata
    getMetadata(): Map<string, string> {
        // XXX Remember trailers
        return new Map();
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
    getSchema(): Promise<arrow.Schema<any>> {
        return this.resultSchema.getValue();
    }
    /// Produce the result batches
    async produce(batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>, _progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>, abort?: AbortSignal): Promise<void> {
        // Setup the arrow reader
        const arrowReader = await arrow.AsyncRecordBatchStreamReader.from(this.resultReader);
        abort?.throwIfAborted();

        // Open the arrow reader
        await arrowReader.open();
        abort?.throwIfAborted();
        this.resultSchema.resolve(arrowReader.schema);

        while (true) {
            const iter = await arrowReader!.next();
            abort?.throwIfAborted();
            if (iter.done) {
                if (iter.value !== undefined) {
                    batches.resolve(this, iter.value);
                }
            } else {
                batches.resolve(this, iter.value);
            }
        }
    }
}

export class HyperServiceChannel {
    client: PromiseClient<typeof hyper.salesforce_hyperdb_grpc_v1.grpc.HyperService>;
    public url: string;

    constructor(url: string, credentials?: RequestCredentials) {
        this.url = url;
        const transport = bufconnect.createGrpcWebTransport({
            baseUrl: url,
            credentials,
        });
        this.client = createPromiseClient(hyper.salesforce_hyperdb_grpc_v1.grpc.HyperService, transport);
    }
    public executeQuery(text: string, token: string): AsyncIterable<hyper.salesforce_hyperdb_grpc_v1.pb.QueryResult> {
        const request = new hyper.salesforce_hyperdb_grpc_v1.pb.QueryParam();
        request.query = text;
        request.outputFormat = hyper.salesforce_hyperdb_grpc_v1.pb.QueryParam_OutputFormat.ARROW_STREAM;
        // request.database = [
        //     new hyper.pb.AttachedDatabase({
        //         path: 'hyper.external:lakehouse_a360_falcondev_cb1b20c5c1b449969b9b3da9f8e0fce6',
        //     }),
        // ];

        const headers = new Headers();
        headers.set('Authorization', `Bearer ${token}`);
        headers.set('X-Trace-Id', 'akohn-connect-es');
        return this.client.executeQuery(request, { headers });
    }
}

