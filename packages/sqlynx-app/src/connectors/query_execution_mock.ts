import * as arrow from 'apache-arrow';
import { QueryExecutionProgress, QueryExecutionResponseStream } from './query_execution';
import { sleep } from '../utils/sleep';

export class QueryExecutorMock implements QueryExecutionResponseStream {
    schema: arrow.Schema;

    constructor() {
        this.schema = new arrow.Schema([
            new arrow.Field('A', new arrow.Int32()),
            new arrow.Field('B', new arrow.Int32()),
            new arrow.Field('C', new arrow.Int32()),
            new arrow.Field('D', new arrow.Utf8()),
            new arrow.Field('F', new arrow.Utf8()),
        ]);
    }

    /// Get the arrow schema
    async getSchema(): Promise<arrow.Schema | null> {
        await sleep(200);
        return this.schema;
    }
    /// Await the next progress update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        await sleep(100);
        return {};
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        await sleep(400);
        return new arrow.RecordBatch(this.schema);
    }
}
