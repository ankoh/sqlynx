import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as dashql from '@ankoh/dashql-core';
import {
    APPLY_CATALOG_CHANGES,
    CATALOG_UPDATE_SUCCEEDED,
    createConnectionState,
    DELETE_CONNECTION,
    RESET_CONNECTION,
    reduceConnectionState,
    UPDATE_CATALOG,
    type ConnectionState,
} from './connection_state.js';
import { TestLogger } from '../../platform/logger/test_logger.js';
import { CONNECTOR_INFOS, ConnectorType } from './connector_info.js';
import { createConnectionStateDetails } from './connection_state_details.js';
import { publishCatalogBatch, publishCatalogBatchSync } from './catalog_batch.js';
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

function state(): ConnectionState {
    return { ...createConnectionState(dql, CONNECTOR_INFOS[ConnectorType.HYPER], createConnectionStateDetails(ConnectorType.HYPER)), connectionId: 'test' };
}

/// Publish the catalog scripts of a connection
function publishCatalog(database: ConnectionState, relations: string, functions: string | null = null): void {
    publishCatalogBatchSync(dql, database.catalog, [
        { script: database.catalogRelationScript, text: relations, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK },
        ...(functions == null ? [] : [{ script: database.catalogFunctionScript, text: functions, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK }]),
    ]);
}

describe('attached database descriptor catalogs', () => {
    it.each([RESET_CONNECTION, DELETE_CONNECTION] as const)('promptly aborts pending publishers before clearing running tasks on %s', async type => {
        const database = state();
        const controllers = [new AbortController(), new AbortController()];
        const aborts = controllers.map(controller => vi.spyOn(controller, 'abort'));
        const cleanup = vi.spyOn(database.catalog, type === RESET_CONNECTION ? 'clear' : 'destroy');
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
        const next = reduceConnectionState(database, { type, value: null }, {} as any);
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

    it('drops both descriptors before destroying their text-only source scripts', () => {
        const database = state();
        publishCatalog(database, 'CREATE TABLE stored(id int);', 'CREATE FUNCTION stored_fn() RETURNS bigint;');
        const drops = vi.spyOn(database.catalog, 'dropDescriptor');
        const destroyRelations = vi.spyOn(database.catalogRelationScript, 'destroy');
        const destroyFunctions = vi.spyOn(database.catalogFunctionScript, 'destroy');
        reduceConnectionState(database, { type: DELETE_CONNECTION, value: null }, {} as any);
        expect(drops.mock.calls).toEqual([
            [database.catalogRelationScript.catalog_entry_id],
            [database.catalogFunctionScript.catalog_entry_id],
        ]);
        expect(destroyRelations).toHaveBeenCalledTimes(1);
        expect(destroyFunctions).toHaveBeenCalledTimes(1);
    });
});

/// The relations of the relation descriptor as `db.schema.table(a, b)`
function relationsOf(database: ConnectionState): string[] {
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
        publishCatalog(database, 'CREATE TABLE "hyper"."public"."stored"(id int);');
        const next = reduceConnectionState(database, {
            type: APPLY_CATALOG_CHANGES,
            value: [change(DROP, '', 'stored'), change(CREATE, 'other', 'created', ['a', 'b'])],
        }, new TestLogger());
        expect(relationsOf(next)).toEqual(['hyper.other.created(a, b)']);
        expect(next.catalogChangesSql).toContain('DROP TABLE "hyper"."public"."stored";');
        expect(next.catalogChangesSql).toContain('CREATE TABLE "hyper"."other"."created"');
        // The source script stays as the database reported it
        expect(next.catalogRelationScript.toString()).toContain('stored');
    });

    it('are cleared by a catalog refresh', () => {
        let database = state();
        database = reduceConnectionState(database, {
            type: APPLY_CATALOG_CHANGES,
            value: [change(CREATE, '', 'created', ['a'])],
        }, new TestLogger());
        expect(database.catalogChangesSql).not.toBe('');
        database = reduceConnectionState(database, {
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
        }, new TestLogger());
        database = reduceConnectionState(database, { type: CATALOG_UPDATE_SUCCEEDED, value: [1] }, new TestLogger());
        expect(database.catalogChangesSql).toBe('');
    });
});
