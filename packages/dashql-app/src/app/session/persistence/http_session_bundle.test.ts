import { describe, expect, it, vi } from 'vitest';

import type { HttpClient, HttpFetchResult } from '../../../platform/http/http_client.js';
import { readSessionBundleFromHttp } from './http_session_bundle.js';
import { testSession } from '../../storage/session_test_backend.js';
import { SESSION_FORMAT_VERSION } from '../../../migration/versions.js';

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

    it('loads a current session without asking for files of older versions', async () => {
        const httpClient = client({
            '/session/dashql-session.json': JSON.stringify(testSession()),
            '/session/dashql-session-index.json': JSON.stringify({ scripts: [] }),
            '/session/dashql-catalog-relations.sql': 'CREATE TABLE r (a INT)',
        });
        const result = await readSessionBundleFromHttp(URL, httpClient);
        expect(result.bundle.schemaSql).toBe('CREATE TABLE r (a INT)');
        expect(result.incomplete).toBe(false);
        expect(vi.mocked(httpClient.fetch).mock.calls.map(call => new globalThis.URL(String(call[0])).pathname).sort()).toEqual([
            '/session/dashql-catalog-functions.sql',
            '/session/dashql-catalog-relations.sql',
            '/session/dashql-session-index.json',
            '/session/dashql-session.json',
        ]);
    });

    it('migrates a remote session of format version 3', async () => {
        const result = await readSessionBundleFromHttp(URL, client({
            '/session/dashql-session.json': JSON.stringify({ ...testSession(), formatVersion: 3 }),
            '/session/dashql-session-index.json': JSON.stringify({ scripts: [] }),
            '/session/dashql-catalog-relations.sql': 'CREATE TABLE r (a INT)',
        }));
        expect(result.bundle.session.formatVersion).toBe(SESSION_FORMAT_VERSION);
        expect(result.bundle.schemaSql).toBe('CREATE TABLE r (a INT)');
    });

    it('migrates a remote notebook behind a link of an older version', async () => {
        const { sessionId, ...session } = { ...testSession(), formatVersion: 2 };
        const progress = vi.fn();
        const notebookUrl = new globalThis.URL('https://example.com/session/dashql-notebook.json');
        const result = await readSessionBundleFromHttp(notebookUrl, client({
            '/session/dashql-notebook.json': JSON.stringify({ ...session, notebookId: sessionId }),
            '/session/dashql-notebook-index.json': JSON.stringify({ scripts: [{ name: '01_a.sql' }] }),
            '/session/dashql-relations.sql': 'CREATE TABLE r (a INT)',
            '/session/dashql-functions.sql': 'CREATE FUNCTION f() RETURNS INT',
            '/session/scripts/01_a.sql': 'SELECT 1',
        }), undefined, progress);
        expect(result.bundle.session).toMatchObject({ formatVersion: SESSION_FORMAT_VERSION, sessionId });
        expect(result.bundle.session).not.toHaveProperty('notebookId');
        expect(result.bundle.session.metadata.originalHttpUrl).toBe(notebookUrl.toString());
        expect(result.bundle.schemaSql).toBe('CREATE TABLE r (a INT)');
        expect(result.bundle.functionsSql).toBe('CREATE FUNCTION f() RETURNS INT');
        expect(result.bundle.scripts).toEqual([{ name: '01_a.sql', sql: 'SELECT 1' }]);
        expect(result).toMatchObject({ indexedScriptCount: 1, loadedScriptCount: 1, incomplete: false });
        expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'files', completedFileCount: 5, totalFileCount: 5 }));
    });

    it('refuses a remote session of a newer version', async () => {
        await expect(readSessionBundleFromHttp(URL, client({
            '/session/dashql-session.json': JSON.stringify({ ...testSession(), formatVersion: SESSION_FORMAT_VERSION + 1 }),
        }))).rejects.toThrow('Unsupported session format version');
    });

    it('refuses a URL that does not name the session metadata', async () => {
        await expect(readSessionBundleFromHttp(new globalThis.URL('https://example.com/session/other.json'), client({})))
            .rejects.toThrow('Remote session URL must end in dashql-session.json');
    });

    it('strictly refuses a remote V1 session', async () => {
        await expect(readSessionBundleFromHttp(URL, client({
            '/session/dashql-session.json': JSON.stringify({ ...testSession(), formatVersion: 1 }),
        }))).rejects.toThrow('Unsupported session format version');
    });
});
