import { describe, expect, it, vi } from 'vitest';

import type { HttpClient, HttpFetchResult } from '../../../platform/http/http_client.js';
import { readSessionBundleFromHttp } from './http_session_bundle.js';
import { testSession } from './session_test_backend.js';

const URL = new globalThis.URL('https://example.com/session/dashql-session.json');

function response(text: string, status = 200): HttpFetchResult {
    return {
        headers: new Headers(), status, statusText: '',
        text: async () => text,
        json: async () => JSON.parse(text),
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
}

function client(files: Record<string, string>): HttpClient {
    return { fetch: vi.fn(async input => {
        const url = input instanceof globalThis.URL ? input : new globalThis.URL(input instanceof Request ? input.url : input);
        return files[url.pathname] == null ? response('', 404) : response(files[url.pathname]);
    }) };
}

describe('V2 HTTP session bundle', () => {
    it('loads indexed binary data and refuses unsafe names without fetching them', async () => {
        const bytes = new Uint8Array([0, 255, 128]);
        const httpClient = client({
            '/session/dashql-session.json': JSON.stringify(testSession()),
            '/session/dashql-session-index.json': JSON.stringify({ scripts: [], data: [
                { name: '../escape' }, { name: 'payload.bin' }, { name: 'PAYLOAD.bin' },
            ] }),
        });
        const fetch = httpClient.fetch;
        httpClient.fetch = vi.fn(async (input, init) => String(input).endsWith('/attachments/payload.bin')
            ? { ...response(''), arrayBuffer: async () => bytes.buffer }
            : fetch(input, init));
        const result = await readSessionBundleFromHttp(URL, httpClient);
        expect(result.bundle.data).toEqual([{ name: 'payload.bin', bytes }]);
        expect(result.incomplete).toBe(true);
        expect(vi.mocked(httpClient.fetch).mock.calls.map(call => String(call[0])).some(url => url.includes('escape'))).toBe(false);
    });
    it('loads flat indexed scripts and reports progress', async () => {
        const progress = vi.fn();
        const result = await readSessionBundleFromHttp(URL, client({
            '/session/dashql-session.json': JSON.stringify(testSession()),
            '/session/dashql-session-index.json': JSON.stringify({ scripts: [{ name: '02_b.sql' }, { name: '01_a.sql' }] }),
            '/session/scripts/01_a.sql': 'SELECT 1',
            '/session/scripts/02_b.sql': 'SELECT 2',
        }), undefined, progress);

        expect(result.bundle.scripts).toEqual([
            { name: '02_b.sql', sql: 'SELECT 2' },
            { name: '01_a.sql', sql: 'SELECT 1' },
        ]);
        expect(result).toMatchObject({ indexedScriptCount: 2, loadedScriptCount: 2, incomplete: false });
        expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
            phase: 'files', completedScriptCount: 2, totalScriptCount: 2,
        }));
    });

    it('marks obsolete nested and draft index entries incomplete without fetching them', async () => {
        const httpClient = client({
            '/session/dashql-session.json': JSON.stringify(testSession()),
            '/session/dashql-session-index.json': JSON.stringify({
                scripts: [{ name: 'page/query.sql' }, { name: 'dashql-draft.sql' }, { name: '01_ok.sql' }],
            }),
            '/session/scripts/01_ok.sql': 'SELECT 1',
        });
        const result = await readSessionBundleFromHttp(URL, httpClient);
        expect(result.bundle.scripts).toEqual([{ name: '01_ok.sql', sql: 'SELECT 1' }]);
        expect(result.incomplete).toBe(true);
        expect(vi.mocked(httpClient.fetch).mock.calls.map(call => String(call[0])))
            .not.toContain('https://example.com/session/scripts/page%2Fquery.sql');
    });

    it('strictly refuses a remote V1 session', async () => {
        await expect(readSessionBundleFromHttp(URL, client({
            '/session/dashql-session.json': JSON.stringify({ ...testSession(), formatVersion: 1 }),
        }))).rejects.toThrow('Unsupported session format version');
    });
});
