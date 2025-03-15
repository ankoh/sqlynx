import * as arrow from 'apache-arrow';

import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionMetrics, QueryExecutionStatus, createQueryResponseStreamMetrics } from "../query_execution_state.js";
import { generateRandomData, RandomDataConfig } from '../../utils/random_data.js';
import { sleep } from '../../utils/sleep.js';
import { AsyncConsumer } from '../../utils/async_consumer.js';

export interface DemoQuerySpec extends RandomDataConfig {
    /// Time in milliseconds until the first batch
    timeMsUntilFirstBatch: number;
    /// Time in milliseconds between two batches
    timeMsBetweenBatches: number;
}

class DemoQueryExecutionResponseStream implements QueryExecutionResponseStream {
    /// The config
    config: DemoQuerySpec;
    /// The schema
    schema: arrow.Schema;
    /// The batch
    batches: arrow.RecordBatch[];
    /// The next stream batch
    nextBatchId: number;
    /// The metrics
    metrics: QueryExecutionMetrics;

    /// Constructor
    constructor(config: DemoQuerySpec, schema: arrow.Schema, batches: arrow.RecordBatch[]) {
        this.config = config;
        this.schema = schema;
        this.batches = batches;
        this.nextBatchId = 0;
        this.metrics = createQueryResponseStreamMetrics();
    }
    /// Get the result metadata (after completion)
    getMetadata(): Map<string, string> {
        return new Map();
    }
    /// Get the stream metrics
    getMetrics(): QueryExecutionMetrics {
        return this.metrics;
    }
    /// Get the current query status
    getStatus(): QueryExecutionStatus {
        return QueryExecutionStatus.SUCCEEDED;
    }
    /// Await the schema message
    async getSchema(): Promise<arrow.Schema | null> {
        return this.schema;
    }
    /// Produce the result batches
    async produce(batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>, _progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>, abort?: AbortSignal): Promise<void> {
        for (; this.nextBatchId < this.batches.length; this.nextBatchId++) {
            if (this.nextBatchId == 0) {
                await sleep(this.config.timeMsUntilFirstBatch);
                abort?.throwIfAborted();
            } else {
                await sleep(this.config.timeMsBetweenBatches);
                abort?.throwIfAborted();
            }
            batches.resolve(this, this.batches[this.nextBatchId]);
        }
    }
}

export class DemoDatabaseChannel {
    /// Constructor
    constructor() { }

    /// Execute Query
    async executeQuery(config: DemoQuerySpec, _abort?: AbortSignal): Promise<QueryExecutionResponseStream> {
        const [schema, batches] = generateRandomData(config);
        return new DemoQueryExecutionResponseStream(config, schema, batches);
    }
    /// Destroy the connection
    async close(): Promise<void> { }
}


