import * as arrow from 'apache-arrow';
import {
    QueryExecutionProgress,
    QueryExecutionResponseStream, QueryExecutionMetrics,
    QueryExecutionStatus,
    createQueryResponseStreamMetrics,
} from './query_execution_state.js';
import { sleep } from '../utils/sleep.js';
import { AsyncConsumer } from '../utils/async_consumer.js';

export class QueryExecutionResponseStreamMock implements QueryExecutionResponseStream {
    schema: arrow.Schema;
    batchCount: number;
    batchesWritten: number;
    metrics: QueryExecutionMetrics;

    constructor() {
        this.schema = new arrow.Schema([
            new arrow.Field('A', new arrow.Int32()),
            new arrow.Field('B', new arrow.Int32()),
            new arrow.Field('C', new arrow.Int32()),
        ]);
        this.batchCount = 1;
        this.batchesWritten = 0;
        this.metrics = createQueryResponseStreamMetrics();
    }

    /// Get the metrics
    getMetadata(): Map<string, string> {
        return new Map();
    }
    /// Get the metrics
    getMetrics(): QueryExecutionMetrics {
        return this.metrics;
    }
    /// Get the status
    getStatus() {
        return QueryExecutionStatus.RUNNING;
    }
    /// Get the arrow schema
    async getSchema(): Promise<arrow.Schema | null> {
        await sleep(200);
        return this.schema;
    }
    /// Await the next record batch
    /// Produce the result batches
    async produce(batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>, _progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>, abort?: AbortSignal): Promise<void> {
        while (this.batchesWritten < this.batchCount) {
            await sleep(400);
            abort?.throwIfAborted();

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
            batches.resolve(this, new arrow.RecordBatch(this.schema, data));
            this.batchesWritten += 1;
        }
    }
}
