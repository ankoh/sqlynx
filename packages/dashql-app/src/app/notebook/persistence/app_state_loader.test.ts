import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dashql from '@ankoh/dashql-core';
import * as flatbuffers from 'flatbuffers';
import * as buffers from '@ankoh/dashql-core/buffers';
import type { BatchProcessor } from '../connections/catalog_batch.js';
import type { BatchRequest } from '@ankoh/dashql-core';

import type { DashQL } from '@ankoh/dashql-core';
import { Logger } from '../../../platform/logger/logger.js';
import { ConnectorType } from '../connections/connector_info.js';
import { destroyRestoredNotebook, restoreAppState } from './app_state_loader.js';
import type { StorageBackend } from './storage_backend.js';
import { StorageBackendType } from './storage_backend.js';
import { NotebookTestBackend, TEST_DATABASE_ID, TEST_NOTEBOOK_ID, testNotebook } from './notebook_test_backend.js';

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
            listNotebooks: vi.fn(async () => [{ path: TEST_NOTEBOOK_ID }]),
            loadAppSettings: vi.fn(async () => null), saveAppSettings: vi.fn(),
            loadNotebook: vi.fn(async () => testNotebook()), saveNotebookManifest: vi.fn(), deleteNotebook: vi.fn(),
            ensureNotebookIndex: vi.fn(),
            loadNotebookSchema: vi.fn(async () => null), saveNotebookSchema: vi.fn(),
            loadNotebookFunctions: vi.fn(async () => null), saveNotebookFunctions: vi.fn(),
            loadScripts: vi.fn(async () => [
                { name: '10_last.sql', sql: 'SELECT 10' },
                { name: '2_first.sql', sql: 'SELECT 2' },
            ]),
            loadScript: vi.fn(), saveScript: vi.fn(), deleteScript: vi.fn(), renameScript: vi.fn(),
            loadQueryResultCache: vi.fn(async () => null), touchQueryResultCacheAccess: vi.fn(),
            saveQueryResultCache: vi.fn(), listQueryResultCache: vi.fn(async () => []),
            hasCachedQueryResult: vi.fn(async () => false), deleteQueryResultCache: vi.fn(),
        };
    });

    it('restores one attached database and flat scripts with natural initial focus', async () => {
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(result.attachedDatabasesByNotebook.get(TEST_NOTEBOOK_ID)).toEqual({
            mainDatabaseId: TEST_DATABASE_ID,
            attachedDatabaseIds: [],
        });
        expect(result.connectionStatesByType[ConnectorType.HYPER]).toEqual([TEST_DATABASE_ID]);
        const scripts = result.notebookScripts.get(TEST_NOTEBOOK_ID)!;
        expect(Object.keys(scripts.scriptRefs)).toEqual(['10_last.sql', '2_first.sql']);
        expect(scripts.scriptFocus.fileName).toBe('2_first.sql');
        expect(scripts.scripts[scripts.scriptRefs['2_first.sql'].scriptId].scriptSession.getText()).toBe('SELECT 2');
        expect(backend.ensureNotebookIndex).toHaveBeenCalledWith(TEST_NOTEBOOK_ID);
    });

    it('restores local and remote databases and routes scripts to the explicit main catalog', async () => {
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        vi.mocked(backend.loadNotebook).mockResolvedValue(testNotebook({
            mainDatabase: { databaseId: remoteId, params: { trino: { endpoint: 'https://trino.example' } } as any },
            attachedDatabases: [{ databaseId: TEST_DATABASE_ID, params: { hyper: { protocol: 'WASM' } } as any }],
        }));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(result.attachedDatabasesByNotebook.get(TEST_NOTEBOOK_ID)).toEqual({
            mainDatabaseId: remoteId,
            attachedDatabaseIds: [TEST_DATABASE_ID],
        });
        expect(result.connectionStates.size).toBe(2);
        expect(result.notebookScripts.get(TEST_NOTEBOOK_ID)?.databaseId).toBe(remoteId);
    });

    it('restores invalid drafts separately from committed settings without runtime OAuth state', async () => {
        const params = { salesforce: { instanceUrl: 'https://committed.example', appConsumerKey: 'key' } } as any;
        const paramsDraft = { salesforce: { instanceUrl: '', appConsumerKey: 'unfinished' } } as any;
        vi.mocked(backend.loadNotebook).mockResolvedValue(testNotebook({
            mainDatabase: { databaseId: TEST_DATABASE_ID, params, paramsDraft },
        }));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const restored = result.connectionStates.get(TEST_DATABASE_ID)!;
        expect(restored.params).toEqual(params);
        expect(restored.paramsDraft).toEqual(paramsDraft);
        expect(restored.details.value.proto.setupParams).toEqual(params.salesforce);
        expect('oauthState' in restored.details.value.proto).toBe(false);
    });

    it('restores partially typed raw draft rows after manifest serialization', async () => {
        const rows = [{ key: '', value: 'partial' }, { key: '', value: '' }];
        const manifest = testNotebook({ mainDatabase: {
            databaseId: TEST_DATABASE_ID,
            params: { hyper: { protocol: 'WASM', endpoint: '', tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' } } },
            paramsDraft: { hyper: { protocol: 'V3_HTTP', endpoint: 'unfinished', tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' }, draftRows: { metadata: rows, queryParameters: rows } } },
        } });
        vi.mocked(backend.loadNotebook).mockResolvedValue(JSON.parse(JSON.stringify(manifest)));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(result.connectionStates.get(TEST_DATABASE_ID)?.paramsDraft).toEqual(manifest.mainDatabase.paramsDraft);
        expect(result.connectionStates.get(TEST_DATABASE_ID)?.params).toEqual(manifest.mainDatabase.params);
    });

    it('keeps the local database as main when a remote is attached', async () => {
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        vi.mocked(backend.loadNotebook).mockResolvedValue(testNotebook({
            mainDatabase: { databaseId: TEST_DATABASE_ID, params: { hyper: { protocol: 'WASM' } } as any },
            attachedDatabases: [{ databaseId: remoteId, params: { trino: { endpoint: 'https://trino.example' } } as any }],
        }));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        expect(result.notebookScripts.get(TEST_NOTEBOOK_ID)?.databaseId).toBe(TEST_DATABASE_ID);
    });

    it('restores saved Salesforce relations and functions into the main catalog on reopen', async () => {
        const schemaSQL = 'CREATE TABLE "lakehouse"."public"."Account__dlm" ("Id__c" VARCHAR);';
        const functionsSQL = 'CREATE FUNCTION test() AS 1;';
        vi.mocked(backend.loadNotebook).mockResolvedValue(testNotebook({
            mainDatabase: {
                databaseId: TEST_DATABASE_ID,
                params: { salesforce: { instanceUrl: 'https://example.my.salesforce.com' } } as any,
            },
        }));
        vi.mocked(backend.loadNotebookSchema).mockResolvedValue(schemaSQL);
        vi.mocked(backend.loadNotebookFunctions).mockResolvedValue(functionsSQL);

        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const connection = result.connectionStates.get(TEST_DATABASE_ID)!;
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
        vi.mocked(backend.loadNotebookSchema).mockResolvedValue('CREATE TABLE restored(id int);');
        vi.mocked(processor).mockRejectedValue(new Error('worker failed'));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const connection = result.connectionStates.get(TEST_DATABASE_ID)!;
        expect(connection.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(connection.catalogRelationScript.replaceText).toHaveBeenCalledTimes(1);
        expect(connection.catalogFunctionScript.replaceText).toHaveBeenCalledTimes(1);
        expect(connection.catalogUpdates.restoredAt).toBeNull();
        expect(result.notebookScripts.has(TEST_NOTEBOOK_ID)).toBe(true);
    });

    it.each(['relations', 'functions'])('rolls back only the failed %s source when descriptor publication fails', async source => {
        vi.mocked(backend.loadNotebookSchema).mockResolvedValue('CREATE TABLE restored(id int);');
        vi.mocked(backend.loadNotebookFunctions).mockResolvedValue('CREATE FUNCTION restored_fn() RETURNS int;');
        const replaceDescriptor = vi.fn<dashql.DashQLCatalog['replaceDescriptor']>(() => { throw new Error('publication failed'); });
        if (source === 'functions') replaceDescriptor.mockImplementationOnce(() => {});
        vi.mocked(core.createCatalog).mockImplementation(() => ({
            replaceDescriptor, destroy: vi.fn(),
        }) as any);
        const result = await restoreAppState(core, backend, new NullLogger(), () => {}, processor);
        const connection = result.connectionStates.get(TEST_DATABASE_ID)!;
        expect(connection.catalog.replaceDescriptor).toHaveBeenCalledTimes(source === 'relations' ? 1 : 2);
        expect(connection.catalogRelationScript.replaceText).toHaveBeenCalledTimes(source === 'relations' ? 3 : 2);
        expect(connection.catalogFunctionScript.replaceText).toHaveBeenCalledTimes(source === 'relations' ? 1 : 3);
        if (source === 'relations') expect(connection.catalogRelationScript.toString()).not.toContain('CREATE TABLE restored');
        else expect(connection.catalogRelationScript.toString()).toBe('CREATE TABLE restored(id int);');
        expect(connection.catalogFunctionScript.toString()).not.toContain('CREATE FUNCTION restored_fn');
        expect(connection.catalogUpdates.restoredAt).toBeNull();
    });

    it('strictly refuses V1 before connection, catalog, scripts, or index mutation', async () => {
        vi.mocked(backend.loadNotebook).mockResolvedValue({ ...testNotebook(), formatVersion: 1 } as any);
        const result = await restoreAppState(core, backend, new NullLogger(), () => {});
        expect(result.invalidNotebooks.get(TEST_NOTEBOOK_ID)?.error).toBe('unsupported_format_version');
        expect(result.connectionStates.size).toBe(0);
        expect(result.notebookScripts.size).toBe(0);
        expect(core.createCatalog).not.toHaveBeenCalled();
        expect(backend.loadScripts).not.toHaveBeenCalled();
        expect(backend.ensureNotebookIndex).not.toHaveBeenCalled();
    });

    it('surfaces an unreadable notebook without allowing it into live registries', async () => {
        vi.mocked(backend.loadNotebook).mockRejectedValue(new Error('missing files'));
        const result = await restoreAppState(core, backend, new NullLogger(), () => {});
        expect(result.invalidNotebooks.get(TEST_NOTEBOOK_ID)?.error).toBe('notebook_unreadable');
        expect(result.connectionStates.size).toBe(0);
        expect(result.notebookScripts.size).toBe(0);
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

    it('routes restored relations/functions to the main catalog using receiver source identities and retains persisted SQL', async () => {
        const backend = new NotebookTestBackend();
        const remoteId = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
        backend.notebooks.set(TEST_NOTEBOOK_ID, testNotebook({
            mainDatabase: { databaseId: remoteId, params: { trino: { endpoint: 'https://trino.example' } } as any },
            attachedDatabases: [{ databaseId: TEST_DATABASE_ID, params: { hyper: { protocol: 'WASM' } } as any }],
        }));
        const schema = 'CREATE TABLE db.public.restored_items(id integer, name text);';
        const functions = 'CREATE FUNCTION db.public.restored_function(first integer, second numeric(12, 3)) RETURNS bigint;';
        backend.schemas.set(TEST_NOTEBOOK_ID, schema);
        backend.functions.set(TEST_NOTEBOOK_ID, functions);
        backend.scripts.set(TEST_NOTEBOOK_ID, new Map([['01_query.sql', 'SELECT id FROM db.public.restored_items;']]));
        const processor = vi.fn(async (request: BatchRequest) => dql.processBatch(request));
        const restored = await restoreAppState(dql, backend, new NullLogger(), () => {}, processor);
        const main = restored.connectionStates.get(remoteId)!;
        const attached = restored.connectionStates.get(TEST_DATABASE_ID)!;
        const notebook = restored.notebookScripts.get(TEST_NOTEBOOK_ID)!;
        expect(main.catalogRelationScript.toString()).toBe(schema);
        expect(main.catalogFunctionScript.toString()).toBe(functions);
        expect(processor).toHaveBeenCalledTimes(1);
        expect(notebook.connectionCatalog).toBe(main.catalog);
        expect(notebook.databaseId).toBe(remoteId);
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
        destroyRestoredNotebook({ notebookId: TEST_NOTEBOOK_ID, databases: [main, attached],
            mapping: restored.attachedDatabasesByNotebook.get(TEST_NOTEBOOK_ID)!, notebookScripts: notebook });
    });
});
