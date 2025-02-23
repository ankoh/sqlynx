import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/sqlynx-protobuf";

import { Logger } from '../../platform/logger.js';
import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionResponseStreamMetrics, QueryExecutionStatus } from "../../connection/query_execution_state.js";
import { TRINO_STATUS_HTTP_ERROR, TRINO_STATUS_OK, TRINO_STATUS_OTHER_ERROR, TrinoApiClientInterface, TrinoApiEndpoint, TrinoQueryData, TrinoQueryResult, TrinoQueryStatistics } from "./trino_api_client.js";
import { ChannelError, RawProxyError } from '../../platform/channel_common.js';

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
    resultSchema: arrow.Schema | null;
    /// The current in-flight result fetch
    inFlightResultFetch: Promise<arrow.RecordBatch | null> | null;
    /// The current result
    latestQueryResult: TrinoQueryResult | null;
    /// The latest statistics
    latestQueryStats: TrinoQueryStatistics | null;
    /// The latest query state
    latestQueryState: string | null;

    /// The constructor
    constructor(logger: Logger, apiClient: TrinoApiClientInterface, result: TrinoQueryResult) {
        this.logger = logger;
        this.apiClient = apiClient;
        this.currentStatus = QueryExecutionStatus.STARTED;
        this.responseMetadata = new Map();
        this.resultSchema = null;
        this.inFlightResultFetch = null;
        this.latestQueryResult = result;
        this.latestQueryStats = result.stats ?? null;
        this.latestQueryState = result.stats?.state ?? null;
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
        const queryResult = await this.apiClient.getQueryResult(nextUri);
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
            throw new ChannelError(rawError, errorCode);
        }
        // Do we already have a schema?
        if (this.resultSchema == null && queryResult.columns) {
            // Attempt to translate the schema
            this.resultSchema = translateTrinoSchema(queryResult);

            console.log(this.resultSchema);
        }
        return queryResult;
    }

    /// Get the result metadata (after completion)
    getMetadata(): Map<string, string> {
        return new Map();
    }
    /// Get the stream metrics
    getMetrics(): QueryExecutionResponseStreamMetrics {
        return {
            dataBytes: 0
        };
    }
    /// Get the current query status
    getStatus(): QueryExecutionStatus {
        return this.currentStatus;
    }
    /// Await the schema message
    async getSchema(): Promise<arrow.Schema | null> {
        // Already fetched the schema?
        if (this.resultSchema == null) {
            // Is there a fetch in flight?
            if (this.inFlightResultFetch != null) {
                // Someone else will consume the results...
                await this.inFlightResultFetch;
                // Return the schema.
                // Note that it might still be null if something wen't wrong with the stream
                return this.resultSchema;
            }
            // Fetch a batch ourselves
            this.inFlightResultFetch = this.nextRecordBatch();
            // ... We leave the result fetch "in flight" so that somebody else can fetch the schema
            await this.inFlightResultFetch;
        }
        return this.resultSchema;
    }
    /// Await the next query_status update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return null;
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        // Is there an in-flight fetch?
        // Might have been triggered by getSchema...
        if (this.inFlightResultFetch != null) {
            const result = await this.inFlightResultFetch;
            this.inFlightResultFetch = null;
            return result;
        }
        // While still running
        while (this.latestQueryState == "QUEUED" || this.latestQueryState == "RUNNING" || this.latestQueryState == "FINISHING") {
            // Fetch the next query result
            const result = await this.fetchNextQueryResult();
            // Translate a batch
            if (this.resultSchema != null && Array.isArray(result?.data)) {
                return translateTrinoBatch(this.resultSchema, result.data);
            }
        }
        this.logger.debug("reached end of query result stream", { "queryState": this.latestQueryState });
        return null;
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
        this.logger.debug("executing query", {}, LOG_CTX);
        const result = await this.apiClient.runQuery(this.endpoint, this.catalogName, param.query);

        this.logger.debug("opened query result stream", {}, LOG_CTX);
        const stream = new TrinoQueryResultStream(this.logger, this.apiClient, result);
        return stream;
    }

    /// Destroy the connection
    async close(): Promise<void> {
        return;
    }
}

/// Translate the Trino schema
function translateTrinoSchema(result: TrinoQueryResult): (arrow.Schema | null) {
    if (!result.columns?.length) {
        return null;
    }
    let fields: arrow.Field[] = [];
    for (const column of result.columns) {
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


