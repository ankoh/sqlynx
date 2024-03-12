import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/hyperdb-proto";

import { HyperDatabaseClient, HyperDatabaseConnection, HyperQueryExecutionProgress, HyperQueryExecutionStatus, HyperQueryResultStream } from "./platform_hyperdb_client.js";

class QueryResultStream implements HyperQueryResultStream {
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

class DatabaseConnection implements HyperDatabaseConnection {
    /// Execute Query
    public async executeQuery(_param: proto.pb.QueryParam): Promise<HyperQueryResultStream> {
        return new QueryResultStream();
    }
}

export class NativeHyperDatabaseClient implements HyperDatabaseClient {
    /// Create a database connection
    public async connect(): Promise<HyperDatabaseConnection> {
        return new DatabaseConnection();
    }
}
