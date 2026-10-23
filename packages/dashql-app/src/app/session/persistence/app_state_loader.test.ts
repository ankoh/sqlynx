import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dashql from '@ankoh/dashql-core';
import * as flatbuffers from 'flatbuffers';
import * as buffers from '@ankoh/dashql-core/buffers';
import type { BatchProcessor } from '../../connections/catalog_batch.js';
import type { BatchRequest } from '@ankoh/dashql-core';

import type { DashQL } from '@ankoh/dashql-core';
import { Logger } from '../../../platform/logger/logger.js';
import { ConnectorType } from '../../connections/connector_info.js';
import { destroyRestoredSession, restoreAppState } from './app_state_loader.js';
import { destroySessionScripts, sessionConnectionIds } from '../scripts/session_scripts.js';
import type { StorageBackend } from '../../storage/storage_backend.js';
import { StorageBackendType } from '../../storage/storage_backend.js';
import { SessionTestBackend, TEST_CONNECTION_ID, TEST_SESSION_ID, testConnections, testSession } from '../../storage/session_test_backend.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

describe('V2 app state loader', () => {
    let backend: StorageBackend;
    let core: DashQL;
    let processor: BatchProcessor;

    beforeEach(() => {
        let scriptId = 0;
        core = {
            createCatalog: vi.fn(() => ({ replaceDescriptor: vi.fn(), destroy: vi.fn() })),
            createScript: vi.fn(() => {
                let text = '';
                return {
                    catalog_entry_id: ++scriptId,
                    replaceText: vi.fn((next: string) => { text = next; }),
                    toString: () => text, destroy: vi.fn(),
                };
            }),
            createScriptSession: vi.fn(() => {
                let text = '';
                let textVersion = 0n;
                return {
                    getCatalogEntryId: () => ++scriptId,
                    getTextVersion: () => textVersion,
                    replaceText: (_expectedTextVersion: bigint, next: string) => { text = next; textVersion += 1n; return { status: 0 }; },
                    getText: () => text,
                    destroy: vi.fn(),
                };
            }),
        } as any;
        const builder = new flatbuffers.Builder();
        builder.finish(new buffers.catalog.CatalogDescriptorT().pack(builder));
        const descriptor = builder.asUint8Array();
        processor = vi.fn(async (request: BatchRequest) => ({ scripts: request.scripts.map(script => ({
            id: script.id, diagnostics: [], catalogDescriptor: descriptor,
        })) }));
        backend = {
            getBackendType: () => StorageBackendType.OPFS,
            listSessions: vi.fn(async () => [{ path: TEST_SESSION_ID }]),
            loadAppSettings: vi.fn(async () => null), saveAppSettings: vi.fn(),
            loadSession: vi.fn(async () => testSession()), saveSessionManifest: vi.fn(), deleteSession: vi.fn(),
            loadSessionSchema: vi.fn(async () => null), saveSessionSchema: vi.fn(),
            loadSessionCatalogChanges: vi.fn(async () => null), saveSessionCatalogChanges: vi.fn(),
            loadSessionFunctions: vi.fn(async () => null), saveSessionFunctions: vi.fn(),
            loadScripts: vi.fn(async () => [
                { name: '10_last.sql', sql: 'SELECT 10' },
                { name: '2_first.sql', sql: 'SELECT 2' },
            ]),
            loadScript: vi.fn(), saveScript: vi.fn(), deleteScript: vi.fn(), renameScript: vi.fn(),
            listDataFiles: vi.fn(async () => []), loadDataFile: vi.fn(), saveDataFile: vi.fn(),
            deleteDataFile: vi.fn(), renameDataFile: vi.fn(),
            loadQueryResultCache: vi.fn(async () => null), touchQueryResultCacheAccess: vi.fn(),
            saveQueryResultCache: vi.fn(), listQueryResultCache: vi.fn(async () => []),
            hasCachedQueryResult: vi.fn(async () => false), deleteQueryResultCache: vi.fn(),
        };
    });

    it('restores one attached database and flat scripts with natural initial focus', async () => {
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(sessionConnectionIds(result.sessionScripts.get(TEST_SESSION_ID)!)).toEqual([TEST_CONNECTION_ID]);
        expect(result.connectionStatesByType[ConnectorType.HYPER]).toEqual([TEST_CONNECTION_ID]);
        const scripts = result.sessionScripts.get(TEST_SESSION_ID)!;
        // Files without an entry in the session file are appended in natural order
        expect(scripts.scriptOrder).toEqual(['2_first.sql', '10_last.sql']);
        expect(scripts.scriptFocus.fileName).toBe('2_first.sql');
        expect(scripts.scripts[scripts.scriptRefs['2_first.sql'].scriptId].scriptSession.getText()).toBe('SELECT 2');
        expect(backend.saveSessionManifest).toHaveBeenCalledWith(TEST_SESSION_ID, expect.objectContaining({
            scripts: [
                { name: '2_first.sql', connectionId: TEST_CONNECTION_ID },
                { name: '10_last.sql', connectionId: TEST_CONNECTION_ID },
            ],
        }));
    });

    it('restores the order and the connections of the session file', async () => {
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        vi.mocked(backend.loadSession).mockResolvedValue(testSession({
            ...testConnections(testSession().connections[0], { connectionId: remoteId, params: { trino: { endpoint: 'https://trino.example' } } as any }),
            scripts: [
                { name: '10_last.sql', connectionId: remoteId },
                { name: '2_first.sql', connectionId: '99999999-9999-4999-8999-999999999999' },
            ],
        }));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const scripts = result.sessionScripts.get(TEST_SESSION_ID)!;
        expect(scripts.scriptOrder).toEqual(['10_last.sql', '2_first.sql']);
        expect(scripts.scripts[scripts.scriptRefs['10_last.sql'].scriptId].connection.connectionId).toBe(remoteId);
        // An unknown connection runs on the default connection, the session file keeps the reference
        const first = scripts.scripts[scripts.scriptRefs['2_first.sql'].scriptId];
        expect(first.connection.connectionId).toBe(TEST_CONNECTION_ID);
        expect(first.unresolvedConnectionId).toBe('99999999-9999-4999-8999-999999999999');
        expect(result.sessionScriptsByConnection.get(remoteId)).toEqual([TEST_SESSION_ID]);
        expect(result.sessionScriptsByConnection.get(TEST_CONNECTION_ID)).toEqual([TEST_SESSION_ID]);
        expect(backend.saveSessionManifest).not.toHaveBeenCalledWith(TEST_SESSION_ID, expect.objectContaining({
            scripts: expect.arrayContaining([{ name: '2_first.sql', connectionId: TEST_CONNECTION_ID }]),
        }));
    });

    it('restores local and remote databases and routes scripts to the explicit main catalog', async () => {
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        vi.mocked(backend.loadSession).mockResolvedValue(testSession({
            ...testConnections({ connectionId: remoteId, params: { trino: { endpoint: 'https://trino.example' } } as any } as any, { connectionId: TEST_CONNECTION_ID, params: { hyper: { protocol: 'WASM' } } as any }),
            scripts: [{ name: '2_first.sql', connectionId: TEST_CONNECTION_ID }],
        }));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(sessionConnectionIds(result.sessionScripts.get(TEST_SESSION_ID)!)).toEqual([remoteId, TEST_CONNECTION_ID]);
        expect(result.connectionStates.size).toBe(2);
        expect(result.sessionScripts.get(TEST_SESSION_ID)?.connectionId).toBe(remoteId);
    });

    it('restores invalid drafts separately from committed settings without runtime OAuth state', async () => {
        const params = { salesforce: { instanceUrl: 'https://committed.example', appConsumerKey: 'key' } } as any;
        const paramsDraft = { salesforce: { instanceUrl: '', appConsumerKey: 'unfinished' } } as any;
        vi.mocked(backend.loadSession).mockResolvedValue(testSession({
            ...testConnections({ connectionId: TEST_CONNECTION_ID, params, paramsDraft } as any),
        }));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const restored = result.connectionStates.get(TEST_CONNECTION_ID)!;
        expect(restored.params).toEqual(params);
        expect(restored.paramsDraft).toEqual(paramsDraft);
        expect(restored.details.value.proto.setupParams).toEqual(params.salesforce);
        expect('oauthState' in restored.details.value.proto).toBe(false);
    });

    it('restores partially typed raw draft rows after manifest serialization', async () => {
        const rows = [{ key: '', value: 'partial' }, { key: '', value: '' }];
        const manifest = testSession(testConnections({
            connectionId: TEST_CONNECTION_ID,
            params: { hyper: { protocol: 'WASM', endpoint: '', tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' } } },
            paramsDraft: { hyper: { protocol: 'V3_HTTP', endpoint: 'unfinished', tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' }, draftRows: { metadata: rows, queryParameters: rows } } },
        } as any));
        vi.mocked(backend.loadSession).mockResolvedValue(JSON.parse(JSON.stringify(manifest)));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(result.connectionStates.get(TEST_CONNECTION_ID)?.paramsDraft).toEqual(manifest.connections[0].paramsDraft);
        expect(result.connectionStates.get(TEST_CONNECTION_ID)?.params).toEqual(manifest.connections[0].params);
    });

    it('keeps the local database as main when a remote is attached', async () => {
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        vi.mocked(backend.loadSession).mockResolvedValue(testSession({
            ...testConnections({ connectionId: TEST_CONNECTION_ID, params: { hyper: { protocol: 'WASM' } } as any } as any, { connectionId: remoteId, params: { trino: { endpoint: 'https://trino.example' } } as any }),
        }));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(result.sessionScripts.get(TEST_SESSION_ID)?.connectionId).toBe(TEST_CONNECTION_ID);
    });

    it('restores saved Salesforce relations and functions into the main catalog on reopen', async () => {
        const schemaSQL = 'CREATE TABLE "lakehouse"."public"."Account__dlm" ("Id__c" VARCHAR);';
        const functionsSQL = 'CREATE FUNCTION test() AS 1;';
        vi.mocked(backend.loadSession).mockResolvedValue(testSession({
            ...testConnections({
                connectionId: TEST_CONNECTION_ID,
                params: { salesforce: { instanceUrl: 'https://example.my.salesforce.com' } } as any,
            }),
        }));
        vi.mocked(backend.loadSessionSchema).mockResolvedValue(schemaSQL);
        vi.mocked(backend.loadSessionFunctions).mockResolvedValue(functionsSQL);

        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const connection = result.connectionStates.get(TEST_CONNECTION_ID)!;
        expect(connection.catalogRelationScript.replaceText).toHaveBeenCalledWith(schemaSQL);
        expect(connection.catalogFunctionScript.replaceText).toHaveBeenCalledWith(functionsSQL);
        expect(processor).toHaveBeenCalledWith({ scripts: [
            { id: connection.catalogRelationScript.catalog_entry_id.toString(), text: schemaSQL, outputs: ['catalogDescriptor'] },
            { id: connection.catalogFunctionScript.catalog_entry_id.toString(), text: functionsSQL, outputs: ['catalogDescriptor'] },
        ] });
        expect(vi.mocked(connection.catalog.replaceDescriptor).mock.calls).toEqual([
            [connection.catalogRelationScript.catalog_entry_id, expect.any(Number), expect.any(Uint8Array)],
            [connection.catalogFunctionScript.catalog_entry_id, expect.any(Number), expect.any(Uint8Array)],
        ]);
        expect(connection.catalogUpdates.restoredAt).toBeInstanceOf(Date);
    });

    it('keeps initial source SQL and leaves restoration pending when batch processing fails', async () => {
        vi.mocked(backend.loadSessionSchema).mockResolvedValue('CREATE TABLE restored(id int);');
        vi.mocked(processor).mockRejectedValue(new Error('worker failed'));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const connection = result.connectionStates.get(TEST_CONNECTION_ID)!;
        expect(connection.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(connection.catalogRelationScript.replaceText).toHaveBeenCalledTimes(1);
        expect(connection.catalogFunctionScript.replaceText).toHaveBeenCalledTimes(1);
        expect(connection.catalogUpdates.restoredAt).toBeNull();
        expect(result.sessionScripts.has(TEST_SESSION_ID)).toBe(true);
    });

    it.each(['relations', 'functions'])('rolls back only the failed %s source when descriptor publication fails', async source => {
        vi.mocked(backend.loadSessionSchema).mockResolvedValue('CREATE TABLE restored(id int);');
        vi.mocked(backend.loadSessionFunctions).mockResolvedValue('CREATE FUNCTION restored_fn() RETURNS int;');
        const replaceDescriptor = vi.fn<dashql.DashQLCatalog['replaceDescriptor']>(() => { throw new Error('publication failed'); });
        if (source === 'functions') replaceDescriptor.mockImplementationOnce(() => {});
        vi.mocked(core.createCatalog).mockImplementation(() => ({
            replaceDescriptor, destroy: vi.fn(),
        }) as any);
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const connection = result.connectionStates.get(TEST_CONNECTION_ID)!;
        expect(connection.catalog.replaceDescriptor).toHaveBeenCalledTimes(source === 'relations' ? 1 : 2);
        expect(connection.catalogRelationScript.replaceText).toHaveBeenCalledTimes(source === 'relations' ? 3 : 2);
        expect(connection.catalogFunctionScript.replaceText).toHaveBeenCalledTimes(source === 'relations' ? 1 : 3);
        if (source === 'relations') expect(connection.catalogRelationScript.toString()).not.toContain('CREATE TABLE restored');
        else expect(connection.catalogRelationScript.toString()).toBe('CREATE TABLE restored(id int);');
        expect(connection.catalogFunctionScript.toString()).not.toContain('CREATE FUNCTION restored_fn');
        expect(connection.catalogUpdates.restoredAt).toBeNull();
    });

    it('strictly refuses V1 before connection, catalog, scripts, or index mutation', async () => {
        vi.mocked(backend.loadSession).mockResolvedValue({ ...testSession(), formatVersion: 1 } as any);
        const result = await restoreAppState(core, backend, new NullLogger(), () => {});
        expect(result.invalidSessions.get(TEST_SESSION_ID)?.error).toBe('unsupported_format_version');
        expect(result.connectionStates.size).toBe(0);
        expect(result.sessionScripts.size).toBe(0);
        expect(core.createCatalog).not.toHaveBeenCalled();
        expect(backend.loadScripts).not.toHaveBeenCalled();
        expect(backend.saveSessionManifest).not.toHaveBeenCalled();
    });

    it('surfaces an unreadable session without allowing it into live registries', async () => {
        vi.mocked(backend.loadSession).mockRejectedValue(new Error('missing files'));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {});
        expect(result.invalidSessions.get(TEST_SESSION_ID)?.error).toBe('session_unreadable');
        expect(result.connectionStates.size).toBe(0);
        expect(result.sessionScripts.size).toBe(0);
    });
});

describe('real-core startup catalog restoration', () => {
    let dql: dashql.DashQL;
    beforeAll(async () => {
        dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        dql.resetUnsafe();
    });

    it('applies the persisted catalog changes on top of the restored relations', async () => {
        const backend = new SessionTestBackend();
        backend.sessions.set(TEST_SESSION_ID, testSession({
            ...testConnections({ connectionId: TEST_CONNECTION_ID, params: { hyper: { protocol: 'V3_HTTP', endpoint: 'http://hyper.example' } } as any }),
        }));
        const schema = 'CREATE TABLE "hyper"."public"."dropped"(id integer); CREATE TABLE "hyper"."public"."kept"(id integer);';
        const changesSql = dql.appendCatalogChangesSql('', [
            new dashql.buffers.catalog.CatalogChangeT(dashql.buffers.catalog.CatalogChangeType.DROP_RELATION, 'hyper', 'public', 'dropped'),
            new dashql.buffers.catalog.CatalogChangeT(dashql.buffers.catalog.CatalogChangeType.CREATE_RELATION, 'hyper', 'public', 'created', ['a']),
        ]);
        backend.schemas.set(TEST_SESSION_ID, schema);
        backend.catalogChanges.set(TEST_SESSION_ID, changesSql);
        const processor = vi.fn(async (request: BatchRequest) => dql.processBatch(request));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {}, processor);
        const main = restored.connectionStates.get(TEST_CONNECTION_ID)!;
        expect(main.catalogChangesSql).toBe(changesSql);
        expect(main.catalogRelationScript.toString()).toBe(schema);
        const entries = main.catalog.describeEntriesOf(main.catalogRelationScript.catalog_entry_id)
            .unpackAndDestroy() as dashql.buffers.catalog.CatalogEntriesT;
        const tables = entries.entries.flatMap(entry => entry.schemas.flatMap(schema => schema.tables.map(table => table.tableName)));
        expect(tables.sort()).toEqual(['created', 'kept']);
    });

    it('drops the persisted relations and changes of an embedded database seeded from a session', async () => {
        const backend = new SessionTestBackend();
        backend.sessions.set(TEST_SESSION_ID, testSession({
            ...testConnections({ connectionId: TEST_CONNECTION_ID, params: { hyper: { protocol: 'WASM' } } as any }),
        }));
        const functions = 'CREATE FUNCTION "hyper"."public"."kept_function"(value integer) RETURNS bigint;';
        backend.schemas.set(TEST_SESSION_ID, 'CREATE TABLE "hyper"."public"."gone"(id integer);');
        backend.catalogChanges.set(TEST_SESSION_ID, dql.appendCatalogChangesSql('', [
            new dashql.buffers.catalog.CatalogChangeT(dashql.buffers.catalog.CatalogChangeType.CREATE_RELATION, 'hyper', 'public', 'created', ['a']),
        ]));
        backend.functions.set(TEST_SESSION_ID, functions);
        const processor = vi.fn(async (request: BatchRequest) => dql.processBatch(request));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {}, processor);
        const main = restored.connectionStates.get(TEST_CONNECTION_ID)!;

        expect(main.catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(0);
        expect(main.catalogChangesSql).toBe('');
        expect(main.catalogFunctionScript.toString()).toBe(functions);
        // The catalog is refreshed on connect instead
        expect(main.catalogUpdates.restoredAt).toBeNull();
        // Only the functions seed the files of the connection
        expect([...backend.connectionFiles.keys()]).toEqual([`${TEST_CONNECTION_ID}/dashql-catalog-functions.sql`]);
        destroyRestoredSession({ sessionId: TEST_SESSION_ID, databases: [main],
            sessionScripts: restored.sessionScripts.get(TEST_SESSION_ID)! });
    });

    it('drops and clears the persisted relations and changes of an embedded connection', async () => {
        const backend = new SessionTestBackend();
        const params = { hyper: { protocol: 'WASM' } } as any;
        backend.connections = [{ id: TEST_CONNECTION_ID, params }];
        backend.sessions.set(TEST_SESSION_ID, testSession({ ...testConnections({ connectionId: TEST_CONNECTION_ID, params } as any) }));
        const functions = 'CREATE FUNCTION "hyper"."public"."kept_function"(value integer) RETURNS bigint;';
        backend.connectionFiles.set(`${TEST_CONNECTION_ID}/dashql-catalog-relations.sql`, 'CREATE TABLE "hyper"."public"."gone"(id integer);');
        backend.connectionFiles.set(`${TEST_CONNECTION_ID}/dashql-catalog-changes.sql`, dql.appendCatalogChangesSql('', [
            new dashql.buffers.catalog.CatalogChangeT(dashql.buffers.catalog.CatalogChangeType.CREATE_RELATION, 'hyper', 'public', 'created', ['a']),
        ]));
        backend.connectionFiles.set(`${TEST_CONNECTION_ID}/dashql-catalog-functions.sql`, functions);
        const processor = vi.fn(async (request: BatchRequest) => dql.processBatch(request));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {}, processor);
        const main = restored.connectionStates.get(TEST_CONNECTION_ID)!;

        expect(main.catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(0);
        expect(main.catalogChangesSql).toBe('');
        expect(main.catalogFunctionScript.toString()).toBe(functions);
        expect(main.catalogUpdates.restoredAt).toBeNull();
        expect(backend.connectionFiles.get(`${TEST_CONNECTION_ID}/dashql-catalog-relations.sql`)).toBe('');
        expect(backend.connectionFiles.get(`${TEST_CONNECTION_ID}/dashql-catalog-changes.sql`)).toBe('');
        expect(backend.connectionFiles.get(`${TEST_CONNECTION_ID}/dashql-catalog-functions.sql`)).toBe(functions);
        destroyRestoredSession({ sessionId: TEST_SESSION_ID, databases: [main],
            sessionScripts: restored.sessionScripts.get(TEST_SESSION_ID)! });
    });

    it('routes restored relations/functions to the main catalog using receiver source identities and retains persisted SQL', async () => {
        const backend = new SessionTestBackend();
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        backend.sessions.set(TEST_SESSION_ID, testSession({
            ...testConnections({ connectionId: remoteId, params: { trino: { endpoint: 'https://trino.example' } } as any } as any, { connectionId: TEST_CONNECTION_ID, params: { hyper: { protocol: 'WASM' } } as any }),
            scripts: [{ name: '01_query.sql', connectionId: remoteId }, { name: '02_local.sql', connectionId: TEST_CONNECTION_ID }],
        }));
        const schema = 'CREATE TABLE db.public.restored_items(id integer, name text);';
        const functions = 'CREATE FUNCTION db.public.restored_function(first integer, second numeric(12, 3)) RETURNS bigint;';
        backend.schemas.set(TEST_SESSION_ID, schema);
        backend.functions.set(TEST_SESSION_ID, functions);
        backend.scripts.set(TEST_SESSION_ID, new Map([['01_query.sql', 'SELECT id FROM db.public.restored_items;'], ['02_local.sql', 'SELECT 1;']]));
        const processor = vi.fn(async (request: BatchRequest) => dql.processBatch(request));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {}, processor);
        const main = restored.connectionStates.get(remoteId)!;
        const attached = restored.connectionStates.get(TEST_CONNECTION_ID)!;
        const session = restored.sessionScripts.get(TEST_SESSION_ID)!;
        expect(main.catalogRelationScript.toString()).toBe(schema);
        expect(main.catalogFunctionScript.toString()).toBe(functions);
        expect(processor).toHaveBeenCalledTimes(1);
        expect(session.connectionCatalog).toBe(main.catalog);
        expect(session.connectionId).toBe(remoteId);
        const entries = main.catalog.describeEntries().unpackAndDestroy().entries as dashql.buffers.catalog.CatalogEntryT[];
        expect(entries.map(entry => entry.catalogEntryId).sort((a, b) => a - b)).toEqual([
            main.catalogRelationScript.catalog_entry_id, main.catalogFunctionScript.catalog_entry_id,
        ].sort((a, b) => a - b));
        expect(entries.every(entry => entry.catalogEntryType === dashql.buffers.catalog.CatalogEntryType.DESCRIPTOR_POOL)).toBe(true);
        expect(main.catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(1);
        expect(attached.catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(0);
        expect(main.catalogUpdates.restoredAt).toBeInstanceOf(Date);
        const query = dql.createScript(main.catalog);
        query.replaceText('SELECT id FROM db.public.restored_items;');
        query.analyze();
        expect(query.getAnalyzed().unpackAndDestroy().tableReferences[0].resolvedTable.catalogTableId)
            .toBe(dashql.ExternalObjectID.create(main.catalogRelationScript.catalog_entry_id, 0));
        query.replaceText('SELECT restored_fun');
        query.analyze();
        query.moveCursor('SELECT restored_fun'.length).destroy();
        const completion = query.completeAtCursor(50).unpackAndDestroy();
        const candidate = completion.candidates.find((candidate: dashql.buffers.completion.CompletionCandidateT) => candidate.completionText === 'restored_function()');
        expect(candidate).toBeDefined();
        expect(candidate.catalogObjects[0].objectType).toBe(dashql.buffers.completion.CompletionCandidateObjectType.FUNCTION);
        expect(candidate.catalogObjects[0].qualifiedName).toEqual(['db', 'public', 'restored_function']);
        query.destroy();
        destroyRestoredSession({ sessionId: TEST_SESSION_ID, databases: [main, attached],
            sessionScripts: session });
    });
});

describe('global connections', () => {
    const OTHER_SESSION_ID = '22222222-3333-4444-8555-666666666666';
    const OTHER_CONNECTION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const trino = (endpoint: string) => ({ trino: { endpoint, auth: { authType: 'AUTH_BASIC' } } }) as any;
    let dql: dashql.DashQL;
    beforeAll(async () => {
        dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        dql.resetUnsafe();
    });
    function seed(backend: SessionTestBackend, sessionId: string, connectionId: string, params: object, paramsDraft?: object) {
        backend.sessions.set(sessionId, testSession({
            sessionId,
            ...testConnections({ connectionId, params, ...(paramsDraft ? { paramsDraft } : {}) } as any),
        }));
    }

    it('lets the app manifest win over stale session copies and resolves aliases', async () => {
        const backend = new SessionTestBackend();
        backend.connections = [{ id: TEST_CONNECTION_ID, params: trino('https://saved'), aliases: [OTHER_CONNECTION_ID] }];
        seed(backend, TEST_SESSION_ID, TEST_CONNECTION_ID, trino('https://stale'));
        seed(backend, OTHER_SESSION_ID, OTHER_CONNECTION_ID, trino('https://stale'));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {});

        expect([...restored.connectionStates.keys()]).toEqual([TEST_CONNECTION_ID]);
        expect(restored.connectionStates.get(TEST_CONNECTION_ID)!.params).toEqual(trino('https://saved'));
        for (const sessionId of [TEST_SESSION_ID, OTHER_SESSION_ID]) {
            expect(backend.sessions.get(sessionId)!.connections).toEqual([{ connectionId: TEST_CONNECTION_ID, params: trino('https://saved') }]);
            expect(backend.sessions.get(sessionId)!.defaultConnectionId).toBe(TEST_CONNECTION_ID);
        }
        for (const session of restored.sessionScripts.values()) destroySessionScripts(session);
    });

    it('restores the name from the app manifest and replicates it into stale session copies', async () => {
        const backend = new SessionTestBackend();
        backend.connections = [{ id: TEST_CONNECTION_ID, name: 'Production', params: trino('https://saved') }];
        seed(backend, TEST_SESSION_ID, TEST_CONNECTION_ID, trino('https://saved'));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {});

        expect(restored.connectionStates.get(TEST_CONNECTION_ID)!.name).toBe('Production');
        expect(backend.sessions.get(TEST_SESSION_ID)!.connections).toEqual([{ connectionId: TEST_CONNECTION_ID, name: 'Production', params: trino('https://saved') }]);
        for (const session of restored.sessionScripts.values()) destroySessionScripts(session);
    });

    it('restores the name of a connection that only a session knows', async () => {
        const backend = new SessionTestBackend();
        backend.connections = [];
        backend.sessions.set(TEST_SESSION_ID, testSession({
            sessionId: TEST_SESSION_ID,
            ...testConnections({ connectionId: TEST_CONNECTION_ID, name: 'Staging', params: trino('https://unknown') } as any),
        }));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {});

        expect(restored.connectionStates.get(TEST_CONNECTION_ID)!.name).toBe('Staging');
        expect(backend.connections).toMatchObject([{ id: TEST_CONNECTION_ID, name: 'Staging', params: trino('https://unknown') }]);
        for (const session of restored.sessionScripts.values()) destroySessionScripts(session);
    });

    it('registers connections that only a session knows', async () => {
        const backend = new SessionTestBackend();
        backend.connections = [];
        seed(backend, TEST_SESSION_ID, TEST_CONNECTION_ID, trino('https://unknown'));
        backend.schemas.set(TEST_SESSION_ID, 'CREATE TABLE db.public.seeded(id integer);');
        const processor = vi.fn(async (request: BatchRequest) => dql.processBatch(request));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {}, processor);

        expect(restored.connectionStates.get(TEST_CONNECTION_ID)!.params).toEqual(trino('https://unknown'));
        expect(backend.connections).toMatchObject([{ id: TEST_CONNECTION_ID, params: trino('https://unknown') }]);
        expect(backend.connectionFiles.get(`${TEST_CONNECTION_ID}/dashql-catalog-relations.sql`)).toBe('CREATE TABLE db.public.seeded(id integer);');
        for (const session of restored.sessionScripts.values()) destroySessionScripts(session);
    });
});
