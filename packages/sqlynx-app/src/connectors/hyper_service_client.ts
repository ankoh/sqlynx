import * as hyper from '@ankoh/hyper-service';
import * as arrow from 'apache-arrow';

import { createPromiseClient, PromiseClient } from '@connectrpc/connect';
import * as bufconnect from '@connectrpc/connect-web';
import { QueryExecutionProgress, QueryExecutionResponseStream } from './query_execution';
import { RecordBatch, Schema } from 'apache-arrow';

export class ArrowChunkStreamReader implements AsyncIterable<Uint8Array> {
    /** In-flight */
    protected _stream: AsyncIterator<hyper.pb.QueryResult>;

    constructor(protected readonly stream: AsyncIterator<hyper.pb.QueryResult>) {
        this._stream = stream;
    }

    async next(): Promise<IteratorResult<Uint8Array>> {
        while (true) {
            const next = await this._stream.next();
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

export class HyperResultStream implements QueryExecutionResponseStream {
    stream: ArrowChunkStreamReader;
    arrowReader: arrow.RecordBatchReader | null;

    constructor(stream: AsyncIterator<hyper.pb.QueryResult>) {
        this.stream = new ArrowChunkStreamReader(stream);
        this.arrowReader = null;
    }

    async getSchema(): Promise<Schema<any> | null> {
        this.arrowReader = await arrow.AsyncRecordBatchStreamReader.from(this.stream);
        await this.arrowReader.open();
        return this.arrowReader.schema;
    }
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return null;
    }
    async nextRecordBatch(): Promise<RecordBatch<any> | null> {
        const result = await this.arrowReader!.next();
        if (result.done) {
            return null;
        } else {
            return result.value;
        }
    }
}

export class HyperServiceClient {
    client: PromiseClient<typeof hyper.grpc.HyperService>;
    public url: string;

    constructor(url: string, credentials?: RequestCredentials) {
        this.url = url;
        const transport = bufconnect.createGrpcWebTransport({
            baseUrl: url,
            credentials,
        });
        this.client = createPromiseClient(hyper.grpc.HyperService, transport);
    }
    public executeQuery(text: string, token: string): AsyncIterable<hyper.pb.QueryResult> {
        const request = new hyper.pb.QueryParam();
        request.query = text;
        request.outputFormat = hyper.pb.QueryParam_OutputFormat.ARROW_STREAM;
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
