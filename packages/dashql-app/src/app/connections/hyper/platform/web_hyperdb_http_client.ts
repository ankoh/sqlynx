import * as arrow from 'apache-arrow';
import * as pb from "../../../../proto.js";
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import {
    HyperDatabaseChannel,
    HyperDatabaseClient,
    HyperDatabaseConnectionContext,
    HyperQueryResultStream,
} from '../hyperdb_grpc_client.js';
import {
    HyperDatabaseHttpClient,
    HyperHttpAuthProvider,
    HyperHttpError,
    QueryStatus,
} from '../hyperdb_http_client.js';
import { fromHttpErrorResponse, HyperQueryError } from '../hyper_error_info.js';
import {
    createQueryResponseStreamMetrics,
    QueryExecutionMetrics,
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionStatus,
} from '../../../../query/query_execution_state.js';
import { AsyncConsumer } from '../../../../utils/async_consumer.js';
import { AsyncValue } from '../../../../utils/async_value.js';
import { HttpClient } from '../../../../platform/http/http_client.js';
import { Logger } from '../../../../platform/logger/logger.js';
import { yieldToBrowser } from '../../../../utils/yield_to_browser.js';

const LOG_CTX = "web_hyperdb_http_client";

/// Convert a HyperHttpError (v3 JSON error body) into a structured HyperQueryError.
/// Other errors are rethrown unchanged.
function rethrowAsHyperQueryError(e: unknown): never {
    if (e instanceof HyperHttpError && e.errorResponse) {
        throw new HyperQueryError(fromHttpErrorResponse(e.errorResponse), LOG_CTX);
    }
    throw e;
}

const CHUNK_POLL_DELAY_MS = 250;
export const DEFAULT_PARALLEL_CHUNKS = 4;
const STREAM_YIELD_INTERVAL = 8;

/// Bytes-reader that feeds Arrow IPC stream chunks from v3 HTTP into an AsyncRecordBatchStreamReader.
/// Chunks are prefetched in parallel up to `parallelChunks`, but yielded in-order so that the
/// Arrow stream framing stays valid.
class WebHyperResultReader implements AsyncIterator<Uint8Array>, AsyncIterable<Uint8Array> {
    httpClient: HyperDatabaseHttpClient;
    logger: Logger;
    queryId: string;
    /// The initial response body from POST /api/v3/query (already the first/only chunk when RESULTS_PRODUCED).
    initialBytes: Uint8Array | null;
    /// Current status (from POST or last poll / chunk response).
    status: QueryStatus;
    /// Maximum number of in-flight chunk fetches.
    parallelChunks: number;
    /// Index of the next chunk to enqueue for prefetch.
    nextPrefetchIndex: number;
    /// FIFO of in-flight chunk byte Promises; the head is the next chunk to return.
    inflight: Array<Promise<Uint8Array>>;
    /// Has the Arrow schema prefix already been emitted to the reader (via POST body or a prior chunk)?
    schemaEmitted: boolean;
    /// Public reader state.
    currentStatus: QueryExecutionStatus;
    metrics: QueryExecutionMetrics;
    metadata: Map<string, string>;
    /// Callback invoked whenever a new QueryStatus is observed.
    progressCallback: ((progress: QueryExecutionProgress) => void) | null;
    abort: AbortSignal | undefined;

    constructor(httpClient: HyperDatabaseHttpClient, logger: Logger, queryId: string, initialStatus: QueryStatus, initialBytes: Uint8Array | null, parallelChunks: number) {
        this.httpClient = httpClient;
        this.logger = logger;
        this.queryId = queryId;
        this.initialBytes = initialBytes;
        this.status = initialStatus;
        this.parallelChunks = Math.max(1, parallelChunks);
        this.nextPrefetchIndex = initialBytes && initialBytes.byteLength > 0 ? 1 : 0;
        this.inflight = [];
        this.schemaEmitted = !!(initialBytes && initialBytes.byteLength > 0);
        this.currentStatus = QueryExecutionStatus.RUNNING;
        this.metrics = createQueryResponseStreamMetrics();
        this.metadata = new Map();
        this.progressCallback = null;
        this.abort = undefined;
        if (initialBytes) {
            this.metrics.totalDataBytesReceived += initialBytes.byteLength;
        }
    }

    private emitProgress(): void {
        if (!this.progressCallback) return;
        this.progressCallback({
            isQueued: null,
            metrics: { ...this.metrics },
        });
    }

    private isCompleted(): boolean {
        return this.status.completionStatus === "RESULTS_PRODUCED" || this.status.completionStatus === "FINISHED";
    }

    private fillPrefetchWindow(): void {
        const chunkCount = this.status.chunkCount ?? 0;
        while (this.inflight.length < this.parallelChunks && this.nextPrefetchIndex < chunkCount) {
            const chunkId = this.nextPrefetchIndex++;
            const omitSchema = this.schemaEmitted;
            this.schemaEmitted = true;
            this.inflight.push(this.fetchChunk(chunkId, omitSchema));
        }
    }

    private async fetchChunk(chunkId: number, omitSchema: boolean): Promise<Uint8Array> {
        const { status, response } = await this.httpClient.getQueryChunk({
            queryId: this.queryId,
            chunkId,
            omitSchema,
        }, undefined, this.abort).catch(rethrowAsHyperQueryError);
        if (status) {
            this.status = status;
            this.emitProgress();
        }
        const body = await response.arrayBuffer();
        return new Uint8Array(body);
    }

    async next(): Promise<IteratorResult<Uint8Array>> {
        if (this.initialBytes && this.initialBytes.byteLength > 0) {
            const value = this.initialBytes;
            this.initialBytes = null;
            this.fillPrefetchWindow();
            return { done: false, value };
        }
        this.initialBytes = null;

        while (true) {
            this.fillPrefetchWindow();

            if (this.inflight.length > 0) {
                const bytes = await this.inflight.shift()!;
                // Top up the window as soon as one slot frees.
                this.fillPrefetchWindow();
                if (bytes.byteLength > 0) {
                    this.metrics.totalDataBytesReceived += bytes.byteLength;
                    return { done: false, value: bytes };
                }
                continue;
            }

            if (this.isCompleted()) {
                return { done: true, value: null };
            }

            // No chunks available yet and query is still running — poll for progress.
            this.status = await this.httpClient.getQueryStatus({
                queryId: this.queryId,
                waitTimeMs: CHUNK_POLL_DELAY_MS,
            }, this.abort).catch(rethrowAsHyperQueryError);
            this.emitProgress();
        }
    }

    [Symbol.asyncIterator]() {
        return this;
    }
}

/// A web HyperDatabaseChannel backed by the v3 HTTP API.
export class WebHyperQueryResultStream implements QueryExecutionResponseStream {
    reader: WebHyperResultReader;
    resultSchema: AsyncValue<arrow.Schema<any>, Error>;

    constructor(reader: WebHyperResultReader) {
        this.reader = reader;
        this.resultSchema = new AsyncValue();
    }

    async cancel(): Promise<void> {
        await this.reader.httpClient.cancelQuery(this.reader.queryId);
    }

    getMetadata(): Map<string, string> {
        return this.reader.metadata;
    }
    getMetrics(): QueryExecutionMetrics {
        return this.reader.metrics;
    }
    getStatus(): QueryExecutionStatus {
        return this.reader.currentStatus;
    }
    getSchema(): Promise<arrow.Schema> {
        return this.resultSchema.getValue();
    }

    async produce(batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch>, progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>, abort?: AbortSignal): Promise<void> {
        this.reader.abort = abort;
        this.reader.progressCallback = (update: QueryExecutionProgress) => {
            progress.resolve(this, update);
        };
        const arrowReader = await arrow.AsyncRecordBatchStreamReader.from(this.reader);
        abort?.throwIfAborted();

        await arrowReader.open();
        abort?.throwIfAborted();
        this.resultSchema.resolve(arrowReader.schema);

        let batchesRead = 0;
        while (true) {
            const iter = await arrowReader.next();
            abort?.throwIfAborted();
            if (iter.done) {
                if (iter.value !== undefined) {
                    batches.resolve(this, iter.value);
                }
                break;
            }
            batches.resolve(this, iter.value);
            if (++batchesRead % STREAM_YIELD_INTERVAL === 0) await yieldToBrowser();
        }
    }
}

class WebHyperDatabaseChannel implements HyperDatabaseChannel {
    httpClient: HyperDatabaseHttpClient;
    connection: HyperDatabaseConnectionContext;
    logger: Logger;
    parallelChunks: number;

    constructor(httpClient: HyperDatabaseHttpClient, connection: HyperDatabaseConnectionContext, logger: Logger, parallelChunks: number) {
        this.httpClient = httpClient;
        this.connection = connection;
        this.logger = logger;
        this.parallelChunks = parallelChunks;
    }

    async executeQuery(params: pb.salesforce_hyperdb_grpc_v1.pb.QueryParam, abort?: AbortSignal): Promise<HyperQueryResultStream> {
        const sql = params.query;
        const queryParameters = this.connection.getQueryParameters();
        const settings = Object.keys(queryParameters).length > 0 ? queryParameters : undefined;
        const { status, response } = await this.httpClient
            .executeQuery({ sql, settings }, undefined, abort)
            .catch(rethrowAsHyperQueryError);
        if (!status || !status.queryId) {
            throw new Error("v3 query response missing status header");
        }
        const bodyBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(bodyBuffer);
        const reader = new WebHyperResultReader(this.httpClient, this.logger, status.queryId, status, bytes.byteLength > 0 ? bytes : null, this.parallelChunks);
        return new WebHyperQueryResultStream(reader);
    }

    async close(): Promise<void> { }
}

/// HyperHttpAuthProvider that delegates to the connection context's getRequestMetadata.
class ContextAuthProvider implements HyperHttpAuthProvider {
    context: HyperDatabaseConnectionContext;
    constructor(context: HyperDatabaseConnectionContext) {
        this.context = context;
    }
    async getAuthHeaders(): Promise<Record<string, string>> {
        return await this.context.getRequestMetadata();
    }
}

export interface WebHyperDatabaseClientConfig {
    /// Maximum number of chunk fetches in flight per query result stream.
    parallelChunks?: number;
}

export class WebHyperDatabaseClient implements HyperDatabaseClient {
    httpClient: HttpClient;
    logger: Logger;
    parallelChunks: number;

    constructor(httpClient: HttpClient, logger: Logger, config: WebHyperDatabaseClientConfig = {}) {
        this.httpClient = httpClient;
        this.logger = logger;
        this.parallelChunks = Math.max(1, config.parallelChunks ?? DEFAULT_PARALLEL_CHUNKS);
    }

    async connect(hyperArgs: connection.HyperConnectionParams, context: HyperDatabaseConnectionContext): Promise<HyperDatabaseChannel> {
        if (!hyperArgs.endpoint) {
            throw new Error("missing hyper endpoint");
        }
        const endpointUrl = new URL(hyperArgs.endpoint);
        const auth = new ContextAuthProvider(context);
        const client = new HyperDatabaseHttpClient(this.httpClient, endpointUrl, auth, this.logger);
        return new WebHyperDatabaseChannel(client, context, this.logger, this.parallelChunks);
    }
}
