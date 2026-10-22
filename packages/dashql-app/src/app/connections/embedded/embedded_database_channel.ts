import * as arrow from 'apache-arrow';
import type * as pb from '../../../proto.js';

import type { EmbeddedConnection } from '../../../platform/database/embedded_database.js';
import type { AsyncConsumer } from '../../../utils/async_consumer.js';
import {
    createQueryResponseStreamMetrics,
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionStatus,
    type QueryExecutionMetrics,
} from '../query_execution_state.js';
import type { HyperDatabaseChannel } from '../hyper/hyperdb_grpc_client.js';
import { yieldToBrowser } from '../../../utils/yield_to_browser.js';

const STREAM_YIELD_INTERVAL = 8;

class EmbeddedQueryResultStream implements QueryExecutionResponseStream {
    private readonly table: arrow.Table;
    private readonly metrics: QueryExecutionMetrics;
    private nextBatch = 0;

    constructor(bytes: Uint8Array, durationMs: number) {
        this.table = arrow.tableFromIPC(bytes);
        this.metrics = createQueryResponseStreamMetrics();
        this.metrics.totalDataBytesReceived = bytes.byteLength;
        this.metrics.totalBatchesReceived = this.table.batches.length;
        this.metrics.totalRowsReceived = this.table.numRows;
        this.metrics.totalQueryRequestsStarted = 1;
        this.metrics.totalQueryRequestsSucceeded = 1;
        this.metrics.totalQueryRequestDurationMs = durationMs;
        this.metrics.durationUntilFirstBatchMs = durationMs;
    }

    getMetadata(): Map<string, string> {
        return new Map();
    }

    getMetrics(): QueryExecutionMetrics {
        return this.metrics;
    }

    getStatus(): QueryExecutionStatus {
        return QueryExecutionStatus.SUCCEEDED;
    }

    async getSchema(): Promise<arrow.Schema> {
        return this.table.schema;
    }

    async produce(
        batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>,
        _progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>,
        abort?: AbortSignal,
    ): Promise<void> {
        for (; this.nextBatch < this.table.batches.length; this.nextBatch += 1) {
            abort?.throwIfAborted();
            batches.resolve(this, this.table.batches[this.nextBatch]);
            if ((this.nextBatch + 1) % STREAM_YIELD_INTERVAL === 0) await yieldToBrowser();
        }
    }
}

export class EmbeddedDatabaseChannel {
    /// The connection runs one statement at a time, so queries wait for the previous ones.
    /// One connection keeps the session state of the scripts, such as settings and attached databases.
    private previousQuery: Promise<unknown> = Promise.resolve();

    constructor(private readonly connection: EmbeddedConnection) {}

    async executeQuery(query: string, abort?: AbortSignal): Promise<QueryExecutionResponseStream> {
        abort?.throwIfAborted();
        const execution = this.previousQuery.then(async () => {
            abort?.throwIfAborted();
            const startedAt = performance.now();
            const bytes = await this.connection.queryArrowIPC(query, abort);
            return { bytes, durationMs: performance.now() - startedAt };
        });
        this.previousQuery = execution.catch(() => {});
        const { bytes, durationMs } = await execution;
        abort?.throwIfAborted();
        return new EmbeddedQueryResultStream(bytes, durationMs);
    }

    async close(): Promise<void> {
        await this.connection.close();
    }
}

export class EmbeddedHyperDatabaseChannel implements HyperDatabaseChannel {
    constructor(private readonly channel: EmbeddedDatabaseChannel) {}

    async executeQuery(
        params: pb.salesforce_hyperdb_grpc_v1.pb.QueryParam,
        abort?: AbortSignal,
    ): Promise<QueryExecutionResponseStream> {
        return await this.channel.executeQuery(params.query, abort);
    }

    async close(): Promise<void> {
        await this.channel.close();
    }
}
