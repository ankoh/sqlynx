import { VariantKind } from "utils/variant.js";
import { HttpClient } from "../../platform/http_client.js";
import { Logger } from "../../platform/logger.js";
import { TrinoAuthParams } from "./trino_connection_params.js";

const LOG_CTX = "trino_api";

export interface TrinoApiEndpoint {
    // The endpoint url
    endpoint: string;
    // The auth settings
    auth: TrinoAuthParams;
}

export interface TrinoQueryFailureInfo {
    /// The failure type
    type: string;
    /// The failure message
    message: string;
    /// The suppressed error
    suppressed: string[];
    /// The error stack
    stack: string[];
};

export interface TrinoQueryError {
    /// The erro message
    message: string;
    /// The error code
    errorCode: number;
    /// The error name
    errorName: string;
    /// The error type
    errorType: string;
    /// The failure info
    failureInfo: TrinoQueryFailureInfo;
};

export interface TrinoQueryResultColumn {
    /// The column name
    name: string;
    /// The column type
    type: string
};

export type TrinoQueryData = any[];

export interface TrinoQueryStage {
    /// The trino stage id
    stageId: string;
    /// The state
    state: string;
    /// Is the query done?
    done: boolean;
    /// The number of nodes in the stage
    nodes: number;
    /// The total number of splits
    totalSplits: number;
    /// The number of queued splits
    queuedSplits: number;
    /// The splits that are currently running
    runningSplits: number;
    /// The splits that are completed
    completedSplits: number;
    /// The cpu time in milliseconds
    cpuTimeMillis: number;
    /// The wall time in milliseconds
    wallTimeMillis: number;
    /// The processed rows
    processedRows: number;
    /// The processed bytes
    processedBytes: number;
    /// The physical input bytes
    physicalInputBytes: number;
    /// The number of failed tasks
    failedTasks: number;
    /// Coordinator-only query?
    coordinatorOnly: boolean;
    /// The number of substages
    subStages: TrinoQueryStage[];
};

export interface TrinoQueryStatistics {
    /// The state
    state: string;
    /// Is the query queued?
    queued: boolean;
    /// Is the query scheduled?
    scheduled: boolean;
    /// The number of nodes
    nodes: number;
    /// The total number of splits
    totalSplits: number;
    /// The queued number of splits
    queuedSplits: number;
    /// The currently running splits
    runningSplits: number;
    /// The number of completed splits
    completedSplits: number;
    /// The CPU time in milliseconds
    cpuTimeMillis: number;
    /// The wallclock time in milliseconds
    wallTimeMillis: number;
    /// The time that the query was queued
    queuedTimeMillis: number;
    /// The elapsed time
    elapsedTimeMillis: number;
    /// The number of processed rows
    processedRows: number;
    /// The number of processed bytes
    processedBytes: number;
    /// The number of input bytes
    physicalInputBytes: number;
    /// The peak memory size
    peakMemoryBytes: number;
    /// The number of spilled bytes
    spilledBytes: number;
    /// The root stage
    rootStage: TrinoQueryStage;
    /// The progess percentage
    progressPercentage: number;
};

export interface TrinoQueryResult {
    /// The query id
    id: string;
    /// The URI for the query info call
    infoUri?: string;
    /// The URI for fetching the next query batch
    nextUri?: string;
    /// The result columns
    columns?: TrinoQueryResultColumn[];
    /// The query data
    data?: TrinoQueryData[];
    /// The query statistics
    stats?: TrinoQueryStatistics;
    /// The warnings during the query execution
    warnings?: string[];
    /// The query error (if any)
    error?: TrinoQueryError;
};

export interface TrinoQueryInfo {
    /// The query id
    queryId: string;
    /// The query state
    state: string;
    /// The query text
    query: string;
    /// The failure info
    failureInfo?: TrinoQueryFailureInfo;
};

export const TRINO_STATUS_OK = Symbol("TRINO_STATUS_OK");
export const TRINO_STATUS_HTTP_ERROR = Symbol("TRINO_STATUS_HTTP_ERROR");
export const TRINO_STATUS_OTHER_ERROR = Symbol("TRINO_STATUS_OTHER_ERROR");

export type TrinoHealthCheckStatus =
    | VariantKind<typeof TRINO_STATUS_OK, { status: number }>
    | VariantKind<typeof TRINO_STATUS_HTTP_ERROR, { status: number }>
    | VariantKind<typeof TRINO_STATUS_OTHER_ERROR, any>

export interface TrinoApiClientInterface {
    /// Check the health
    checkHealth(endpoint: TrinoApiEndpoint): Promise<TrinoHealthCheckStatus>;
    /// Run a query
    runQuery(endpoint: TrinoApiEndpoint, catalogName: string, text: string): Promise<TrinoQueryResult>;
    /// Get a query result
    getQueryResult(nextUri: string): Promise<TrinoQueryResult>;
    /// Get a query info
    getQueryInfo(endpoint: TrinoApiEndpoint, queryId: string): Promise<TrinoQueryInfo>;
    /// Cancel a query
    cancelQuery(endpoint: TrinoApiEndpoint, queryId: string): Promise<TrinoQueryResult>;
}


export class TrinoApiClient implements TrinoApiClientInterface {
    /// The logger
    logger: Logger;
    /// The http client
    httpClient: HttpClient;

    constructor(logger: Logger, httpClient: HttpClient) {
        this.logger = logger;
        this.httpClient = httpClient;
    }

    /// Check the health
    async checkHealth(endpoint: TrinoApiEndpoint): Promise<TrinoHealthCheckStatus> {
        const headers = new Headers();
        if (endpoint.auth.username.length > 0) {
            headers.set('Authorization', 'Basic ' + btoa(endpoint.auth.username + ":" + endpoint.auth.secret));
            headers.set('X-Trino-User', endpoint.auth.username);
        }
        try {
            const url = new URL(`${endpoint.endpoint}/v1/statement`);
            const rawResponse = await this.httpClient.fetch(url, {
                method: 'POST',
                body: "select 1",
                headers
            });
            await rawResponse.json();
            return {
                type: TRINO_STATUS_OK,
                value: {
                    status: rawResponse.status,
                }
            };
        } catch (error: any) {
            return error.status ? {
                type: TRINO_STATUS_HTTP_ERROR,
                value: {
                    status: error.status,
                }
            } : {
                type: TRINO_STATUS_OTHER_ERROR,
                value: error
            };
        }
    }

    /// Run a query
    async runQuery(endpoint: TrinoApiEndpoint, catalogName: string, text: string): Promise<TrinoQueryResult> {
        this.logger.debug("running query", { "text": text }, LOG_CTX);
        const url = new URL(`${endpoint.endpoint}/v1/statement`);
        const headers = new Headers();
        if (endpoint.auth.username.length > 0) {
            headers.set('Authorization', 'Basic ' + btoa(endpoint.auth.username + ":" + endpoint.auth.secret));
            headers.set('X-Trino-User', endpoint.auth.username);
            headers.set('X-Trino-Catalog', catalogName);
        }
        const rawResponse = await this.httpClient.fetch(url, {
            method: 'POST',
            body: text,
            headers
        });
        if (rawResponse.status != 200) {
            throw new Error(`query failed: status=${rawResponse.status}, message=${rawResponse.statusText}`);
        }
        const responseJson = await rawResponse.json() as TrinoQueryResult;
        const response = responseJson as TrinoQueryResult;
        return response;
    }

    /// Get the query result batch
    async getQueryResult(nextUri: string): Promise<TrinoQueryResult> {
        this.logger.debug("getting query results", { "nextUri": nextUri }, LOG_CTX);
        const url = new URL(nextUri);
        const headers = new Headers();
        const rawResponse = await this.httpClient.fetch(url, {
            method: 'GET',
            headers
        });
        if (rawResponse.status != 200) {
            throw new Error(`fetching query results failed: status=${rawResponse.status}, message=${rawResponse.statusText}`);
        }
        const responseJson = await rawResponse.json() as TrinoQueryResult;
        const response = responseJson as TrinoQueryResult;
        return response;
    }

    /// Get a query info
    async getQueryInfo(endpoint: TrinoApiEndpoint, queryId: string): Promise<TrinoQueryInfo> {
        this.logger.debug("getting query info", { "query": queryId }, LOG_CTX);
        const url = new URL(`${endpoint.endpoint}/v1/query/${queryId}`);
        const headers = new Headers();
        const rawResponse = await this.httpClient.fetch(url, {
            method: 'GET',
            headers
        });
        if (rawResponse.status != 200) {
            throw new Error(`fetch query info failed: status=${rawResponse.status}, message=${rawResponse.statusText}`);
        }
        const responseJson = await rawResponse.json() as TrinoQueryInfo;
        const response = responseJson as TrinoQueryInfo;
        return response;
    }

    /// Cancel a query
    async cancelQuery(endpoint: TrinoApiEndpoint, queryId: string): Promise<TrinoQueryResult> {
        this.logger.debug("cancelling query", { "query": queryId }, LOG_CTX);
        const url = new URL(`${endpoint.endpoint}/v1/query/${queryId}`);
        const headers = new Headers();
        const rawResponse = await this.httpClient.fetch(url, {
            method: 'DELETE',
            headers
        });
        if (rawResponse.status != 200) {
            throw new Error(`cancelling a query failed: status=${rawResponse.status}, message=${rawResponse.statusText}`);
        }
        const responseJson = await rawResponse.json() as TrinoQueryResult;
        const response = responseJson as TrinoQueryResult;
        return response;
    }
}
