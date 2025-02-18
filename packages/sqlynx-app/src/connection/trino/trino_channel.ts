import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/sqlynx-protobuf";

import { Logger } from '../../platform/logger.js';
import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionResponseStreamMetrics, QueryExecutionStatus } from "../../connection/query_execution_state.js";
import { TRINO_STATUS_HTTP_ERROR, TRINO_STATUS_OK, TRINO_STATUS_OTHER_ERROR, TrinoApiClientInterface, TrinoApiEndpoint, TrinoQueryResult, TrinoQueryStatistics } from "./trino_api_client.js";

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
        this.latestQueryResult = result;
        this.latestQueryStats = result.stats ?? null;
        this.latestQueryState = result.stats?.state ?? null;
    }

    /// Fetch the next query result
    async fetchNextQueryResult(): Promise<TrinoQueryResult | null> {
        const nextUri = this.latestQueryResult?.nextUri;
        if (!nextUri) {
            return null;
        }
        this.logger.debug("fetching next query results", { "nextUri": nextUri }, LOG_CTX);
        const queryResult = await this.apiClient.getQueryResult(nextUri);
        this.latestQueryResult = queryResult;
        this.latestQueryStats = queryResult.stats ?? null;
        this.latestQueryState = this.latestQueryStats?.state ?? null;

        console.log(queryResult);

        // XXX Translate trino query result to arrow
        return null;
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
        // XXX
        return new arrow.Schema();
    }
    /// Await the next query_status update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return null;
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        console.log(this);
        // While still running
        while (this.latestQueryState == "QUEUED" || this.latestQueryState == "RUNNING") {
            // Fetch the next query result
            const result = await this.fetchNextQueryResult();
            console.log(result);
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

    /// Constructor
    constructor(logger: Logger, client: TrinoApiClientInterface, endpoint: TrinoApiEndpoint) {
        this.logger = logger;
        this.apiClient = client;
        this.endpoint = endpoint;
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
        const result = await this.apiClient.runQuery(this.endpoint, param.query);

        this.logger.debug("opened query result stream", {}, LOG_CTX);
        const stream = new TrinoQueryResultStream(this.logger, this.apiClient, result);
        return stream;

    }

    /// Destroy the connection
    async close(): Promise<void> {
        return;
    }
}
