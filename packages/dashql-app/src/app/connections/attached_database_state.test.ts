import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as flatbuffers from 'flatbuffers';
import * as dashql from '@ankoh/dashql-core';
import {
    APPLY_CATALOG_CHANGES,
    attachedDatabaseCatalogMatchesStorage,
    CATALOG_UPDATE_SUCCEEDED,
    createAttachedDatabaseStateForType,
    DELETE_ATTACHED_DATABASE,
    RESET_ATTACHED_DATABASE,
    reduceAttachedDatabaseState,
    replaceAttachedDatabaseCatalogFromStorage,
    UPDATE_CATALOG,
    type AttachedDatabaseState,
} from './attached_database_state.js';
import { TestLogger } from '../../platform/logger/test_logger.js';
import { ConnectorType } from './connector_info.js';
import { publishCatalogBatch } from './catalog_batch.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, CatalogUpdateTaskStatus, CatalogUpdateVariant } from './catalog_update_state.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;
let dql: dashql.DashQL;

beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});
afterEach(() => {
    vi.restoreAllMocks();
    dql.resetUnsafe();
});

function state(): AttachedDatabaseState {
    return { ...createAttachedDatabaseStateForType(dql, ConnectorType.HYPER, new Map()), databaseId: 'test' };
}

describe('attached database descriptor catalogs', () => {
    it.each([RESET_ATTACHED_DATABASE, DELETE_ATTACHED_DATABASE] as const)('promptly aborts pending publishers before clearing running tasks on %s', async type => {
        const database = state();
        const controllers = [new AbortController(), new AbortController()];
        const aborts = controllers.map(controller => vi.spyOn(controller, 'abort'));
        const cleanup = vi.spyOn(database.catalog, type === RESET_ATTACHED_DATABASE ? 'clear' : 'destroy');
        for (const [taskId, cancellation] of controllers.entries()) {
            database.catalogUpdates.tasksRunning.set(taskId, {
                taskId,
                taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
                status: CatalogUpdateTaskStatus.STARTED,
                cancellation,
                queries: [],
                error: null,
                startedAt: new Date(),
                finishedAt: null,
                lastUpdateAt: new Date(),
            });
        }
        const publication = publishCatalogBatch(dql, database.catalog, [{
            script: database.catalogRelationScript,
            text: 'CREATE TABLE pending(id int);',
            rank: 10,
        }], {
            abortSignal: controllers[0].signal,
            processor: () => new Promise(() => {}),
        });
        const outcome = publication.then(() => 'published', error => error.name);
        const next = reduceAttachedDatabaseState(database, { type, value: null }, {} as any, {} as any);
        expect(controllers.every(controller => controller.signal.aborted)).toBe(true);
        for (const abort of aborts) {
            expect(abort.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]);
        }
        expect(next.catalogUpdates.tasksRunning.size).toBe(0);
        expect(next.catalogUpdates.currentFullRefresh).toBeNull();
        expect(await Promise.race([outcome, (async () => {
            for (let i = 0; i < 10; ++i) await Promise.resolve();
            return 'still pending';
        })()])).toBe('AbortError');
    });

    it('reconciles storage relations and functions sequentially without analyzing the source scripts', () => {
        const database = state();
        const relationAnalysis = vi.spyOn(database.catalogRelationScript, 'analyze');
        const functionAnalysis = vi.spyOn(database.catalogFunctionScript, 'analyze');
        const replace = vi.spyOn(database.catalog, 'replaceDescriptor');
        const version = database.catalog.createSnapshot().read().catalogReader.catalogVersion();
        const schema = 'CREATE TABLE stored(id int);';
        const functions = 'CREATE FUNCTION stored_fn() RETURNS bigint;';
        expect(replaceAttachedDatabaseCatalogFromStorage(database, schema, functions)).toBe(true);
        expect(replace.mock.calls.map(([id, rank]) => [id, rank])).toEqual([
            [database.catalogRelationScript.catalog_entry_id, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK],
            [database.catalogFunctionScript.catalog_entry_id, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK],
        ]);
        const descriptors = replace.mock.calls.map(([, , bytes]) => {
            expect(ArrayBuffer.isView(bytes)).toBe(true);
            expect(Object.prototype.toString.call(bytes)).toBe('[object Uint8Array]');
            expect(bytes.byteLength).toBeGreaterThan(0);
            return dashql.buffers.catalog.CatalogDescriptor.getRootAsCatalogDescriptor(new flatbuffers.ByteBuffer(bytes));
        });
        expect(descriptors[0].tablesLength()).toBe(1);
        expect(descriptors[1].functionDeclarationsLength()).toBe(1);
        expect(relationAnalysis).not.toHaveBeenCalled();
        expect(functionAnalysis).not.toHaveBeenCalled();
        expect(database.catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(1);
        expect(database.catalog.createSnapshot().read().catalogReader.catalogVersion()).toBe(version + 2n);
        expect(attachedDatabaseCatalogMatchesStorage(database, schema, functions)).toBe(true);
        expect(replaceAttachedDatabaseCatalogFromStorage(database, schema, functions)).toBe(false);
        expect(replace).toHaveBeenCalledTimes(2);
    });

    it('keeps both source scripts, catalog snapshot and restored timestamp on processing or first import failure', () => {
        const database = state();
        const schema = 'CREATE TABLE stored(id int);';
        const functions = 'CREATE FUNCTION stored_fn() RETURNS bigint;';
        replaceAttachedDatabaseCatalogFromStorage(database, schema, functions);
        const restoredAt = database.catalogUpdates.restoredAt;
        const snapshot = database.catalog.createSnapshot();
        expect(() => replaceAttachedDatabaseCatalogFromStorage(database, 'CREATE TABLE changed(id int);', 'invalid ! SQL'))
            .toThrow();
        expect(attachedDatabaseCatalogMatchesStorage(database, schema, functions)).toBe(true);
        expect(database.catalog.createSnapshot()).toBe(snapshot);
        const replace = vi.spyOn(database.catalog, 'replaceDescriptor').mockImplementation(() => { throw new Error('import failed'); });
        expect(() => replaceAttachedDatabaseCatalogFromStorage(database, 'CREATE TABLE changed(id int);', functions)).toThrow('import failed');
        expect(attachedDatabaseCatalogMatchesStorage(database, schema, functions)).toBe(true);
        expect(database.catalog.createSnapshot()).toBe(snapshot);
        expect(database.catalogUpdates.restoredAt).toBe(restoredAt);
        replace.mockRestore();
    });

    it('replaces removed storage files with empty descriptors', () => {
        const database = state();
        replaceAttachedDatabaseCatalogFromStorage(database, 'CREATE TABLE stored(id int);', 'CREATE FUNCTION stored_fn() RETURNS bigint;');
        expect(replaceAttachedDatabaseCatalogFromStorage(database, null, null)).toBe(true);
        expect(database.catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(0);
        expect(attachedDatabaseCatalogMatchesStorage(database, null, null)).toBe(true);
        expect(replaceAttachedDatabaseCatalogFromStorage(database, null, null)).toBe(false);
    });

    it('republishes identical storage SQL after reset clears descriptor identities', () => {
        let database = state();
        const schema = 'CREATE TABLE stored(id int);';
        const functions = 'CREATE FUNCTION stored_fn() RETURNS bigint;';
        replaceAttachedDatabaseCatalogFromStorage(database, schema, functions);
        database = reduceAttachedDatabaseState(database, { type: RESET_ATTACHED_DATABASE, value: null }, {} as any, {} as any);
        expect(database.catalogRelationScript.toString()).toBe(schema);
        expect(database.catalogFunctionScript.toString()).toBe(functions);
        expect(attachedDatabaseCatalogMatchesStorage(database, schema, functions)).toBe(false);
        expect(replaceAttachedDatabaseCatalogFromStorage(database, schema, functions)).toBe(true);
        expect(database.catalog.containsEntryId(database.catalogRelationScript.catalog_entry_id)).toBe(true);
        expect(database.catalog.containsEntryId(database.catalogFunctionScript.catalog_entry_id)).toBe(true);
        expect(database.catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(1);
        expect(attachedDatabaseCatalogMatchesStorage(database, schema, functions)).toBe(true);
    });

    it.each([
        { source: 'relations', failure: 'source write' },
        { source: 'functions', failure: 'source write' },
        { source: 'relations', failure: 'descriptor import' },
        { source: 'functions', failure: 'descriptor import' },
    ])('retains earlier pools and rolls back only the failed $source source on $failure failure', ({ source, failure }) => {
        const database = state();
        const schema = 'CREATE TABLE stored(id int);';
        const functions = 'CREATE FUNCTION stored_fn() RETURNS bigint;';
        replaceAttachedDatabaseCatalogFromStorage(database, schema, functions);
        const snapshot = database.catalog.createSnapshot();
        const version = snapshot.read().catalogReader.catalogVersion();
        const restoredAt = database.catalogUpdates.restoredAt;
        const script = source === 'relations' ? database.catalogRelationScript : database.catalogFunctionScript;
        const replaceDescriptor = database.catalog.replaceDescriptor.bind(database.catalog);
        const publication = vi.spyOn(database.catalog, 'replaceDescriptor');
        if (failure === 'source write') {
            vi.spyOn(script, 'replaceText').mockImplementationOnce(() => { throw new Error('allocation failed'); });
        } else {
            publication.mockImplementation((id, rank, descriptor) => {
                if (id === script.catalog_entry_id) throw new Error('import failed');
                replaceDescriptor(id, rank, descriptor);
            });
        }
        expect(() => replaceAttachedDatabaseCatalogFromStorage(database,
            'CREATE TABLE changed(id int);', 'CREATE FUNCTION changed_fn() RETURNS bigint;'))
            .toThrow(failure === 'source write' ? 'allocation failed' : 'import failed');
        expect(publication).toHaveBeenCalledTimes((source === 'functions' ? 1 : 0) + (failure === 'descriptor import' ? 1 : 0));
        expect(database.catalogRelationScript.toString()).toBe(source === 'functions' ? 'CREATE TABLE changed(id int);' : schema);
        expect(database.catalogFunctionScript.toString()).toBe(functions);
        const currentSnapshot = database.catalog.createSnapshot();
        if (source === 'relations') {
            expect(currentSnapshot).toBe(snapshot);
            expect(currentSnapshot.read().catalogReader.catalogVersion()).toBe(version);
        }
        else {
            expect(currentSnapshot).not.toBe(snapshot);
            expect(currentSnapshot.read().catalogReader.catalogVersion()).toBe(version + 1n);
            expect(attachedDatabaseCatalogMatchesStorage(database, 'CREATE TABLE changed(id int);', functions)).toBe(true);
        }
        expect(database.catalogUpdates.restoredAt).toBe(restoredAt);
    });

    it('drops both descriptors before destroying their text-only source scripts', () => {
        const database = state();
        replaceAttachedDatabaseCatalogFromStorage(database, 'CREATE TABLE stored(id int);', 'CREATE FUNCTION stored_fn() RETURNS bigint;');
        const drops = vi.spyOn(database.catalog, 'dropDescriptor');
        const destroyRelations = vi.spyOn(database.catalogRelationScript, 'destroy');
        const destroyFunctions = vi.spyOn(database.catalogFunctionScript, 'destroy');
        reduceAttachedDatabaseState(database, { type: DELETE_ATTACHED_DATABASE, value: null }, {} as any, {} as any);
        expect(drops.mock.calls).toEqual([
            [database.catalogRelationScript.catalog_entry_id],
            [database.catalogFunctionScript.catalog_entry_id],
        ]);
        expect(destroyRelations).toHaveBeenCalledTimes(1);
        expect(destroyFunctions).toHaveBeenCalledTimes(1);
    });
});

/// The relations of the relation descriptor as `db.schema.table(a, b)`
function relationsOf(database: AttachedDatabaseState): string[] {
    const relations: string[] = [];
    const entries = database.catalog.describeEntriesOf(database.catalogRelationScript.catalog_entry_id)
        .unpackAndDestroy() as dashql.buffers.catalog.CatalogEntriesT;
    for (const entry of entries.entries) {
        for (const schema of entry.schemas) {
            for (const table of schema.tables) {
                relations.push(`${schema.databaseName}.${schema.schemaName}.${table.tableName}(${table.columns.map(c => c.columnName).join(', ')})`);
            }
        }
    }
    return relations.sort();
}

function change(type: dashql.buffers.catalog.CatalogChangeType, schema: string, relation: string, columns: string[] = []) {
    return new dashql.buffers.catalog.CatalogChangeT(type, '', schema, relation, columns, false);
}

describe('catalog changes of executed statements', () => {
    const CREATE = dashql.buffers.catalog.CatalogChangeType.CREATE_RELATION;
    const DROP = dashql.buffers.catalog.CatalogChangeType.DROP_RELATION;

    it('qualify with the connection defaults, patch the relation descriptor and record the changes SQL', () => {
        const database = state();
        replaceAttachedDatabaseCatalogFromStorage(database, 'CREATE TABLE "hyper"."public"."stored"(id int);', null);
        const next = reduceAttachedDatabaseState(database, {
            type: APPLY_CATALOG_CHANGES,
            value: [change(DROP, '', 'stored'), change(CREATE, 'other', 'created', ['a', 'b'])],
        }, {} as any, new TestLogger());
        expect(relationsOf(next)).toEqual(['hyper.other.created(a, b)']);
        expect(next.catalogChangesSql).toContain('DROP TABLE "hyper"."public"."stored";');
        expect(next.catalogChangesSql).toContain('CREATE TABLE "hyper"."other"."created"');
        // The source script stays as the database reported it
        expect(next.catalogRelationScript.toString()).toContain('stored');
    });

    it('survive a reload of the relation script from storage', () => {
        const database = state();
        replaceAttachedDatabaseCatalogFromStorage(database, 'CREATE TABLE "hyper"."public"."stored"(id int);', null);
        const next = reduceAttachedDatabaseState(database, {
            type: APPLY_CATALOG_CHANGES,
            value: [change(CREATE, '', 'created', ['a'])],
        }, {} as any, new TestLogger());
        replaceAttachedDatabaseCatalogFromStorage(next, 'CREATE TABLE "hyper"."public"."edited"(id int);', null);
        expect(relationsOf(next)).toEqual(['hyper.public.created(a)', 'hyper.public.edited(id)']);
    });

    it('are cleared by a catalog refresh', () => {
        let database = state();
        database = reduceAttachedDatabaseState(database, {
            type: APPLY_CATALOG_CHANGES,
            value: [change(CREATE, '', 'created', ['a'])],
        }, {} as any, new TestLogger());
        expect(database.catalogChangesSql).not.toBe('');
        database = reduceAttachedDatabaseState(database, {
            type: UPDATE_CATALOG,
            value: [1, {
                taskId: 1,
                taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
                status: CatalogUpdateTaskStatus.STARTED,
                cancellation: new AbortController(),
                queries: [],
                error: null,
                startedAt: new Date(),
                finishedAt: null,
                lastUpdateAt: new Date(),
            }],
        }, {} as any, new TestLogger());
        database = reduceAttachedDatabaseState(database, { type: CATALOG_UPDATE_SUCCEEDED, value: [1] }, {} as any, new TestLogger());
        expect(database.catalogChangesSql).toBe('');
    });
});
