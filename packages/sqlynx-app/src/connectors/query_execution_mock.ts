import * as arrow from 'apache-arrow';
import { QueryExecutionProgress, QueryExecutionResponseStream } from './query_execution';
import { sleep } from '../utils/sleep';

export class QueryExecutorMock implements QueryExecutionResponseStream {
    schema: arrow.Schema;
    batchCount: number;
    batchesWritten: number;

    constructor() {
        this.schema = new arrow.Schema([
            new arrow.Field('A', new arrow.Int32()),
            new arrow.Field('B', new arrow.Int32()),
            new arrow.Field('C', new arrow.Int32()),
        ]);
        this.batchCount = 1;
        this.batchesWritten = 0;
    }

    /// Get the arrow schema
    async getSchema(): Promise<arrow.Schema | null> {
        await sleep(200);
        return this.schema;
    }
    /// Await the next progress update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        await sleep(100);
        return null;
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        if (this.batchesWritten >= this.batchCount) {
            return null;
        }
        this.batchesWritten += 1;
        await sleep(400);
        const columnA = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
        const columnB = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
        const columnC = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));

        const vecA = arrow.makeData({ type: new arrow.Int32(), data: columnA });
        const vecB = arrow.makeData({ type: new arrow.Int32(), data: columnB });
        const vecC = arrow.makeData({ type: new arrow.Int32(), data: columnC });

        const data = arrow.makeData({
            type: new arrow.Struct(this.schema.fields),
            length,
            children: [vecA, vecB, vecC],
            nullCount: 0,
        });
        return new arrow.RecordBatch(this.schema, data);
    }
}
