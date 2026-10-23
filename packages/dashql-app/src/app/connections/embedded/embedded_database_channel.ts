import type * as arrow from 'apache-arrow';
import type * as pb from '../../../proto.js';

import type { EmbeddedConnection, EmbeddedResultStream } from '../../../platform/database/embedded_database.js';
import type { AsyncConsumer } from '../../../utils/async_consumer.js';
import {
    createQueryResponseStreamMetrics,
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionStatus,
    type QueryExecutionMetrics,
} from '../../../query/query_execution_state.js';
import type { HyperDatabaseChannel } from '../hyper/hyperdb_grpc_client.js';
import { yieldToBrowser } from '../../../utils/yield_to_browser.js';

const STREAM_YIELD_INTERVAL = 8;

/// A query result that streams the record batches as the embedded database produces them.
class EmbeddedQueryResultStream implements QueryExecutionResponseStream {
    private readonly metrics: QueryExecutionMetrics;
    private status = QueryExecutionStatus.RUNNING;
    /// Resolves once the result is read to the end or cancelled, the connection is free again then
    readonly finished: Promise<void>;
    private resolveFinished!: () => void;

    constructor(
        /// The result batches
        private readonly reader: EmbeddedResultStream,
        /// The time at which the query was started
        private readonly startedAt: number,
    ) {
        this.metrics = createQueryResponseStreamMetrics();
        this.metrics.totalQueryRequestsStarted = 1;
        this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
    }

    async cancel(): Promise<void> {
        try {
            await this.reader.cancel();
        } finally {
            if (this.status === QueryExecutionStatus.RUNNING) this.status = QueryExecutionStatus.CANCELLED;
            this.resolveFinished();
        }
    }

    getMetadata(): Map<string, string> {
        return new Map();
    }

    getMetrics(): QueryExecutionMetrics {
        return this.metrics;
    }

    getStatus(): QueryExecutionStatus {
        return this.status;
    }

    async getSchema(): Promise<arrow.Schema> {
        return this.reader.schema;
    }

    /// Produce the batches, the abort signal of the query cancels it in the database
    async produce(
        batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>,
        _progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>,
        abort?: AbortSignal,
    ): Promise<void> {
        try {
            for (;;) {
                abort?.throwIfAborted();
                const next = await this.reader.next();
                if (next.done) break;
                const batch = next.value;
                this.metrics.durationUntilFirstBatchMs ??= performance.now() - this.startedAt;
                this.metrics.totalDataBytesReceived += batch.data.byteLength;
                this.metrics.totalBatchesReceived += 1;
                this.metrics.totalRowsReceived += batch.numRows;
                batches.resolve(this, batch);
                if (this.metrics.totalBatchesReceived % STREAM_YIELD_INTERVAL === 0) await yieldToBrowser();
            }
            this.metrics.totalQueryRequestsSucceeded = 1;
            this.status = QueryExecutionStatus.SUCCEEDED;
        } catch (error) {
            this.metrics.totalQueryRequestsFailed = 1;
            this.status = abort?.aborted ? QueryExecutionStatus.CANCELLED : QueryExecutionStatus.FAILED;
            // Stop the query when the batches are not read to the end
            await this.reader.cancel().catch(() => {});
            throw error;
        } finally {
            this.metrics.totalQueryRequestDurationMs = performance.now() - this.startedAt;
            this.resolveFinished();
        }
    }
}

export class EmbeddedDatabaseChannel {
    /// The connection runs one statement at a time, so queries wait until the result of the previous one is read.
    /// One connection keeps the session state of the scripts, such as settings and attached databases.
    private previousQuery: Promise<void> = Promise.resolve();

    constructor(private readonly connection: EmbeddedConnection) {}

    async executeQuery(query: string, abort?: AbortSignal): Promise<QueryExecutionResponseStream> {
        abort?.throwIfAborted();
        const previous = this.previousQuery;
        let release!: () => void;
        this.previousQuery = new Promise(resolve => { release = resolve; });
        try {
            await previous;
            abort?.throwIfAborted();
            const startedAt = performance.now();
            const stream = new EmbeddedQueryResultStream(await this.connection.queryStream(query, abort), startedAt);
            void stream.finished.then(release);
            return stream;
        } catch (error) {
            release();
            throw error;
        }
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
