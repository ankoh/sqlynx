import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { BASE64URL_CODEC } from '../../../utils/base64.js';
import {
    createSessionZip,
    exportSessionAsSharedZip,
    exportSessionAsUrl,
    exportSessionAsZip,
    SessionLinkTarget,
} from './session_export.js';
import { importSessionFromZip } from './session_import.js';
import { sessionBundlesEqual } from '../../storage/session_bundle.js';
import { SessionTestBackend, TEST_SESSION_ID, testSession } from '../../storage/session_test_backend.js';

describe('V2 session export', () => {
    it('compares data bytes independently of typed-array JSON serialization', () => {
        const bundle = { session: testSession(), schemaSql: null, functionsSql: null, scripts: [] };
        const bytes = new Uint8Array([0, 255]);
        const view = new Uint8Array([99, 0, 255, 99]).subarray(1, 3);
        expect(sessionBundlesEqual({ ...bundle, data: [{ name: 'payload.bin', bytes }] },
            { ...bundle, data: [{ name: 'payload.bin', bytes: view }] })).toBe(true);
        expect(sessionBundlesEqual({ ...bundle, data: [{ name: 'payload.bin', bytes }] },
            { ...bundle, data: [{ name: 'payload.bin', bytes: new Uint8Array([0, 254]) }] })).toBe(false);
        expect(sessionBundlesEqual(bundle, { ...bundle, data: [] })).toBe(true);
    });
    it('persists arbitrary binary data and round-trips it through a ZIP', async () => {
        const bytes = new Uint8Array([0, 255, 128, 195, 40, 13, 10, 0]);
        const input = new JSZip();
        input.file('dashql-session.json', JSON.stringify(testSession()));
        input.file('attachments/2_payload.bin', bytes);
        const backend = new SessionTestBackend();
        await importSessionFromZip(await input.generateAsync({ type: 'blob' }), backend);
        expect(await backend.listDataFiles(TEST_SESSION_ID)).toEqual([{ name: '2_payload.bin', sizeBytes: bytes.length }]);
        expect(await backend.loadDataFile(TEST_SESSION_ID, '2_payload.bin')).toEqual(bytes);

        const archive = await JSZip.loadAsync(await exportSessionAsZip(TEST_SESSION_ID, backend));
        expect(archive.file('attachments/2_payload.bin')).not.toBeNull();
        expect(await archive.file('attachments/2_payload.bin')!.async('uint8array')).toEqual(bytes);
        const target = new SessionTestBackend();
        await importSessionFromZip(await archive.generateAsync({ type: 'blob' }), target);
        expect(await target.loadDataFile(TEST_SESSION_ID, '2_payload.bin')).toEqual(bytes);
    });
    it.each(['hyper', 'trino'])('omits %s header credentials from main and attached databases in ZIP and URL exports', async connector => {
        const backend = new SessionTestBackend();
        const metadata = { authorization: 'bearer-secret', cookie: 'cookie-secret', 'x-api-key': 'api-secret', arbitrary: 'custom-secret' };
        const params = connector === 'hyper' ? { hyper: {
            protocol: 'V3_HTTP', endpoint: 'https://identity.example',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
            metadata, queryParameters: { credential: 'query-secret' },
        } } : { trino: { endpoint: 'https://identity.example', catalogName: 'catalog', metadata } };
        const manifest = testSession({
            mainDatabase: { databaseId: testSession().mainDatabase.databaseId, params: params as any },
            attachedDatabases: [{ databaseId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', params: params as any }],
        });
        await backend.saveSessionManifest(TEST_SESSION_ID, manifest);
        const liveParams = new Map([manifest.mainDatabase, ...manifest.attachedDatabases].map(database => [database.databaseId, database.params]));
        const url = await exportSessionAsUrl(backend, TEST_SESSION_ID, liveParams, SessionLinkTarget.WEB);
        const event = JSON.parse(new TextDecoder().decode(BASE64URL_CODEC.decode(url.searchParams.get('data')!)));
        const archives = [
            await JSZip.loadAsync(await exportSessionAsZip(TEST_SESSION_ID, backend)),
            await JSZip.loadAsync(await exportSessionAsSharedZip(backend, TEST_SESSION_ID, liveParams)),
            await JSZip.loadAsync(BASE64URL_CODEC.decode(event.session)),
        ];
        for (const archive of archives) {
            const text = await archive.file('dashql-session.json')!.async('text');
            for (const secret of [...Object.values(metadata), 'query-secret']) expect(text).not.toContain(secret);
            const exported = JSON.parse(text);
            for (const database of [exported.mainDatabase, ...exported.attachedDatabases]) {
                expect(database.params[connector].metadata).toBeUndefined();
                expect(database.params[connector].queryParameters).toBeUndefined();
                expect(database.params[connector].endpoint).toBe('https://identity.example');
            }
        }
        expect((await backend.loadSession(TEST_SESSION_ID)).mainDatabase.params).toEqual(params);
    });
    it('omits main and attached drafts and secrets from plain and shared ZIP exports', async () => {
        const backend = new SessionTestBackend();
        const database = (databaseId: string) => ({
            databaseId,
            params: { trino: { endpoint: 'https://committed.example', auth: { authType: 'AUTH_BASIC', basic: { username: 'user', secret: 'committed-secret' } } } } as any,
            paramsDraft: { trino: { endpoint: 'unfinished', auth: { authType: 'AUTH_BASIC', basic: { username: 'user', secret: 'draft-secret' } } } } as any,
        });
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession({
            mainDatabase: database(testSession().mainDatabase.databaseId),
            attachedDatabases: [database('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')],
        }));
        for (const blob of [await exportSessionAsZip(TEST_SESSION_ID, backend), await exportSessionAsSharedZip(backend, TEST_SESSION_ID, new Map())]) {
            const archive = await JSZip.loadAsync(blob);
            const text = await archive.file('dashql-session.json')!.async('text');
            expect(text).not.toContain('paramsDraft');
            expect(text).not.toContain('committed-secret');
            expect(text).not.toContain('draft-secret');
            expect(JSON.parse(text).mainDatabase.params.trino.endpoint).toBe('https://committed.example');
        }
        expect((await backend.loadSession(TEST_SESSION_ID)).mainDatabase.paramsDraft).toBeDefined();
    });
    it('does not encode the reserved draft script', async () => {
        const archive = await JSZip.loadAsync(await createSessionZip(testSession(), [
            { name: 'dashql-draft.sql', sql: 'SELECT draft' },
            { name: '01_query.sql', sql: 'SELECT 1' },
        ]));

        expect(archive.file('scripts/dashql-draft.sql')).toBeNull();
        expect(await archive.file('scripts/01_query.sql')!.async('text')).toBe('SELECT 1');
    });

    it('exports only flat scripts and includes catalogs on request', async () => {
        const backend = new SessionTestBackend();
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        await backend.saveSessionSchema(TEST_SESSION_ID, 'schema');
        await backend.saveSessionFunctions(TEST_SESSION_ID, 'functions');
        await backend.saveScript(TEST_SESSION_ID, '01_first.sql', 'SELECT 1');
        await backend.saveScript(TEST_SESSION_ID, '02_second.sql', 'SELECT 2');

        const archive = await JSZip.loadAsync(await exportSessionAsZip(TEST_SESSION_ID, backend, { withCatalog: true }));
        expect(await archive.file('scripts/01_first.sql')!.async('text')).toBe('SELECT 1');
        expect(await archive.file('scripts/02_second.sql')!.async('text')).toBe('SELECT 2');
        expect(await archive.file('dashql-catalog-relations.sql')!.async('text')).toBe('schema');
        expect(await archive.file('dashql-catalog-functions.sql')!.async('text')).toBe('functions');
        expect(archive.file(/scripts\/[^/]+\/[^/]+/)).toEqual([]);
        expect(archive.file('scripts/dashql-draft.sql')).toBeNull();
    });

    it('round-trips a flat V2 archive through import', async () => {
        const source = new SessionTestBackend();
        await source.saveSessionManifest(TEST_SESSION_ID, testSession());
        await source.saveScript(TEST_SESSION_ID, '01_query.sql', 'SELECT 42');
        const target = new SessionTestBackend();

        const blob = await exportSessionAsZip(TEST_SESSION_ID, source);
        await expect(importSessionFromZip(blob, target)).resolves.toBe(TEST_SESSION_ID);
        expect(await target.loadScripts(TEST_SESSION_ID)).toEqual([{ name: '01_query.sql', sql: 'SELECT 42' }]);
    });

    it('omits catalogs from URL exports by default', async () => {
        const backend = new SessionTestBackend();
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        await backend.saveSessionSchema(TEST_SESSION_ID, 'schema');
        await backend.saveSessionFunctions(TEST_SESSION_ID, 'functions');

        const url = await exportSessionAsUrl(backend, TEST_SESSION_ID, new Map(), SessionLinkTarget.WEB);
        const eventJson = new TextDecoder().decode(BASE64URL_CODEC.decode(url.searchParams.get('data')!));
        const event = JSON.parse(eventJson) as { session: string };
        const archive = await JSZip.loadAsync(BASE64URL_CODEC.decode(event.session));

        expect(archive.file('dashql-catalog-relations.sql')).toBeNull();
        expect(archive.file('dashql-catalog-functions.sql')).toBeNull();
    });

    it('includes catalogs in shared ZIP exports by default', async () => {
        const backend = new SessionTestBackend();
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        await backend.saveSessionSchema(TEST_SESSION_ID, 'schema');
        await backend.saveSessionFunctions(TEST_SESSION_ID, 'functions');

        const archive = await JSZip.loadAsync(await exportSessionAsSharedZip(
            backend,
            TEST_SESSION_ID,
            new Map(),
        ));

        expect(await archive.file('dashql-catalog-relations.sql')!.async('text')).toBe('schema');
        expect(await archive.file('dashql-catalog-functions.sql')!.async('text')).toBe('functions');
    });

    it('generates new session and database UUIDs for shared exports by default', async () => {
        const backend = new SessionTestBackend();
        const attachedDatabaseId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession({
            attachedDatabases: [{ databaseId: attachedDatabaseId, params: { hyper: {} } as any }],
        }));
        await backend.saveScript(TEST_SESSION_ID, '01_attachment.sql',
            `SELECT * FROM external('/mnt/fs/sessions/${TEST_SESSION_ID}/attachments/payload.bin')`);

        const archive = await JSZip.loadAsync(await exportSessionAsSharedZip(
            backend,
            TEST_SESSION_ID,
            new Map(),
        ));
        const exported = JSON.parse(await archive.file('dashql-session.json')!.async('text'));
        expect(await archive.file('scripts/01_attachment.sql')!.async('text')).toContain(
            `/mnt/fs/sessions/${exported.sessionId}/attachments/payload.bin`);

        expect(exported.sessionId).not.toBe(TEST_SESSION_ID);
        expect(exported.mainDatabase.databaseId).not.toBe(testSession().mainDatabase.databaseId);
        expect(exported.attachedDatabases[0].databaseId).not.toBe(attachedDatabaseId);
    });

    it('preserves session and database UUIDs when requested', async () => {
        const backend = new SessionTestBackend();
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());

        const archive = await JSZip.loadAsync(await exportSessionAsSharedZip(
            backend,
            TEST_SESSION_ID,
            new Map(),
            { preserveUUIDs: true },
        ));
        const exported = JSON.parse(await archive.file('dashql-session.json')!.async('text'));

        expect(exported.sessionId).toBe(TEST_SESSION_ID);
        expect(exported.mainDatabase.databaseId).toBe(testSession().mainDatabase.databaseId);
    });

    it('generates new UUIDs for URL exports by default', async () => {
        const backend = new SessionTestBackend();
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());

        const url = await exportSessionAsUrl(backend, TEST_SESSION_ID, new Map(), SessionLinkTarget.WEB);
        const eventJson = new TextDecoder().decode(BASE64URL_CODEC.decode(url.searchParams.get('data')!));
        const event = JSON.parse(eventJson) as { session: string };
        const archive = await JSZip.loadAsync(BASE64URL_CODEC.decode(event.session));
        const exported = JSON.parse(await archive.file('dashql-session.json')!.async('text'));

        expect(exported.sessionId).not.toBe(TEST_SESSION_ID);
        expect(exported.mainDatabase.databaseId).not.toBe(testSession().mainDatabase.databaseId);
    });
});
