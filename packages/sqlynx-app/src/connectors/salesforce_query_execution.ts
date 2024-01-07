import * as arrow from 'apache-arrow';
import { QueryExecutionProgress, QueryExecutionResponseStream } from './query_execution';
import { SalesforceAPIClientInterface, SalesforceDataCloudAccessToken } from './salesforce_api_client';

export interface ExecuteDataCloudQueryTask {
    api: SalesforceAPIClientInterface;
    accessToken: SalesforceDataCloudAccessToken;
    scriptText: string;
}

class Foo implements QueryExecutionResponseStream {
    /// Get the arrow schema
    async getSchema(): Promise<arrow.Schema | null> {
        return null;
    }
    /// Await the next progress update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return null;
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        return null;
    }
}

export function executeQuery(task: ExecuteDataCloudQueryTask): QueryExecutionResponseStream {
    // XXX
    return new Foo();
}
