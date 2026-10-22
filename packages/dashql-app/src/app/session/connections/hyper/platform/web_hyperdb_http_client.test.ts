import * as arrow from 'apache-arrow';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { WebHyperDatabaseClient } from './web_hyperdb_http_client.js';
import { HyperHttpClientMock } from '../hyperdb_http_client_mock.js';
import { HttpClient, HttpFetchResult } from '../../../../../platform/http/http_client.js';
import { TestLogger } from '../../../../../platform/logger/test_logger.js';
import { HyperDatabaseConnectionContext, AttachedDatabase } from '../hyperdb_grpc_client.js';

const ENDPOINT = 'https://hyper.mock.local';

const noopContext: HyperDatabaseConnectionContext = {
    getAttachedDatabases(): AttachedDatabase[] {
        return [];
    },
    async getRequestMetadata(): Promise<Record<string, string>> {
        return {};
    },
    getQueryParameters(): Record<string, string> {
        return {};
    },
};

function makeHyperArgs(): connection.HyperConnectionParams {
    return {
        protocol: 'V3_HTTP',
        endpoint: ENDPOINT,
        tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
    } as connection.HyperConnectionParams;
}

/// Encode a single-int32-column table as a full Arrow stream (schema + record batch).
function encodeIntTable(name: string, values: number[]): Uint8Array {
    const table = arrow.tableFromArrays({ [name]: Int32Array.from(values) });
    return arrow.tableToIPC(table, 'stream');
}

async function collectBatches(stream: Awaited<ReturnType<Awaited<ReturnType<WebHyperDatabaseClient['connect']>>['executeQuery']>>): Promise<arrow.RecordBatch[]> {
    const batches: arrow.RecordBatch[] = [];
    await stream.produce(
        { resolve: (_, b) => { batches.push(b); }, reject: () => { } },
        { resolve: () => { }, reject: () => { } },
    );
    return batches;
}

describe('WebHyperDatabaseClient', () => {
    let mock: HyperHttpClientMock;
    let logger: TestLogger;
    let client: WebHyperDatabaseClient;

    beforeEach(() => {
        mock = new HyperHttpClientMock();
        logger = new TestLogger();
        client = new WebHyperDatabaseClient(mock, logger);
    });

    describe('connect', () => {
        it('rejects a missing endpoint', async () => {
            const args = { ...makeHyperArgs(), endpoint: '' } as connection.HyperConnectionParams;
            await expect(client.connect(args, noopContext)).rejects.toThrow(/endpoint/);
        });

        it('forwards auth headers from the connection context', async () => {
            const spy = vi.spyOn(mock, 'fetch');
            const ctx: HyperDatabaseConnectionContext = {
                getAttachedDatabases: () => [],
                getRequestMetadata: async () => ({ Authorization: 'Bearer test-token' }),
                getQueryParameters: () => ({}),
            };
            mock.setHandler(() => ({
                queryId: 'q-auth',
                completionStatus: 'RESULTS_PRODUCED',
                arrowBytes: encodeIntTable('n', [1]),
            }));

            const channel = await client.connect(makeHyperArgs(), ctx);
            await channel.executeQuery({ query: 'select 1 as n' } as any);

            const init = spy.mock.calls[0][1] as RequestInit;
            const headers = init.headers as Headers;
            expect(headers.get('Authorization')).toBe('Bearer test-token');
        });

        it('cancels the backend query through the result stream', async () => {
            const spy = vi.spyOn(mock, 'fetch');
            mock.setHandler(() => ({
                queryId: 'q-cancel',
                completionStatus: 'RUNNING_OR_UNSPECIFIED',
            }));

            const channel = await client.connect(makeHyperArgs(), noopContext);
            const stream = await channel.executeQuery({ query: 'select slow()' } as any);
            await stream.cancel?.();

            const cancelRequest = spy.mock.calls.find(([input, init]) => {
                const url = input instanceof URL ? input : new URL(input.toString());
                return init?.method === 'DELETE' && url.pathname === '/api/v3/query/q-cancel';
            });
            expect(cancelRequest).toBeDefined();
        });

        it('forwards query parameters as request settings', async () => {
            let capturedSettings: Record<string, unknown> | undefined;
            const ctx: HyperDatabaseConnectionContext = {
                getAttachedDatabases: () => [],
                getRequestMetadata: async () => ({}),
                getQueryParameters: () => ({ lc_time: 'de_DE', time_zone: 'UTC' }),
            };
            mock.setHandler((_sql, request) => {
                capturedSettings = request.settings;
                return {
                    queryId: 'q-settings',
                    completionStatus: 'RESULTS_PRODUCED',
                    arrowBytes: encodeIntTable('n', [1]),
                };
            });

            const channel = await client.connect(makeHyperArgs(), ctx);
            await channel.executeQuery({ query: 'select 1 as n' } as any);

            expect(capturedSettings).toEqual({ lc_time: 'de_DE', time_zone: 'UTC' });
        });

        it('omits settings when there are no query parameters', async () => {
            let sawSettingsKey = false;
            mock.setHandler((_sql, request) => {
                sawSettingsKey = 'settings' in request;
                return {
                    queryId: 'q-no-settings',
                    completionStatus: 'RESULTS_PRODUCED',
                    arrowBytes: encodeIntTable('n', [1]),
                };
            });

            const channel = await client.connect(makeHyperArgs(), noopContext);
            await channel.executeQuery({ query: 'select 1 as n' } as any);

            expect(sawSettingsKey).toBe(false);
        });
    });

    describe('executeQuery', () => {
        it('reports HTTP status when an error response has an empty body', async () => {
            mock.fetch = async () => ({
                headers: new Headers(),
                status: 502,
                statusText: 'Bad Gateway',
                json: async () => ({}),
                text: async () => '',
                arrayBuffer: async () => new ArrayBuffer(0),
            });

            const channel = await client.connect(makeHyperArgs(), noopContext);
            await expect(channel.executeQuery({ query: 'select 1' } as any)).rejects.toMatchObject({
                message: 'HTTP 502',
                target: 'hyperdb_http_client',
                keyValues: {
                    status: '502',
                    bodyType: 'object',
                    bodyKeys: '',
                    hyperdbStatusPresent: 'false',
                    hyperErrorRecognized: 'false',
                },
            });
            const log = logger.buffer.at(logger.buffer.length - 1);
            expect(log).toMatchObject({
                message: 'Hyper HTTP error response',
                keyValues: {
                    status: '502',
                    bodyType: 'object',
                    bodyKeys: '',
                    hyperdbStatusPresent: 'false',
                    hyperErrorRecognized: 'false',
                },
            });
        });

        it('reports HTTP status when an error response is not Hyper JSON', async () => {
            mock.fetch = async () => ({
                headers: new Headers({ 'content-type': 'text/html' }),
                status: 503,
                statusText: 'Service Unavailable',
                json: async () => ({ detail: 'proxy unavailable' }),
                text: async () => 'proxy unavailable',
                arrayBuffer: async () => new ArrayBuffer(0),
            });

            const channel = await client.connect(makeHyperArgs(), noopContext);
            await expect(channel.executeQuery({ query: 'select 1' } as any))
                .rejects.toThrow('HTTP 503');
            expect(logger.buffer.at(logger.buffer.length - 1)?.keyValues).toMatchObject({
                status: '503',
                contentType: 'text/html',
                bodyKeys: 'detail',
                hyperErrorRecognized: 'false',
            });
        });

        it('surfaces Salesforce array errors instead of a generic HTTP 400', async () => {
            mock.fetch = async () => ({
                headers: new Headers({ 'content-type': 'application/json' }),
                status: 400,
                statusText: 'Bad Request',
                json: async () => [{ message: 'Invalid data space', errorCode: 'INVALID_ARGUMENT' }],
                text: async () => '',
                arrayBuffer: async () => new ArrayBuffer(0),
            });

            const channel = await client.connect(makeHyperArgs(), noopContext);
            await expect(channel.executeQuery({ query: 'select 1' } as any))
                .rejects.toThrow('Invalid data space');
            expect(logger.buffer.at(logger.buffer.length - 1)?.keyValues).toMatchObject({
                status: '400',
                bodyType: 'array',
                bodyKeys: 'message,errorCode',
                hyperErrorRecognized: 'true',
            });
        });

        it('reads a single-chunk result from the POST body', async () => {
            const arrowBytes = encodeIntTable('n', [1, 2, 3]);
            mock.setHandler(() => ({
                queryId: 'q-1',
                completionStatus: 'RESULTS_PRODUCED',
                arrowBytes,
            }));

            const channel = await client.connect(makeHyperArgs(), noopContext);
            const stream = await channel.executeQuery(
                { query: 'select n from t' } as any,
            );
            const batches = await collectBatches(stream);
            expect(batches).toHaveLength(1);
            expect(batches[0].numRows).toBe(3);
            expect(Array.from(batches[0].getChildAt(0)!.toArray() as Int32Array)).toEqual([1, 2, 3]);
            expect(stream.getMetrics().totalDataBytesReceived).toBe(arrowBytes.byteLength);
        });

        it('throws when the server response is missing a status header', async () => {
            const origFetch = mock.fetch.bind(mock);
            mock.fetch = async (input, init) => {
                const result = await origFetch(input, init);
                const method = (init?.method ?? 'GET').toUpperCase();
                const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
                if (method === 'POST' && url.pathname === '/api/v3/query') {
                    result.headers.delete('x-hyperdb-status');
                }
                return result;
            };
            mock.setHandler(() => ({ completionStatus: 'RESULTS_PRODUCED' }));

            const channel = await client.connect(makeHyperArgs(), noopContext);
            await expect(channel.executeQuery({ query: 'select 1' } as any))
                .rejects.toThrow(/missing status header/);
        });
    });

    describe('parallel chunk prefetch', () => {
        /// Bespoke HttpClient that simulates v3 HTTP for a multi-chunk result:
        /// - POST /api/v3/query: returns queryId + RESULTS_PRODUCED + chunkCount, empty body
        /// - GET /api/v3/query/{id}/chunk/{n}: blocks on a shared gate so we can observe
        ///   how many chunk requests are in flight concurrently.
        class MultiChunkFakeClient implements HttpClient {
            chunkBytes: Uint8Array;
            chunkCount: number;
            queryId = 'q-parallel';
            currentInflight = 0;
            maxInflight = 0;
            /// Pending chunk-request resolvers, released once we have seen the expected window fill up.
            pending: Array<() => void> = [];
            releaseAfter: number;

            constructor(chunkBytes: Uint8Array, chunkCount: number, releaseAfter: number) {
                this.chunkBytes = chunkBytes;
                this.chunkCount = chunkCount;
                this.releaseAfter = releaseAfter;
            }

            private makeStatusHeader(): Record<string, string> {
                return {
                    'x-hyperdb-status': JSON.stringify({
                        queryId: this.queryId,
                        completionStatus: 'RESULTS_PRODUCED',
                        chunkCount: this.chunkCount,
                        rowCount: this.chunkCount,
                        progress: 100,
                        expirationTime: new Date(Date.now() + 300_000).toISOString(),
                        executionStats: { wallClockTime: 1, rowsProcessed: this.chunkCount },
                    }),
                };
            }

            private makeArrowResponse(bytes: Uint8Array, status = 200): HttpFetchResult {
                const headers = new Headers({ 'Content-Type': 'application/vnd.apache.arrow.stream', ...this.makeStatusHeader() });
                return {
                    headers,
                    status,
                    statusText: 'OK',
                    json: async () => { throw new Error('arrow, not json'); },
                    text: async () => { throw new Error('arrow, not text'); },
                    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
                };
            }

            async fetch(input: URL | Request | string, init?: RequestInit): Promise<HttpFetchResult> {
                const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
                const method = (init?.method ?? 'GET').toUpperCase();

                if (method === 'POST' && url.pathname === '/api/v3/query') {
                    // Empty-body response with status header advertising chunkCount chunks.
                    return this.makeArrowResponse(new Uint8Array(0));
                }
                if (method === 'GET' && /\/api\/v3\/query\/[^/]+\/chunk\/\d+$/.test(url.pathname)) {
                    this.currentInflight++;
                    this.maxInflight = Math.max(this.maxInflight, this.currentInflight);
                    await new Promise<void>((resolve) => {
                        this.pending.push(resolve);
                        if (this.pending.length >= this.releaseAfter) {
                            queueMicrotask(() => {
                                while (this.pending.length > 0) {
                                    this.pending.shift()!();
                                }
                            });
                        }
                    });
                    const res = this.makeArrowResponse(this.chunkBytes);
                    this.currentInflight--;
                    return res;
                }
                throw new Error(`unexpected ${method} ${url.pathname}`);
            }
        }

        async function runWithTrackedChunks(parallelChunks: number, chunkCount: number) {
            const chunkBytes = encodeIntTable('n', [42]);
            // With parallelChunks=1 we only ever have 1 in flight; release it immediately.
            // With parallelChunks>1 we wait until that many pile up before draining.
            const releaseAfter = Math.min(parallelChunks, chunkCount);
            const fake = new MultiChunkFakeClient(chunkBytes, chunkCount, releaseAfter);
            const local = new WebHyperDatabaseClient(fake, logger, { parallelChunks });

            const channel = await local.connect(makeHyperArgs(), noopContext);
            const stream = await channel.executeQuery({ query: 'select n from t' } as any);
            // We don't care about Arrow framing here — just drain the iterator directly.
            const reader = (stream as any).reader;
            while (true) {
                const next = await reader.next();
                if (next.done) break;
            }
            return { maxInflight: fake.maxInflight };
        }

        it('prefetches up to parallelChunks concurrently', async () => {
            const { maxInflight } = await runWithTrackedChunks(4, 8);
            expect(maxInflight).toBe(4);
        });

        it('caps inflight at 1 when parallelChunks=1', async () => {
            const { maxInflight } = await runWithTrackedChunks(1, 4);
            expect(maxInflight).toBe(1);
        });

        it('does not exceed the total chunk count', async () => {
            const { maxInflight } = await runWithTrackedChunks(8, 3);
            expect(maxInflight).toBe(3);
        });
    });
});
