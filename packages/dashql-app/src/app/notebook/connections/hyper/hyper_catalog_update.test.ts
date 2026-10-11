import * as arrow from 'apache-arrow';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as dashql from '@ankoh/dashql-core';
import { buildHyperCloudCatalogQuery, generateCatalogSQLFromHyperCloud, updateHyperCatalog } from './hyper_catalog_update.js';
import type { QueryExecutor } from '../query_executor.js';
import { CATALOG_QUERY_READ_TIMEOUT_MS } from '../catalog_query_pg_attribute.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL;

beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});

beforeEach(() => {
    dql.resetUnsafe();
});

function pgResult(tableName: string) {
    return arrow.tableFromArrays({
        table_schema: ['public'],
        table_name: [tableName],
        column_name: ['id'],
        ordinal_position: [1],
        data_type: ['int8'],
        is_nullable: ['NO'],
        numeric_precision: [null],
        numeric_scale: [null],
    });
}

function cloudResult(databaseName = 'Cloud Database') {
    return arrow.tableFromArrays({
        database_name: [databaseName, databaseName],
        schema_name: ['sales', 'sales'],
        table_name: ['orders', 'orders'],
        column_name: ['name', 'id'],
        ordinal_position: [1, 0],
        data_type: ['text', 'bigint'],
    });
}

function functionResult() {
    return arrow.tableFromArrays({
        function_schema: ['pg_catalog'],
        function_name: ['wasm_catalog_function'],
        return_type: ['bigint'],
        returns_set: [false],
        function_kind: ['f'],
    }).assign(new arrow.Table({
        argument_types: arrow.vectorFromArray([['integer']], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
        argument_names: arrow.vectorFromArray([[]], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
        argument_modes: arrow.vectorFromArray([[]], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
    }));
}

describe('Hyper catalog query generation', () => {
    it('qualifies Hyper Cloud metadata tables without projecting UUIDs', () => {
        const query = buildHyperCloudCatalogQuery('cloud"catalog');
        const projection = query.slice(query.indexOf('SELECT'), query.indexOf('FROM'));

        expect(query).toContain('FROM "cloud""catalog"."_hyper_catalog"."databases" d');
        expect(query).toContain('s.database_id = d.database_id');
        expect(projection).not.toMatch(/\b(?:account|database|schema|object|column)_id\b/);
        expect(projection).not.toContain('database_name_display');
        expect(projection).toContain('CAST(c.type_descriptor AS TEXT) AS data_type');
    });

    it('uses the attached database name and ordinal positions from Hyper Cloud metadata', () => {
        const sql = generateCatalogSQLFromHyperCloud(cloudResult() as any, 'cloud attachment');

        expect(sql).toContain('CREATE TABLE "cloud attachment"."sales"."orders"');
        expect(sql).not.toContain('CREATE TABLE "Cloud Database"');
        expect(sql.indexOf('"id" INTEGER')).toBeLessThan(sql.indexOf('"name" VARCHAR'));
    });
});

describe('updateHyperCatalog', () => {
    it('queries standard and cloud attachments independently and merges their catalogs', async () => {
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        const functionScript = dql.createScript(catalog);
        const queries: string[] = [];
        const executor = vi.fn<QueryExecutor>((_connectionId, args) => {
            queries.push(args.query);
            const result = args.query.includes('"_hyper_catalog"."databases"')
                ? cloudResult()
                : pgResult('lake_table');
            return [queries.length, Promise.resolve(result)];
        });

        const result = await updateHyperCatalog(
            { info: vi.fn() } as any,
            'connection',
            vi.fn(),
            7,
            [
                { path: 'lakehouse:tenant;default', alias: 'lake db' },
                { path: 'hyper.cloud/catalog', alias: 'cloud' },
            ],
            executor,
            catalog,
            dql,
            script,
            functionScript,
            false,
            new AbortController().signal,
            { processor: async request => dql.processBatch(request) },
        );

        expect(result.failures).toEqual([]);
        expect(queries).toHaveLength(2);
        expect(queries[0]).toContain('FROM "lake db"."pg_catalog".pg_class c');
        expect(queries[1]).toContain('FROM "cloud"."_hyper_catalog"."databases" d');
        expect(executor.mock.calls.every(call => call[1].readTimeoutMs === CATALOG_QUERY_READ_TIMEOUT_MS)).toBe(true);
        expect(script.toString()).toContain('CREATE TABLE "lake db"."public"."lake_table"');
        expect(script.toString()).toContain('CREATE TABLE "cloud"."sales"."orders"');
        expect(script.toString()).not.toContain('CREATE TABLE "Cloud Database"');
        expect(catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(2);
        expect(functionScript.toString()).toContain('CREATE FUNCTION "hyper"."pg_catalog"."abs"() RETURNS any;');
    });

    it('uses the unqualified default database and live function catalog for Hyper WASM', async () => {
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        const functionScript = dql.createScript(catalog);
        let query = '';
        const executor = vi.fn<QueryExecutor>((_connectionId, args) => {
            if (args.query.includes('FROM pg_proc p')) {
                return [2, Promise.resolve(functionResult())];
            }
            query = args.query;
            return [1, Promise.resolve(pgResult('default_table'))];
        });

        await updateHyperCatalog(
            { info: vi.fn() } as any,
            'connection',
            vi.fn(),
            8,
            [],
            executor,
            catalog,
            dql,
            script,
            functionScript,
            true,
            new AbortController().signal,
            { processor: async request => dql.processBatch(request) },
        );

        expect(query).toContain('FROM pg_catalog.pg_class c');
        expect(query).not.toContain('"hyper"."pg_catalog"');
        expect(script.toString()).toContain('-- Catalog Source: HyperDB WASM pg_class');
        expect(script.toString()).toContain('CREATE TABLE "hyper"."public"."default_table"');
        expect(functionScript.toString()).toContain('-- Catalog Source: HyperDB WASM pg_proc');
        expect(functionScript.toString()).toContain(
            'CREATE FUNCTION "hyper"."pg_catalog"."wasm_catalog_function"("arg1" integer) RETURNS bigint;',
        );
        expect(functionScript.toString()).not.toContain('CREATE FUNCTION "hyper"."pg_catalog"."abs"');
        expect(executor.mock.calls[1]?.[1].readTimeoutMs).toBe(CATALOG_QUERY_READ_TIMEOUT_MS);
    });

    it('retains a failed database section while committing a successful database', async () => {
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        const functionScript = dql.createScript(catalog);
        const attachments = [
            { path: 'lakehouse:first', alias: 'first' },
            { path: 'lakehouse:second', alias: 'second' },
        ];
        let revision = 1;
        let failSecond = false;
        const executor = vi.fn<QueryExecutor>((_connectionId, args) => {
            if (failSecond && args.query.includes('"second"."pg_catalog"')) {
                return [2, Promise.reject(new Error('second unavailable'))];
            }
            const alias = args.query.includes('"first"."pg_catalog"') ? 'first' : 'second';
            return [1, Promise.resolve(pgResult(`${alias}_v${revision}`))];
        });

        await updateHyperCatalog(
            { info: vi.fn() } as any,
            'connection',
            vi.fn(),
            9,
            attachments,
            executor,
            catalog,
            dql,
            script,
            functionScript,
            false,
            new AbortController().signal,
            { processor: async request => dql.processBatch(request) },
        );
        revision = 2;
        failSecond = true;

        const result = await updateHyperCatalog(
            { info: vi.fn() } as any,
            'connection',
            vi.fn(),
            10,
            attachments,
            executor,
            catalog,
            dql,
            script,
            functionScript,
            false,
            new AbortController().signal,
            { processor: async request => dql.processBatch(request) },
        );

        expect(result.updatedDatabases).toEqual(['first']);
        expect(result.failures.map(failure => failure.database)).toEqual(['second']);
        expect(script.toString()).toContain('"first"."public"."first_v2"');
        expect(script.toString()).not.toContain('"first"."public"."first_v1"');
        expect(script.toString()).toContain('"second"."public"."second_v1"');
        expect(script.toString()).not.toContain('"second"."public"."second_v2"');
    });

    it('leaves the script untouched when every attachment fails validation', async () => {
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        const functionScript = dql.createScript(catalog);
        script.replaceText('legacy catalog text');
        const executor = vi.fn<QueryExecutor>();

        await expect(updateHyperCatalog(
            { info: vi.fn() } as any,
            'connection',
            vi.fn(),
            11,
            [{ path: 'lakehouse:first', alias: '' }],
            executor,
            catalog,
            dql,
            script,
            functionScript,
            false,
            new AbortController().signal,
        )).rejects.toThrow('Failed to refresh every attached database');

        expect(executor).not.toHaveBeenCalled();
        expect(script.toString()).toBe('legacy catalog text');
    });

    it.each(['processing', 'publication', 'later publication', 'aborted'])('retains earlier publications and unchanged pools after %s failure', async failure => {
        const catalog = dql.createCatalog();
        const relationScript = dql.createScript(catalog);
        const functionScript = dql.createScript(catalog);
        let revision = 1;
        const executor = vi.fn<QueryExecutor>(() => [1, Promise.resolve(pgResult(`table_v${revision}`))]);
        const refresh = (signal: AbortSignal, processor = async (request: dashql.BatchRequest) => dql.processBatch(request)) => updateHyperCatalog(
            { info: vi.fn() } as any, 'connection', vi.fn(), revision, [], executor,
            catalog, dql, relationScript, functionScript, false, signal, { processor },
        );
        await refresh(new AbortController().signal);
        const previousRelations = relationScript.toString();
        const previousFunctions = functionScript.toString();
        const snapshot = catalog.createSnapshot();
        const version = snapshot.read().catalogReader.catalogVersion();
        revision = 2;
        const abort = new AbortController();
        const processor = async (request: dashql.BatchRequest) => {
            const result = dql.processBatch(request);
            if (failure === 'processing') result.scripts[1].failure = 'function processing failed';
            if (failure === 'aborted') abort.abort();
            return result;
        };
        const replaceDescriptor = catalog.replaceDescriptor.bind(catalog);
        const publication = failure === 'publication' || failure === 'later publication'
            ? vi.spyOn(catalog, 'replaceDescriptor').mockImplementation((id, rank, descriptor) => {
                if (failure === 'publication' || id === functionScript.catalog_entry_id) throw new Error('descriptor import failed');
                replaceDescriptor(id, rank, descriptor);
            })
            : null;
        try {
            await expect(refresh(abort.signal, processor)).rejects.toThrow();
            if (failure === 'later publication') expect(relationScript.toString()).toContain('table_v2');
            else expect(relationScript.toString()).toBe(previousRelations);
            expect(functionScript.toString()).toBe(previousFunctions);
            const currentSnapshot = catalog.createSnapshot();
            if (failure === 'later publication') {
                expect(publication).toHaveBeenCalledTimes(2);
                expect(currentSnapshot).not.toBe(snapshot);
                expect(currentSnapshot.read().catalogReader.catalogVersion()).toBe(version + 1n);
            } else {
                expect(currentSnapshot).toBe(snapshot);
                expect(currentSnapshot.read().catalogReader.catalogVersion()).toBe(version);
            }
            expect(currentSnapshot.read().catalogReader.tablesLength()).toBe(1);
        } finally {
            publication?.mockRestore();
        }
    });
});
