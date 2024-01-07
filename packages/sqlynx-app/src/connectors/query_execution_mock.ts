import * as arrow from 'apache-arrow';
import { QueryExecutionProgress, QueryExecutionResponseStream } from './query_execution';

export class QueryExecutorMock implements QueryExecutionResponseStream {
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
