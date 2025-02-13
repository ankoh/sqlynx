import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/sqlynx-protobuf";

import { Logger } from '../../platform/logger.js';
import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionResponseStreamMetrics, QueryExecutionStatus } from "../../connection/query_execution_state.js";
import { TRINO_STATUS_HTTP_ERROR, TRINO_STATUS_OK, TRINO_STATUS_OTHER_ERROR, TrinoApiClientInterface, TrinoApiEndpoint, TrinoQueryResult, TrinoQueryStatistics } from "./trino_api_client.js";

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
        return this.resultSchema;
    }
    /// Await the next query_status update
    async nextProgressUpdate(): Promise<QueryExecutionProgress | null> {
        return {};
    }
    /// Await the next record batch
    async nextRecordBatch(): Promise<arrow.RecordBatch | null> {
        // While still running
        while (this.latestQueryState == "RUNNING") {
            // Fetch the next query result
            const result = this.fetchNextQueryResult();
            console.log(result);
        }
        return null;
    }
}

export interface TrinoHealthCheckResult {
    /// Did the health check succeed?
    ok: boolean;
    /// The http status (if any)
    httpStatus: number | null;
    /// The error message (if any)
    otherError: any | null;
}

export interface TrinoChannelInterface {
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
                return { ok: true, httpStatus: null, otherError: null };
            case TRINO_STATUS_HTTP_ERROR:
                return { ok: false, httpStatus: status.value.status, otherError: null };
            case TRINO_STATUS_OTHER_ERROR:
                return { ok: false, httpStatus: null, otherError: status.value };
        }
    }

    /// Execute Query
    async executeQuery(param: proto.salesforce_hyperdb_grpc_v1.pb.QueryParam): Promise<TrinoQueryResultStream> {
        const result = await this.apiClient.runQuery(this.endpoint, param.query);
        const stream = new TrinoQueryResultStream(this.logger, this.apiClient, result);
        return stream;

    }

    /// Destroy the connection
    async close(): Promise<void> {
        return;
    }
}
