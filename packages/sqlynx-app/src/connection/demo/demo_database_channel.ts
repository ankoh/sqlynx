import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/sqlynx-protobuf";

import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionStreamMetrics, QueryExecutionStatus, createQueryResponseStreamMetrics } from "../query_execution_state.js";
import { generateRandomData, RandomDataConfig } from '../../utils/random_data.js';
import { sleep } from '../../utils/sleep.js';

export interface DemoDatabaseConfig extends RandomDataConfig {
    /// Time in milliseconds until the first batch
    timeMsUntilFirstBatch: number;
    /// Time in milliseconds between two batches
    timeMsBetweenBatches: number;
}

class DemoQueryExecutionResponseStream implements QueryExecutionResponseStream {
    /// The config
    config: DemoDatabaseConfig;
    /// The schema
    schema: arrow.Schema;
    /// The batch
    batches: arrow.RecordBatch[];
    /// The next stream batch
    nextBatchId: number;
    /// The metrics
    metrics: QueryExecutionStreamMetrics;

    /// Constructor
    constructor(config: DemoDatabaseConfig, schema: arrow.Schema, batches: arrow.RecordBatch[]) {
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
    getMetrics(): QueryExecutionStreamMetrics {
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
    /// Await the next query_status update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return null;
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        const batchId = this.nextBatchId++;
        if (batchId < this.batches.length) {
            if (batchId == 0) {
                await sleep(this.config.timeMsUntilFirstBatch);
            } else {
                await sleep(this.config.timeMsBetweenBatches);
            }
            return this.batches[batchId];
        } else {
            return null;
        }
    }
}

export class DemoDatabaseChannel {
    /// The demo database config
    config: DemoDatabaseConfig;

    /// Constructor
    constructor(config: DemoDatabaseConfig) {
        this.config = config;
    }

    /// Execute Query
    async executeQuery(_param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<QueryExecutionResponseStream> {
        const [schema, batches] = generateRandomData(this.config);
        return new DemoQueryExecutionResponseStream(this.config, schema, batches);
    }
    /// Destroy the connection
    async close(): Promise<void> { }
}


