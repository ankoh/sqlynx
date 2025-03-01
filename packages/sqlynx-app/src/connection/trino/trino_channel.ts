import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/sqlynx-protobuf";

import { Logger } from '../../platform/logger.js';
import { createQueryResponseStreamMetrics, QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionMetrics, QueryExecutionStatus } from "../../connection/query_execution_state.js";
import { TRINO_STATUS_HTTP_ERROR, TRINO_STATUS_OK, TRINO_STATUS_OTHER_ERROR, TrinoApiClientInterface, TrinoApiEndpoint, TrinoQueryData, TrinoQueryResult, TrinoQueryStatistics } from "./trino_api_client.js";
import { ChannelError, RawProxyError } from '../../platform/channel_common.js';
import { AsyncValue } from '../../utils/async_value.js';
import { Semaphore } from '../../utils/semaphore.js';
import { AsyncValueStream } from '../../utils/async_value_stream.js';

const LOG_CTX = 'trino_channel';

export interface TrinoQueryExecutionProgress extends QueryExecutionProgress { }

export class TrinoQueryResultStream implements QueryExecutionResponseStream {
    /// The logger
    logger: Logger;
    /// The api client
    apiClient: TrinoApiClientInterface;
    /// The current execution status
    currentStatus: QueryExecutionStatus;
    /// The response metadata
    responseMetadata: Map<string, string>;
    /// The schema
    resultSchema: AsyncValue<arrow.Schema, Error>;
    /// The semaphore for serial result fetches
    resultFetchSemaphore: Semaphore;
    /// The current result
    latestQueryResult: TrinoQueryResult | null;
    /// The latest statistics
    latestQueryStats: TrinoQueryStatistics | null;
    /// The latest query state
    latestQueryState: string | null;
    /// The progress updates
    latestQueryProgress: QueryExecutionProgress | null;
    /// The query progress stream
    queryProgressUpdates: AsyncValueStream<QueryExecutionProgress>;
    /// The metrics
    queryMetrics: QueryExecutionMetrics;

    /// The constructor
    constructor(logger: Logger, apiClient: TrinoApiClientInterface, result: TrinoQueryResult, metrics: QueryExecutionMetrics) {
        this.logger = logger;
        this.apiClient = apiClient;
        this.currentStatus = QueryExecutionStatus.RUNNING;
        this.responseMetadata = new Map();
        this.resultSchema = new AsyncValue();
        this.resultFetchSemaphore = new Semaphore(1);
        this.latestQueryResult = result;
        this.latestQueryStats = result.stats ?? null;
        this.latestQueryState = result.stats?.state ?? null;
        this.latestQueryProgress = null;
        this.queryProgressUpdates = new AsyncValueStream();
        this.queryMetrics = metrics;
    }

    /// Fetch the next query result
    async fetchNextQueryResult(): Promise<TrinoQueryResult | null> {
        // Do we have a next URI?
        const nextUri = this.latestQueryResult?.nextUri;
        if (!nextUri) {
            return null;
        }
        this.logger.debug("fetching next query results", { "nextUri": nextUri }, LOG_CTX);

        // Get the next query result
        this.queryMetrics.totalQueryRequestsStarted += 1;
        const timeBefore = (new Date()).getTime();
        const queryResult = await this.apiClient.getQueryResult(nextUri);
        const timeAfter = (new Date()).getTime();
        this.latestQueryResult = queryResult;
        this.latestQueryStats = queryResult.stats ?? null;
        this.latestQueryState = this.latestQueryStats?.state ?? null;

        // Did the query fail?
        if (queryResult.error) {
            const errorCode = queryResult.error.errorCode;
            const errorName = queryResult.error.errorName;
            const errorType = queryResult.error.errorType;
            const errorMessage = queryResult.error.message;

            this.logger.error("fetching query results failed", {
                "errorCode": errorCode.toString(),
                "errorName": errorName,
                "errorType": errorType,
                "errorMessage": errorMessage,
            }, LOG_CTX);

            const rawError: RawProxyError = {
                message: errorMessage,
                details: {
                    "errorCode": errorCode.toString(),
                    "errorName": errorName,
                    "errorType": errorType,
                    "errorMessage": errorMessage,
                },
            };
            this.resultSchema.reject(new ChannelError(rawError, errorCode));
            this.queryMetrics.totalQueryRequestsFailed += 1;
        } else {
            this.queryMetrics.totalQueryRequestsSucceeded += 1;
        }
        this.queryMetrics.totalQueryRequestDurationMs += timeAfter - timeBefore;

        // Do we already have a schema?
        if (!this.resultSchema.isResolved() && queryResult.columns) {
            // Attempt to translate the schema
            const resultSchema = translateTrinoSchema(queryResult);
            this.resultSchema.resolve(resultSchema);
        }
        return queryResult;
    }

    /// Get the result metadata (after completion)
    getMetadata(): Map<string, string> {
        return new Map();
    }
    /// Get the stream metrics
    getMetrics(): QueryExecutionMetrics {
        return this.queryMetrics;
    }
    /// Get the current query status
    getStatus(): QueryExecutionStatus {
        return this.currentStatus;
    }
    /// Await the schema message
    async getSchema(): Promise<arrow.Schema | null> {
        return this.resultSchema.getValue();
    }
    /// Await the next query_status update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return this.queryProgressUpdates.nextValue();
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        const releaseResultFetch = await this.resultFetchSemaphore.acquire();
        try {
            // While still running
            while (this.latestQueryState == "QUEUED" || this.latestQueryState == "RUNNING" || this.latestQueryState == "FINISHING") {
                // Fetch the next query result
                const result = await this.fetchNextQueryResult();
                // Is resolved schema?
                if (Array.isArray(result?.data)) {
                    // Have result data but not schema yet?
                    // This is unexpected.
                    if (!this.resultSchema.isResolved()) {
                        throw new Error("result schema is mssing");
                    }
                    // Translate the trino batch
                    const schema = this.resultSchema.getResolvedValue();
                    const resultBatch = translateTrinoBatch(schema!, result.data);
                    this.queryMetrics.totalBatchesReceived += 1;
                    this.queryMetrics.totalRowsReceived += resultBatch.numRows;

                    // Publish a new progress update
                    this.latestQueryProgress = deriveProgress(this.latestQueryStats, this.queryMetrics);
                    this.queryProgressUpdates.publish(this.latestQueryProgress);

                    releaseResultFetch();
                    return resultBatch;
                } else {
                    // Publish the progress update
                    this.latestQueryProgress = deriveProgress(this.latestQueryStats, this.queryMetrics);
                    this.queryProgressUpdates.publish(this.latestQueryProgress);
                }
            }
            this.logger.debug("reached end of query result stream", { "queryState": this.latestQueryState });

            releaseResultFetch();
            return null;

        } catch (e: any) {
            releaseResultFetch();
            throw e;
        }
    }
}

export interface TrinoHealthCheckResult {
    /// Did the health check succeed?
    ok: boolean;
    /// The http status (if any)
    httpStatus: number | null;
    /// The error (if any)
    error: any | null;
}

export interface TrinoChannelInterface {
    /// Perform a health check
    checkHealth(): Promise<TrinoHealthCheckResult>;
    /// Execute Query
    executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<TrinoQueryResultStream>;
    /// Destroy the connection
    close(): Promise<void>;
}

export class TrinoChannel implements TrinoChannelInterface {
    /// The logger
    logger: Logger;
    /// The client
    apiClient: TrinoApiClientInterface;
    /// The trino api endpoint
    endpoint: TrinoApiEndpoint;
    /// The catalog name
    catalogName: string;

    /// Constructor
    constructor(logger: Logger, client: TrinoApiClientInterface, endpoint: TrinoApiEndpoint, catalogName: string) {
        this.logger = logger;
        this.apiClient = client;
        this.endpoint = endpoint;
        this.catalogName = catalogName;
    }

    /// Perform a health check
    async checkHealth(): Promise<TrinoHealthCheckResult> {
        const status = await this.apiClient.checkHealth(this.endpoint);
        switch (status.type) {
            case TRINO_STATUS_OK:
                return { ok: true, httpStatus: null, error: null };
            case TRINO_STATUS_HTTP_ERROR:
                return { ok: false, httpStatus: status.value.status, error: null };
            case TRINO_STATUS_OTHER_ERROR:
                return { ok: false, httpStatus: null, error: status.value };
        }
    }

    /// Execute Query
    async executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<TrinoQueryResultStream> {
        const metrics = createQueryResponseStreamMetrics();
        const timeBefore = (new Date()).getTime();

        try {
            this.logger.debug("executing query", {}, LOG_CTX);
            metrics.totalQueryRequestsStarted += 1;

            const result = await this.apiClient.runQuery(this.endpoint, this.catalogName, param.query);
            const timeAfter = (new Date()).getTime();

            metrics.totalQueryRequestsSucceeded += 1;
            metrics.totalQueryRequestDurationMs += timeAfter - timeBefore;

            this.logger.debug("opened query result stream", {}, LOG_CTX);
            const stream = new TrinoQueryResultStream(this.logger, this.apiClient, result, metrics);
            return stream;
        } catch (e: any) {
            const timeAfter = (new Date()).getTime();
            metrics.totalQueryRequestsFailed += 1;
            metrics.totalQueryRequestDurationMs += timeAfter - timeBefore;
            throw e;
        }
    }

    /// Destroy the connection
    async close(): Promise<void> {
        return;
    }
}

/// Translate the Trino schema
function translateTrinoSchema(result: TrinoQueryResult): arrow.Schema {
    let fields: arrow.Field[] = [];
    for (const column of result.columns!) {
        let t: arrow.DataType | null = null;
        switch (column.type) {
            case "varchar":
                t = new arrow.Utf8();
                break;
            default:
                t = new arrow.Null();
        }

        fields.push(new arrow.Field(column.name, t, true))
    }
    return new arrow.Schema(fields);
}

/// Translate the Trino batch
function translateTrinoBatch(schema: arrow.Schema, rows: TrinoQueryData): arrow.RecordBatch {
    // Create column builders
    const columnBuilders: arrow.Builder[] = [];
    for (let i = 0; i < schema.fields.length; ++i) {
        const field = schema.fields[i];
        switch (schema.fields[i].typeId) {
            case arrow.Type.Utf8:
                columnBuilders.push(new arrow.Utf8Builder({ type: field.type }));
                break;
            default:
                columnBuilders.push(new arrow.NullBuilder({ type: new arrow.Null() }));
                break;
        }
    }
    // Translate all rows
    for (let i = 0; i < rows.length; ++i) {
        const row = rows[i];
        for (let j = 0; j < (row?.length ?? 0); ++j) {
            columnBuilders[j].append(row[j]);
        }
    }
    console.log(`translate trino batch with ${rows.length} rows`);
    // Flush all columns
    const columnData: arrow.Data[] = columnBuilders.map(col => {
        col.finish();
        return col.flush();
    });
    const structData = arrow.makeData({
        nullCount: 0,
        type: new arrow.Struct(schema.fields),
        children: columnData,
        length: rows.length
    });
    // Construct the record batch
    return new arrow.RecordBatch(schema, structData);
}

/// Derive the execution progress
function deriveProgress(stats: TrinoQueryStatistics | null, metrics: QueryExecutionMetrics): QueryExecutionProgress {
    return {
        isQueued: stats?.queued ?? null,
        metrics: { ...metrics }
    };
}
