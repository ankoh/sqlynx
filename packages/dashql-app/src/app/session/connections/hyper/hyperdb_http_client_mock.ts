import { HttpClient, HttpFetchResult } from '../../../../platform/http/http_client.js';
import {
    ColumnDefinition,
    CompletionStatus,
    ExecuteQueryRequest,
    ExecutionStats,
    HyperDatabaseHttpClient,
    HyperHttpAuthProvider,
    QueryErrorResponse,
    QueryStatus,
} from './hyperdb_http_client.js';
import { TestLogger } from '../../../../platform/logger/test_logger.js';

const ARROW_CONTENT_TYPE = "application/vnd.apache.arrow.stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArrowResult(status: number, bytes: Uint8Array, extraHeaders?: Record<string, string>): HttpFetchResult {
    const headers = new Headers({ 'Content-Type': ARROW_CONTENT_TYPE, ...extraHeaders });
    return {
        headers,
        status,
        statusText: status === 200 ? 'OK' : String(status),
        json: async () => { throw new Error('response is Arrow, not JSON'); },
        text: async () => { throw new Error('response is Arrow, not text'); },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
}

function makeErrorResult(status: number, body: QueryErrorResponse): HttpFetchResult {
    const text = JSON.stringify(body);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    return {
        headers,
        status,
        statusText: String(status),
        json: async () => JSON.parse(text),
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
}

function statusHeader(qs: QueryStatus): Record<string, string> {
    return { 'x-hyperdb-status': JSON.stringify(qs) };
}

// ---------------------------------------------------------------------------
// Programmable request handler
// ---------------------------------------------------------------------------

export type MockQueryHandler = (sql: string, request: ExecuteQueryRequest) => MockQueryResult;

export interface MockQueryResult {
    queryId?: string;
    completionStatus?: CompletionStatus;
    columns?: ColumnDefinition[];
    arrowBytes?: Uint8Array;
    errorStatus?: number;
    errorResponse?: QueryErrorResponse;
}

// ---------------------------------------------------------------------------
// Stored query state
// ---------------------------------------------------------------------------

export interface MockPendingQuery {
    queryId: string;
    completionStatus: CompletionStatus;
    columns: ColumnDefinition[];
    arrowBytes: Uint8Array;
    chunkCount: number;
    rowCount: number;
    expirationTime: string;
    executionStats: ExecutionStats;
}

// ---------------------------------------------------------------------------
// Mock HttpClient
// ---------------------------------------------------------------------------

export class HyperHttpClientMock implements HttpClient {
    private queries = new Map<string, MockPendingQuery>();
    private handler: MockQueryHandler | null = null;
    private nextQueryId = 1;

    setHandler(handler: MockQueryHandler): void {
        this.handler = handler;
    }

    registerQuery(query: MockPendingQuery): void {
        this.queries.set(query.queryId, query);
    }

    private newQueryId(): string {
        return `mock-query-${this.nextQueryId++}`;
    }

    private buildQueryStatus(q: MockPendingQuery): QueryStatus {
        return {
            queryId: q.queryId,
            completionStatus: q.completionStatus,
            chunkCount: q.chunkCount,
            rowCount: q.rowCount,
            progress: q.completionStatus === 'RUNNING_OR_UNSPECIFIED' ? 0 : 100,
            expirationTime: q.expirationTime,
            executionStats: q.executionStats,
        };
    }

    async fetch(input: URL | Request | string, init?: RequestInit): Promise<HttpFetchResult> {
        const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = url.pathname;

        if (method === 'POST' && path === '/api/v3/query') {
            return this.handleExecuteQuery(init);
        }

        const statusMatch = path.match(/^\/api\/v3\/query\/([^/]+)$/);
        if (statusMatch) {
            if (method === 'GET') return this.handleGetStatus(decodeURIComponent(statusMatch[1]));
            if (method === 'DELETE') return this.handleCancelQuery(decodeURIComponent(statusMatch[1]));
        }

        const chunkMatch = path.match(/^\/api\/v3\/query\/([^/]+)\/chunk\/(\d+)$/);
        if (method === 'GET' && chunkMatch) {
            return this.handleGetChunk(decodeURIComponent(chunkMatch[1]), parseInt(chunkMatch[2], 10));
        }

        const rowMatch = path.match(/^\/api\/v3\/query\/([^/]+)\/row$/);
        if (method === 'GET' && rowMatch) {
            return this.handleGetRows(decodeURIComponent(rowMatch[1]), url);
        }

        return makeErrorResult(404, { error: 'NOT_FOUND', message: `No mock for ${method} ${path}` });
    }

    private handleExecuteQuery(init?: RequestInit): HttpFetchResult {
        const request: ExecuteQueryRequest = init?.body ? JSON.parse(init.body as string) : { sql: '' };

        let result: MockQueryResult = { completionStatus: 'RESULTS_PRODUCED' };
        if (this.handler) {
            result = this.handler(request.sql, request);
        }

        if (result.errorStatus !== undefined) {
            return makeErrorResult(result.errorStatus, result.errorResponse ?? { error: 'HY000', message: 'mock error' });
        }

        const queryId = result.queryId ?? this.newQueryId();
        const completionStatus = result.completionStatus ?? 'RESULTS_PRODUCED';
        const arrowBytes = result.arrowBytes ?? new Uint8Array(0);

        const pending: MockPendingQuery = {
            queryId,
            completionStatus,
            columns: result.columns ?? [],
            arrowBytes,
            chunkCount: completionStatus === 'RUNNING_OR_UNSPECIFIED' ? 0 : 1,
            rowCount: 0,
            expirationTime: new Date(Date.now() + 300_000).toISOString(),
            executionStats: { wallClockTime: 1, rowsProcessed: 0 },
        };
        this.queries.set(queryId, pending);

        const qs = this.buildQueryStatus(pending);
        return makeArrowResult(200, arrowBytes, statusHeader(qs));
    }

    private handleGetStatus(queryId: string): HttpFetchResult {
        const q = this.queries.get(queryId);
        if (!q) {
            return makeErrorResult(404, { error: 'NOT_FOUND', message: `Query ${queryId} not found` });
        }
        // Status endpoint returns JSON (not Arrow)
        const text = JSON.stringify(this.buildQueryStatus(q));
        return {
            headers: new Headers({ 'Content-Type': 'application/json' }),
            status: 200,
            statusText: 'OK',
            json: async () => JSON.parse(text),
            text: async () => text,
            arrayBuffer: async () => new TextEncoder().encode(text).buffer,
        };
    }

    private handleCancelQuery(queryId: string): HttpFetchResult {
        this.queries.delete(queryId);
        return {
            headers: new Headers(),
            status: 204,
            statusText: 'No Content',
            json: async () => null,
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        };
    }

    private handleGetChunk(queryId: string, _chunkId: number): HttpFetchResult {
        const q = this.queries.get(queryId);
        if (!q) {
            return makeErrorResult(404, { error: 'NOT_FOUND', message: `Query ${queryId} not found` });
        }
        const qs = this.buildQueryStatus(q);
        return makeArrowResult(200, q.arrowBytes, statusHeader(qs));
    }

    private handleGetRows(queryId: string, url: URL): HttpFetchResult {
        const q = this.queries.get(queryId);
        if (!q) {
            return makeErrorResult(404, { error: 'NOT_FOUND', message: `Query ${queryId} not found` });
        }
        // offset/limit/byteLimit are query params the real server uses; the mock
        // returns the full arrowBytes slice since Arrow streaming handles framing.
        return makeArrowResult(200, q.arrowBytes, {});
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const MOCK_BASE_URL = new URL('https://mock.hyperdb.local');

const MOCK_AUTH: HyperHttpAuthProvider = {
    getAuthHeaders: async () => ({ Authorization: 'Bearer mock-token' }),
};

export function createMockHyperHttpClient(httpMock?: HyperHttpClientMock): {
    client: HyperDatabaseHttpClient;
    mock: HyperHttpClientMock;
} {
    const mock = httpMock ?? new HyperHttpClientMock();
    const client = new HyperDatabaseHttpClient(mock, MOCK_BASE_URL, MOCK_AUTH, new TestLogger());
    return { client, mock };
}
