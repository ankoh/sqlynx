import * as arrow from 'apache-arrow';
import * as proto from "../../../proto.js";

import { Logger } from '../../../platform/logger/logger.js';
import { createQueryResponseStreamMetrics, QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionMetrics, QueryExecutionStatus } from "../../../query/query_execution_state.js";
import { yieldToBrowser } from '../../../utils/yield_to_browser.js';

const STREAM_YIELD_INTERVAL = 8;
import { TrinoApiClientInterface, TrinoApiEndpoint, TrinoQueryData, TrinoQueryResult, TrinoQueryStatistics } from "./trino_api_client.js";
import { ChannelError, RawProxyError } from '../../../platform/channel_common.js';
import { AsyncValue } from '../../../utils/async_value.js';
import { AsyncConsumer } from '../../../utils/async_consumer.js';
import { translateAnyRowsToArrowBatch } from './arrow_conversion.js';

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
    /// The current result
    latestQueryResult: TrinoQueryResult | null;
    /// The latest statistics
    latestQueryStats: TrinoQueryStatistics | null;
    /// The latest query state
    latestQueryState: string | null;
    /// The progress updates
    latestQueryProgress: QueryExecutionProgress | null;
    /// The metrics
    queryMetrics: QueryExecutionMetrics;
    endpoint: TrinoApiEndpoint;

    /// The constructor
    constructor(logger: Logger, apiClient: TrinoApiClientInterface, endpoint: TrinoApiEndpoint, result: TrinoQueryResult, metrics: QueryExecutionMetrics) {
        this.logger = logger;
        this.apiClient = apiClient;
        this.currentStatus = QueryExecutionStatus.RUNNING;
        this.responseMetadata = new Map();
        this.resultSchema = new AsyncValue();
        this.latestQueryResult = result;
        this.latestQueryStats = result.stats ?? null;
        this.latestQueryState = result.stats?.state ?? null;
        this.latestQueryProgress = null;
        this.queryMetrics = metrics;
        this.endpoint = endpoint;
        if (result.columns) {
            this.resultSchema.resolve(translateTrinoSchema(result, this.logger));
        }
    }

    async cancel(): Promise<void> {
        const queryId = this.latestQueryResult?.id;
        if (queryId != null) await this.apiClient.cancelQuery(this.endpoint, queryId);
    }

    /// Fetch the next query result
    async fetchNextQueryResult(abort?: AbortSignal): Promise<TrinoQueryResult | null> {
        // Do we have a next URI?
        const nextUri = this.latestQueryResult?.nextUri;
        if (!nextUri) {
            return null;
        }
        this.logger.debug("Fetching next query results", { "nextUri": nextUri }, LOG_CTX);

        // Get the next query result
        this.queryMetrics.totalQueryRequestsStarted += 1;
        const timeBefore = (new Date()).getTime();
        const queryResult = await this.apiClient.getQueryResult(this.endpoint, nextUri, abort);
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

            const rawError: RawProxyError = {
                message: "Query returned an error",
                data: {
                    "errorCode": errorCode.toString(),
                    "errorName": errorName,
                    "errorType": errorType,
                    "errorMessage": errorMessage,
                },
            };
            const error = new ChannelError(rawError, errorCode, undefined, LOG_CTX);
            if (!this.resultSchema.isResolved()) {
                this.resultSchema.reject(error);
            }
            this.queryMetrics.totalQueryRequestsFailed += 1;
            throw error;
        } else {
            this.queryMetrics.totalQueryRequestsSucceeded += 1;
        }
        this.queryMetrics.totalQueryRequestDurationMs += timeAfter - timeBefore;

        // Do we already have a schema?
        if (!this.resultSchema.isResolved() && queryResult.columns) {
            // Attempt to translate the schema
            const translated = translateTrinoSchema(queryResult, this.logger);
            this.resultSchema.resolve(translated);
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
    /// Await the next record batch
    async produce(batches: AsyncConsumer<QueryExecutionResponseStream, arrow.RecordBatch | null>, progress: AsyncConsumer<QueryExecutionResponseStream, QueryExecutionProgress>, abort?: AbortSignal): Promise<void> {
        try {
            let batchesRead = 0;
            // While still running
            while (this.latestQueryState == "QUEUED" || this.latestQueryState == "RUNNING" || this.latestQueryState == "FINISHING") {
                // Fetch the next query result
                const result = await this.fetchNextQueryResult(abort);
                abort?.throwIfAborted();

                // Has a data attribute?
                if (Array.isArray(result?.data)) {
                    // Have result data but not schema yet?
                    // This is unexpected.
                    if (!this.resultSchema.isResolved()) {
                        throw new Error("Result schema is mssing");
                    }
                    // Translate the trino batch
                    const schema = this.resultSchema.getResolvedValue();
                    const resultBatch = translateAnyRowsToArrowBatch(schema!, result.data, this.logger);
                    this.queryMetrics.totalBatchesReceived += 1;
                    this.queryMetrics.totalRowsReceived += resultBatch.numRows;

                    // Publish a new progress update
                    this.latestQueryProgress = deriveProgress(this.latestQueryStats, this.queryMetrics);
                    progress.resolve(this, this.latestQueryProgress);

                    // Produce a batch
                    batches.resolve(this, resultBatch);
                    abort?.throwIfAborted();
                    if (++batchesRead % STREAM_YIELD_INTERVAL === 0) await yieldToBrowser();
                } else {
                    // Publish the progress update
                    this.latestQueryProgress = deriveProgress(this.latestQueryStats, this.queryMetrics);
                    progress.resolve(this, this.latestQueryProgress);
                }
            }
            this.logger.debug("Reached end of query result stream", { "queryState": this.latestQueryState });
        } catch (e: any) {
            throw e;
        }
    }
}

export interface TrinoChannelInterface {
    /// Execute Query
    executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam, abort?: AbortSignal): Promise<TrinoQueryResultStream>;
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

    /// Execute Query
    async executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam, abort?: AbortSignal): Promise<TrinoQueryResultStream> {
        const metrics = createQueryResponseStreamMetrics();
        const timeBefore = (new Date()).getTime();

        try {
            this.logger.debug("Executing query", {}, LOG_CTX);
            metrics.totalQueryRequestsStarted += 1;

            const result = await this.apiClient.runQuery(this.endpoint, this.catalogName, param.query, abort);
            const timeAfter = (new Date()).getTime();

            metrics.totalQueryRequestsSucceeded += 1;
            metrics.totalQueryRequestDurationMs += timeAfter - timeBefore;

            this.logger.debug("Opened query result stream", {}, LOG_CTX);
            const stream = new TrinoQueryResultStream(this.logger, this.apiClient, this.endpoint, result, metrics);
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

/// Parse a Trino type string and return the corresponding Arrow DataType
function parseTrinoType(typeStr: string): arrow.DataType {
    const type = typeStr.toLowerCase().trim();

    // Boolean
    if (type === "boolean") {
        // return new arrow.Bool();
        // DEMO HACK
        return new arrow.Float64();
    }
    // Integer types
    if (type === "tinyint") {
        // return new arrow.Int8();
        // DEMO HACK
        return new arrow.Float64();
    }
    if (type === "smallint") {
        // return new arrow.Int16();
        // DEMO HACK
        return new arrow.Float64();
    }
    if (type === "integer" || type === "int") {
        // DEMO HACK
        // return new arrow.Int32();
        return new arrow.Float64();
    }
    if (type === "bigint") {
        // return new arrow.Utf8();
        // return new arrow.Int64();
        // DEMO HACK
        return new arrow.Float64();
    }
    // Floating-point types
    if (type === "real") {
        // return new arrow.Float32();
        // DEMO HACK
        return new arrow.Float64();
    }
    if (type === "double") {
        return new arrow.Float64();
    }

    // Decimal types: decimal(precision, scale)
    const decimalMatch = type.match(/^decimal\((\d+),\s*(\d+)\)$/);
    if (decimalMatch) {
        const precision = parseInt(decimalMatch[1], 10);
        const scale = parseInt(decimalMatch[2], 10);
        return new arrow.Decimal(scale, precision, 128);
    }
    if (type === "decimal") {
        // Default decimal without precision/scale
        return new arrow.Decimal(0, 38, 128);
    }

    // String types
    if (type === "varchar" || type.startsWith("varchar(") || type === "char" || type.startsWith("char(")) {
        return new arrow.Utf8();
    }
    if (type === "varbinary") {
        return new arrow.Binary();
    }
    if (type === "json") {
        return new arrow.Utf8(); // JSON is represented as string
    }
    // Date/Time types
    if (type === "date") {
        return new arrow.DateDay();
    }
    if (type === "time" || type.startsWith("time(")) {
        return new arrow.TimeMillisecond();
    }
    if (type === "time with time zone" || type.startsWith("time(") && type.includes("with time zone")) {
        return new arrow.TimeMillisecond();
    }
    if (type === "timestamp" || type.startsWith("timestamp(")) {
        if (type.includes("with time zone")) {
            return new arrow.TimestampMillisecond("UTC");
        }
        return new arrow.TimestampMillisecond();
    }
    // Interval types - represent as strings since Arrow has limited interval support
    if (type.startsWith("interval")) {
        return new arrow.Utf8();
    }
    // UUID - represent as string
    if (type === "uuid") {
        return new arrow.Utf8();
    }
    // IP address - represent as string
    if (type === "ipaddress") {
        return new arrow.Utf8();
    }
    // Complex types (array, map, row) - represent as JSON strings for simplicity
    // The Arrow JS API for complex types is cumbersome; JSON serialization is practical
    if (type.startsWith("array(") || type.startsWith("map(") || type.startsWith("row(")) {
        return new arrow.Utf8();
    }

    // Unknown type - fall back to string representation
    return new arrow.Utf8();
}

/// Translate the Trino schema
function translateTrinoSchema(result: TrinoQueryResult, logger: Logger): arrow.Schema {
    let fields: arrow.Field[] = [];
    for (const column of result.columns!) {
        const arrowType = parseTrinoType(column.type);
        fields.push(new arrow.Field(column.name, arrowType, true));
    }
    return new arrow.Schema(fields);
}

/// Derive the execution progress
function deriveProgress(stats: TrinoQueryStatistics | null, metrics: QueryExecutionMetrics): QueryExecutionProgress {
    return {
        isQueued: stats?.queued ?? null,
        metrics: { ...metrics }
    };
}
