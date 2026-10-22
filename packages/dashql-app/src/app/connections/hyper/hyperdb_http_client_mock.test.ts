import { describe, it, expect, beforeEach } from 'vitest';
import { HyperHttpError } from './hyperdb_http_client.js';
import { createMockHyperHttpClient, HyperHttpClientMock } from './hyperdb_http_client_mock.js';
import type { HyperDatabaseHttpClient } from './hyperdb_http_client.js';

const ARROW_CONTENT_TYPE = 'application/vnd.apache.arrow.stream';
const MOCK_ARROW = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]);  // "ARROW1"

describe('HyperDatabaseHttpClient (mock)', () => {
    let mock: HyperHttpClientMock;
    let client: HyperDatabaseHttpClient;

    beforeEach(() => {
        ({ mock, client } = createMockHyperHttpClient());
    });

    // -------------------------------------------------------------------------
    // executeQuery
    // -------------------------------------------------------------------------

    describe('executeQuery', () => {
        it('returns RESULTS_PRODUCED status and Arrow bytes for a fast query', async () => {
            mock.setHandler(() => ({
                completionStatus: 'RESULTS_PRODUCED',
                arrowBytes: MOCK_ARROW,
            }));

            const { status, response } = await client.executeQuery({ sql: 'SELECT n FROM t' });

            expect(status).not.toBeNull();
            expect(status!.completionStatus).toBe('RESULTS_PRODUCED');
            expect(status!.chunkCount).toBe(1);
            expect(response.headers.get('Content-Type')).toBe(ARROW_CONTENT_TYPE);

            const buf = await response.arrayBuffer();
            expect(new Uint8Array(buf)).toEqual(MOCK_ARROW);
        });

        it('returns RUNNING_OR_UNSPECIFIED status with empty bytes for an async query', async () => {
            mock.setHandler(() => ({
                completionStatus: 'RUNNING_OR_UNSPECIFIED',
            }));

            const { status, response } = await client.executeQuery({ sql: 'SELECT slow()' });

            expect(status!.completionStatus).toBe('RUNNING_OR_UNSPECIFIED');
            expect(status!.chunkCount).toBe(0);
            expect(status!.progress).toBe(0);
            expect(response.headers.get('Content-Type')).toBe(ARROW_CONTENT_TYPE);
        });

        it('forwards the sql from the request body to the handler', async () => {
            let capturedSql = '';
            mock.setHandler((sql) => {
                capturedSql = sql;
                return { completionStatus: 'RESULTS_PRODUCED' };
            });

            await client.executeQuery({ sql: 'SELECT 42' });
            expect(capturedSql).toBe('SELECT 42');
        });

        it('throws HyperHttpError on 4xx response', async () => {
            mock.setHandler(() => ({
                errorStatus: 400,
                errorResponse: { error: '42601', message: 'syntax error at position 7' },
            }));

            await expect(
                client.executeQuery({ sql: 'SELCT 1' }),
            ).rejects.toThrow(HyperHttpError);

            try {
                await client.executeQuery({ sql: 'SELCT 1' });
            } catch (e) {
                expect(e).toBeInstanceOf(HyperHttpError);
                expect((e as HyperHttpError).httpStatus).toBe(400);
                expect((e as HyperHttpError).errorResponse?.error).toBe('42601');
            }
        });

        it('uses the error code when the Hyper message is empty', async () => {
            mock.setHandler(() => ({
                errorStatus: 400,
                errorResponse: { error: 'INVALID_ARGUMENT', message: '' },
            }));

            await expect(client.executeQuery({ sql: 'SELECT 1' })).rejects.toThrow('INVALID_ARGUMENT');
        });

        it('sets the Accept header to Arrow', async () => {
            let capturedHeaders: Headers | undefined;
            const origFetch = mock.fetch.bind(mock);
            mock.fetch = async (input, init) => {
                capturedHeaders = init?.headers as Headers;
                return origFetch(input, init);
            };
            mock.setHandler(() => ({ completionStatus: 'RESULTS_PRODUCED' }));

            await client.executeQuery({ sql: 'SELECT 1' });
            expect(capturedHeaders?.get('Accept')).toBe(ARROW_CONTENT_TYPE);
        });
    });

    // -------------------------------------------------------------------------
    // getQueryStatus
    // -------------------------------------------------------------------------

    describe('getQueryStatus', () => {
        it('returns current status for a known queryId', async () => {
            mock.setHandler(() => ({
                queryId: 'q-abc',
                completionStatus: 'RUNNING_OR_UNSPECIFIED',
            }));
            await client.executeQuery({ sql: 'SELECT 1' });

            const status = await client.getQueryStatus({ queryId: 'q-abc' });
            expect(status.queryId).toBe('q-abc');
            expect(status.completionStatus).toBe('RUNNING_OR_UNSPECIFIED');
        });

        it('throws HyperHttpError(404) for an unknown queryId', async () => {
            await expect(
                client.getQueryStatus({ queryId: 'does-not-exist' }),
            ).rejects.toThrow(HyperHttpError);

            try {
                await client.getQueryStatus({ queryId: 'does-not-exist' });
            } catch (e) {
                expect((e as HyperHttpError).httpStatus).toBe(404);
            }
        });
    });

    // -------------------------------------------------------------------------
    // cancelQuery
    // -------------------------------------------------------------------------

    describe('cancelQuery', () => {
        it('succeeds (204) and removes the query so status returns 404 afterward', async () => {
            mock.setHandler(() => ({
                queryId: 'q-del',
                completionStatus: 'RUNNING_OR_UNSPECIFIED',
            }));
            await client.executeQuery({ sql: 'SELECT sleep(9999)' });

            await expect(client.cancelQuery('q-del')).resolves.toBeUndefined();

            await expect(
                client.getQueryStatus({ queryId: 'q-del' }),
            ).rejects.toThrow(HyperHttpError);
        });
    });

    // -------------------------------------------------------------------------
    // getQueryChunk
    // -------------------------------------------------------------------------

    describe('getQueryChunk', () => {
        it('returns Arrow bytes and status header for a known chunk', async () => {
            mock.setHandler(() => ({
                queryId: 'q-chunk',
                completionStatus: 'RESULTS_PRODUCED',
                arrowBytes: MOCK_ARROW,
            }));
            await client.executeQuery({ sql: 'SELECT val FROM t' });

            const { status, response } = await client.getQueryChunk({ queryId: 'q-chunk', chunkId: 0 });

            expect(status!.completionStatus).toBe('RESULTS_PRODUCED');
            expect(response.headers.get('Content-Type')).toBe(ARROW_CONTENT_TYPE);
            const buf = await response.arrayBuffer();
            expect(new Uint8Array(buf)).toEqual(MOCK_ARROW);
        });

        it('throws HyperHttpError(404) for an unknown queryId', async () => {
            await expect(
                client.getQueryChunk({ queryId: 'nope', chunkId: 0 }),
            ).rejects.toThrow(HyperHttpError);
        });
    });

    // -------------------------------------------------------------------------
    // getQueryRows
    // -------------------------------------------------------------------------

    describe('getQueryRows', () => {
        beforeEach(async () => {
            mock.setHandler(() => ({
                queryId: 'q-rows',
                completionStatus: 'RESULTS_PRODUCED',
                arrowBytes: MOCK_ARROW,
            }));
            await client.executeQuery({ sql: 'SELECT i FROM t' });
        });

        it('returns Arrow bytes', async () => {
            const response = await client.getQueryRows({ queryId: 'q-rows', offset: 0 });
            expect(response.headers.get('Content-Type')).toBe(ARROW_CONTENT_TYPE);
            const buf = await response.arrayBuffer();
            expect(new Uint8Array(buf)).toEqual(MOCK_ARROW);
        });

        it('throws HyperHttpError(404) for unknown queryId', async () => {
            await expect(
                client.getQueryRows({ queryId: 'nope', offset: 0 }),
            ).rejects.toThrow(HyperHttpError);
        });
    });

    // -------------------------------------------------------------------------
    // Async query lifecycle: execute → poll → chunk
    // -------------------------------------------------------------------------

    describe('async query lifecycle', () => {
        it('transitions from RUNNING to RESULTS_PRODUCED after manual state update', async () => {
            mock.setHandler(() => ({
                queryId: 'q-async',
                completionStatus: 'RUNNING_OR_UNSPECIFIED',
            }));

            const { status: execStatus } = await client.executeQuery({ sql: 'SELECT x' });
            expect(execStatus!.completionStatus).toBe('RUNNING_OR_UNSPECIFIED');

            mock.registerQuery({
                queryId: 'q-async',
                completionStatus: 'RESULTS_PRODUCED',
                columns: [{ name: 'x', type: 'int' }],
                arrowBytes: MOCK_ARROW,
                chunkCount: 1,
                rowCount: 1,
                expirationTime: new Date(Date.now() + 300_000).toISOString(),
                executionStats: { wallClockTime: 42, rowsProcessed: 1 },
            });

            const pollStatus = await client.getQueryStatus({ queryId: 'q-async' });
            expect(pollStatus.completionStatus).toBe('RESULTS_PRODUCED');
            expect(pollStatus.chunkCount).toBe(1);

            const { response } = await client.getQueryChunk({ queryId: 'q-async', chunkId: 0 });
            const buf = await response.arrayBuffer();
            expect(new Uint8Array(buf)).toEqual(MOCK_ARROW);
        });
    });
});
