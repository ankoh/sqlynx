import * as hyper from '@ankoh/hyper-service';
import { createPromiseClient, PromiseClient } from '@connectrpc/connect';
import * as bufconnect from '@connectrpc/connect-web';
import { QueryExecutionProgress, QueryExecutionResponseStream } from './query_execution';
import { RecordBatch, Schema } from 'apache-arrow';

export class HyperResultStream implements QueryExecutionResponseStream {
    stream: AsyncIterator<hyper.pb.QueryResult>;

    constructor(stream: AsyncIterator<hyper.pb.QueryResult>) {
        this.stream = stream;
    }

    async getSchema(): Promise<Schema<any> | null> {
        while (true) {
            console.log('getSchema loop');
            const next = await this.stream.next();
            if (next.done) {
                console.log('stream done');
                return null;
            }
            switch (next.value.result.case) {
                case 'header':
                    console.log('RECEIVED HEADER');
                    break;
                case 'arrowChunk':
                    console.log('RECEIVED ARROW SCHEMA CHUNK');
                    // First arrow chunk, read schema from it
                    return null;
                case 'qsv1Chunk':
                    break;
            }
        }
    }
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return null;
    }
    async nextRecordBatch(): Promise<RecordBatch<any> | null> {
        while (true) {
            const next = await this.stream.next();
            if (next.done) {
                return null;
            }
            switch (next.value.result.case) {
                case 'header':
                    console.log('RECEIVED UNEXPECTED HEADER');
                    break;
                case 'arrowChunk':
                    console.log('RECEIVED ARROW SCHEMA CHUNK');
                    // First arrow chunk, read schema from it
                    break;
                case 'qsv1Chunk':
                    break;
            }
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

        const headers = new Headers();
        headers.set('Authorization', `Bearer ${token}`);
        headers.set('X-Trace-Id', 'akohn-connect-es');
        return this.client.executeQuery(request, { headers });
    }
}
