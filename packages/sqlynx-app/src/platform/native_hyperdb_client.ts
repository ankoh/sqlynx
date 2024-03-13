import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/hyperdb-proto";

import { HyperDatabaseClient, HyperDatabaseConnection, HyperQueryExecutionProgress, HyperQueryExecutionStatus, HyperQueryResultStream } from "./platform_hyperdb_client.js";
import { NativeGrpcChannel, NativeGrpcClient, NativeGrpcEndpoint, NativeGrpcServerStream } from './native_grpc_client.js';

class NativeHyperQueryResultStream extends NativeGrpcServerStream implements HyperQueryResultStream {

    constructor(endpoint: NativeGrpcEndpoint, channelId: number, streamId: number) {
        super(endpoint, channelId, streamId);
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

class NativeHyperDatabaseConnection extends NativeGrpcChannel implements HyperDatabaseConnection {
    constructor(endpoint: NativeGrpcEndpoint, channelId: number) {
        super(endpoint, channelId);
    }

    /// Execute Query
    public async executeQuery(_param: proto.pb.QueryParam): Promise<HyperQueryResultStream> {
        return new NativeHyperQueryResultStream(this.endpoint, 0, 0);
    }
}

export class NativeHyperDatabaseClient extends NativeGrpcClient implements HyperDatabaseClient {
    constructor(endpoint: NativeGrpcEndpoint) {
        super(endpoint);
    }

    /// Create a database connection
    public async connect(): Promise<HyperDatabaseConnection> {
        return new NativeHyperDatabaseConnection(this.endpoint, 0);
    }
}
