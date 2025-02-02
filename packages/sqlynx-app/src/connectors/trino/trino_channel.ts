import * as arrow from 'apache-arrow';
import * as proto from "@ankoh/sqlynx-protobuf";

import { Logger } from '../../platform/logger.js';
import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionResponseStreamMetrics, QueryExecutionStatus } from "../../connectors/query_execution_state.js";
import { TrinoApiClientInterface, TrinoApiEndpoint, TrinoQueryResult } from "./trino_api_client.js";

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

    /// The constructor
    constructor(logger: Logger, apiClient: TrinoApiClientInterface, result: TrinoQueryResult) {
        this.logger = logger;
        this.apiClient = apiClient;
        this.currentStatus = QueryExecutionStatus.STARTED;
        this.responseMetadata = new Map();
        this.resultSchema = null;

        console.log(result);
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
        // const fields: arrow.Field[] = [];
        //  = new arrow.Schema(fields);
        // return schema;
        return null;
    }
}

export interface TrinoHealthCheckResult {
    /// Did the health check succeed?
    ok: boolean;
    /// The error message
    errorMessage: string | null;
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
        const result: TrinoHealthCheckResult = {
            ok: false,
            errorMessage: null
        };
        try {
            const queryParam = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
                query: "select 1",
            });
            const stream = await this.executeQuery(queryParam);
            await stream.nextRecordBatch();
            result.ok = true;
            return result;

        } catch (e: any) {
            result.ok = false;
            result.errorMessage = e?.message;
        }
        return result;
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
