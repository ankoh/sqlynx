import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { BASE64URL_CODEC } from '../../../utils/base64.js';
import {
    createNotebookZip,
    exportNotebookAsSharedZip,
    exportNotebookAsUrl,
    exportNotebookAsZip,
    NotebookLinkTarget,
} from './notebook_export.js';
import { importNotebookFromZip } from './notebook_import.js';
import { NotebookTestBackend, TEST_NOTEBOOK_ID, testNotebook } from './notebook_test_backend.js';

describe('V2 notebook export', () => {
    it.each(['hyper', 'trino'])('omits %s header credentials from main and attached databases in ZIP and URL exports', async connector => {
        const backend = new NotebookTestBackend();
        const metadata = { authorization: 'bearer-secret', cookie: 'cookie-secret', 'x-api-key': 'api-secret', arbitrary: 'custom-secret' };
        const params = connector === 'hyper' ? { hyper: {
            protocol: 'V3_HTTP', endpoint: 'https://identity.example',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
            metadata, queryParameters: { credential: 'query-secret' },
        } } : { trino: { endpoint: 'https://identity.example', catalogName: 'catalog', metadata } };
        const manifest = testNotebook({
            mainDatabase: { databaseId: testNotebook().mainDatabase.databaseId, params: params as any },
            attachedDatabases: [{ databaseId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', params: params as any }],
        });
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, manifest);
        const liveParams = new Map([manifest.mainDatabase, ...manifest.attachedDatabases].map(database => [database.databaseId, database.params]));
        const url = await exportNotebookAsUrl(backend, TEST_NOTEBOOK_ID, liveParams, NotebookLinkTarget.WEB);
        const event = JSON.parse(new TextDecoder().decode(BASE64URL_CODEC.decode(url.searchParams.get('data')!)));
        const archives = [
            await JSZip.loadAsync(await exportNotebookAsZip(TEST_NOTEBOOK_ID, backend)),
            await JSZip.loadAsync(await exportNotebookAsSharedZip(backend, TEST_NOTEBOOK_ID, liveParams)),
            await JSZip.loadAsync(BASE64URL_CODEC.decode(event.notebook)),
        ];
        for (const archive of archives) {
            const text = await archive.file('dashql-notebook.json')!.async('text');
            for (const secret of [...Object.values(metadata), 'query-secret']) expect(text).not.toContain(secret);
            const exported = JSON.parse(text);
            for (const database of [exported.mainDatabase, ...exported.attachedDatabases]) {
                expect(database.params[connector].metadata).toBeUndefined();
                expect(database.params[connector].queryParameters).toBeUndefined();
                expect(database.params[connector].endpoint).toBe('https://identity.example');
            }
        }
        expect((await backend.loadNotebook(TEST_NOTEBOOK_ID)).mainDatabase.params).toEqual(params);
    });
    it('omits main and attached drafts and secrets from plain and shared ZIP exports', async () => {
        const backend = new NotebookTestBackend();
        const database = (databaseId: string) => ({
            databaseId,
            params: { trino: { endpoint: 'https://committed.example', auth: { authType: 'AUTH_BASIC', basic: { username: 'user', secret: 'committed-secret' } } } } as any,
            paramsDraft: { trino: { endpoint: 'unfinished', auth: { authType: 'AUTH_BASIC', basic: { username: 'user', secret: 'draft-secret' } } } } as any,
        });
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook({
            mainDatabase: database(testNotebook().mainDatabase.databaseId),
            attachedDatabases: [database('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')],
        }));
        for (const blob of [await exportNotebookAsZip(TEST_NOTEBOOK_ID, backend), await exportNotebookAsSharedZip(backend, TEST_NOTEBOOK_ID, new Map())]) {
            const archive = await JSZip.loadAsync(blob);
            const text = await archive.file('dashql-notebook.json')!.async('text');
            expect(text).not.toContain('paramsDraft');
            expect(text).not.toContain('committed-secret');
            expect(text).not.toContain('draft-secret');
            expect(JSON.parse(text).mainDatabase.params.trino.endpoint).toBe('https://committed.example');
        }
        expect((await backend.loadNotebook(TEST_NOTEBOOK_ID)).mainDatabase.paramsDraft).toBeDefined();
    });
    it('does not encode the reserved draft script', async () => {
        const archive = await JSZip.loadAsync(await createNotebookZip(testNotebook(), [
            { name: 'dashql-draft.sql', sql: 'SELECT draft' },
            { name: '01_query.sql', sql: 'SELECT 1' },
        ]));

        expect(archive.file('scripts/dashql-draft.sql')).toBeNull();
        expect(await archive.file('scripts/01_query.sql')!.async('text')).toBe('SELECT 1');
    });

    it('exports only flat scripts and includes catalogs on request', async () => {
        const backend = new NotebookTestBackend();
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await backend.saveNotebookSchema(TEST_NOTEBOOK_ID, 'schema');
        await backend.saveNotebookFunctions(TEST_NOTEBOOK_ID, 'functions');
        await backend.saveScript(TEST_NOTEBOOK_ID, '01_first.sql', 'SELECT 1');
        await backend.saveScript(TEST_NOTEBOOK_ID, '02_second.sql', 'SELECT 2');

        const archive = await JSZip.loadAsync(await exportNotebookAsZip(TEST_NOTEBOOK_ID, backend, { withCatalog: true }));
        expect(await archive.file('scripts/01_first.sql')!.async('text')).toBe('SELECT 1');
        expect(await archive.file('scripts/02_second.sql')!.async('text')).toBe('SELECT 2');
        expect(await archive.file('dashql-relations.sql')!.async('text')).toBe('schema');
        expect(await archive.file('dashql-functions.sql')!.async('text')).toBe('functions');
        expect(archive.file(/scripts\/[^/]+\/[^/]+/)).toEqual([]);
        expect(archive.file('scripts/dashql-draft.sql')).toBeNull();
    });

    it('round-trips a flat V2 archive through import', async () => {
        const source = new NotebookTestBackend();
        await source.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await source.saveScript(TEST_NOTEBOOK_ID, '01_query.sql', 'SELECT 42');
        const target = new NotebookTestBackend();

        const blob = await exportNotebookAsZip(TEST_NOTEBOOK_ID, source);
        await expect(importNotebookFromZip(blob, target)).resolves.toBe(TEST_NOTEBOOK_ID);
        expect(await target.loadScripts(TEST_NOTEBOOK_ID)).toEqual([{ name: '01_query.sql', sql: 'SELECT 42' }]);
    });

    it('omits catalogs from URL exports by default', async () => {
        const backend = new NotebookTestBackend();
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await backend.saveNotebookSchema(TEST_NOTEBOOK_ID, 'schema');
        await backend.saveNotebookFunctions(TEST_NOTEBOOK_ID, 'functions');

        const url = await exportNotebookAsUrl(backend, TEST_NOTEBOOK_ID, new Map(), NotebookLinkTarget.WEB);
        const eventJson = new TextDecoder().decode(BASE64URL_CODEC.decode(url.searchParams.get('data')!));
        const event = JSON.parse(eventJson) as { notebook: string };
        const archive = await JSZip.loadAsync(BASE64URL_CODEC.decode(event.notebook));

        expect(archive.file('dashql-relations.sql')).toBeNull();
        expect(archive.file('dashql-functions.sql')).toBeNull();
    });

    it('includes catalogs in shared ZIP exports by default', async () => {
        const backend = new NotebookTestBackend();
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await backend.saveNotebookSchema(TEST_NOTEBOOK_ID, 'schema');
        await backend.saveNotebookFunctions(TEST_NOTEBOOK_ID, 'functions');

        const archive = await JSZip.loadAsync(await exportNotebookAsSharedZip(
            backend,
            TEST_NOTEBOOK_ID,
            new Map(),
        ));

        expect(await archive.file('dashql-relations.sql')!.async('text')).toBe('schema');
        expect(await archive.file('dashql-functions.sql')!.async('text')).toBe('functions');
    });

    it('generates new notebook and database UUIDs for shared exports by default', async () => {
        const backend = new NotebookTestBackend();
        const attachedDatabaseId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook({
            attachedDatabases: [{ databaseId: attachedDatabaseId, params: { hyper: {} } as any }],
        }));

        const archive = await JSZip.loadAsync(await exportNotebookAsSharedZip(
            backend,
            TEST_NOTEBOOK_ID,
            new Map(),
        ));
        const exported = JSON.parse(await archive.file('dashql-notebook.json')!.async('text'));

        expect(exported.notebookId).not.toBe(TEST_NOTEBOOK_ID);
        expect(exported.mainDatabase.databaseId).not.toBe(testNotebook().mainDatabase.databaseId);
        expect(exported.attachedDatabases[0].databaseId).not.toBe(attachedDatabaseId);
    });

    it('preserves notebook and database UUIDs when requested', async () => {
        const backend = new NotebookTestBackend();
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());

        const archive = await JSZip.loadAsync(await exportNotebookAsSharedZip(
            backend,
            TEST_NOTEBOOK_ID,
            new Map(),
            { preserveUUIDs: true },
        ));
        const exported = JSON.parse(await archive.file('dashql-notebook.json')!.async('text'));

        expect(exported.notebookId).toBe(TEST_NOTEBOOK_ID);
        expect(exported.mainDatabase.databaseId).toBe(testNotebook().mainDatabase.databaseId);
    });

    it('generates new UUIDs for URL exports by default', async () => {
        const backend = new NotebookTestBackend();
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());

        const url = await exportNotebookAsUrl(backend, TEST_NOTEBOOK_ID, new Map(), NotebookLinkTarget.WEB);
        const eventJson = new TextDecoder().decode(BASE64URL_CODEC.decode(url.searchParams.get('data')!));
        const event = JSON.parse(eventJson) as { notebook: string };
        const archive = await JSZip.loadAsync(BASE64URL_CODEC.decode(event.notebook));
        const exported = JSON.parse(await archive.file('dashql-notebook.json')!.async('text'));

        expect(exported.notebookId).not.toBe(TEST_NOTEBOOK_ID);
        expect(exported.mainDatabase.databaseId).not.toBe(testNotebook().mainDatabase.databaseId);
    });
});
