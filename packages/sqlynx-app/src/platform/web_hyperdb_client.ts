import * as hyper from '@ankoh/sqlynx-pb';
import * as arrow from 'apache-arrow';
import * as bufconnect from '@connectrpc/connect-web';

import { createPromiseClient, PromiseClient } from '@connectrpc/connect';
import { Logger } from "./logger.js";
import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionStatus } from '../connectors/query_execution.js';

export class QueryResultReader implements AsyncIterator<Uint8Array>, AsyncIterable<Uint8Array> {
    /// The logger
    logger: Logger;
    /// The query result messages
    stream: AsyncIterator<hyper.salesforce_hyperdb_grpc_v1.pb.QueryResult>;
    /// The current status
    currentStatus: QueryExecutionStatus;

    constructor(stream: AsyncIterator<hyper.salesforce_hyperdb_grpc_v1.pb.QueryResult>, logger: Logger) {
        this.stream = stream;
        this.logger = logger;
        this.currentStatus = QueryExecutionStatus.STARTED;
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
    /// An arrow reader
    arrowReader: arrow.RecordBatchReader | null;

    constructor(stream: AsyncIterator<hyper.salesforce_hyperdb_grpc_v1.pb.QueryResult>, logger: Logger) {
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
    async getSchema(): Promise<arrow.Schema<any> | null> {
        if (this.arrowReader == null) {
            await this.setupArrowReader();
        }
        return this.arrowReader!.schema;
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch<any> | null> {
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

export class HyperServiceClient {
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

