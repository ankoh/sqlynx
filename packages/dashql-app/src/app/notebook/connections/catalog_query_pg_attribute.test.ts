import * as arrow from 'apache-arrow';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as dashql from '@ankoh/dashql-core';
import * as flatbuffers from 'flatbuffers';
import * as buffers from '@ankoh/dashql-core/buffers';
import type { BatchRequest } from '@ankoh/dashql-core';

import { CATALOG_QUERY_READ_TIMEOUT_MS, queryPgAttribute, updatePgCatalog, updatePgSchemaScript } from './catalog_query_pg_attribute.js';
import type { QueryExecutor } from './query_executor.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

describe('updatePgSchemaScript', () => {
    it('rejects an empty relation result instead of reporting a successful refresh', async () => {
        const executor = vi.fn<QueryExecutor>(() => [1, Promise.resolve(arrow.tableFromArrays({}))]);

        await expect(updatePgSchemaScript(
            { info: vi.fn() } as any,
            'notebook',
            vi.fn(),
            7,
            '',
            [],
            executor,
            {} as any,
            {} as any,
        )).rejects.toThrow('pg_attribute returned no catalog relations');
    });
});

describe('real-core empty PostgreSQL function refresh', () => {
    let dql: dashql.DashQL;
    beforeAll(async () => {
        dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
    });
    afterEach(() => dql.resetUnsafe());

    it('publishes an empty function descriptor to clear stale functions and logs the actual count', async () => {
        const catalog = dql.createCatalog();
        const relations = dql.createScript(catalog);
        const functions = dql.createScript(catalog);
        let emptyFunctions = false;
        const executor = vi.fn<QueryExecutor>((_id, args) => [1, Promise.resolve(args.query.includes('FROM pg_proc p')
            ? emptyFunctions ? arrow.tableFromArrays({}) : arrow.tableFromArrays({
                function_schema: ['public'], function_name: ['old_fn'],
                returns_set: [false], return_type: ['integer'], function_kind: ['f'],
            }).assign(new arrow.Table({
                argument_types: arrow.vectorFromArray([['integer', 'integer']], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
                argument_names: arrow.vectorFromArray([[]], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
                argument_modes: arrow.vectorFromArray([[]], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
            }))
            : arrow.tableFromArrays({ table_schema: ['public'], table_name: ['items'], column_name: ['id'], ordinal_position: [1], data_type: ['bigint'] }))]);
        const logger = { info: vi.fn(), warn: vi.fn() };
        const refresh = () => updatePgCatalog(logger as any, 'connection', vi.fn(), 1, 'db', [], executor,
            catalog, dql, relations, functions, { processor: async request => dql.processBatch(request) });
        await refresh();
        expect(functions.toString()).toContain('"old_fn"');
        emptyFunctions = true;
        await refresh();
        expect(functions.toString()).not.toContain('"old_fn"');
        expect(catalog.containsEntryId(functions.catalog_entry_id)).toBe(true);
        expect(logger.info).toHaveBeenLastCalledWith('Collected PostgreSQL catalog',
            { updateId: '1', tables: '1', functions: '0' }, 'catalog_pg');
        const query = dql.createScript(catalog);
        query.replaceText('SELECT old_f');
        query.analyze();
        query.moveCursor('SELECT old_f'.length).destroy();
        expect(query.completeAtCursor(50).unpackAndDestroy().candidates.map((candidate: dashql.buffers.completion.CompletionCandidateT) => candidate.completionText))
            .not.toContain('old_fn()');
    });
});

describe('queryPgAttribute', () => {
    it('safely qualifies an attached database alias', async () => {
        let query = '';
        const executor = vi.fn<QueryExecutor>((_connectionId, args) => {
            query = args.query;
            return [1, Promise.resolve(arrow.tableFromArrays({}))];
        });

        await queryPgAttribute('notebook', vi.fn(), 7, 'catalog', [], executor, 'db"name');

        expect(query).toContain('FROM "db""name"."pg_catalog".pg_class c');
        expect(query).toContain('JOIN "db""name"."pg_catalog".pg_attribute a');
        expect(executor.mock.calls[0][1].readTimeoutMs).toBe(CATALOG_QUERY_READ_TIMEOUT_MS);
    });
});

describe('updatePgCatalog', () => {
    it('prepares relation and function descriptors in one batch and publishes them sequentially', async () => {
        const catalog = { replaceDescriptor: vi.fn() };
        const relations = { catalog_entry_id: 1, replaceText: vi.fn(), toString: () => '' };
        const functions = { catalog_entry_id: 2, replaceText: vi.fn(), toString: () => '' };
        const builder = new flatbuffers.Builder();
        builder.finish(new buffers.catalog.CatalogDescriptorT().pack(builder));
        const descriptor = builder.asUint8Array();
        const processor = vi.fn(async (request: BatchRequest) => ({ scripts: request.scripts.map(script => ({
            id: script.id, diagnostics: [], catalogDescriptor: descriptor,
        })) }));
        const executor = vi.fn<QueryExecutor>((_id, args) => [1, Promise.resolve(args.query.includes('FROM pg_proc p')
            ? arrow.tableFromArrays({
                function_schema: ['public'], function_name: ['test_fn'],
                return_type: ['bigint'], returns_set: [false], function_kind: ['f'],
            }).assign(new arrow.Table({
                argument_types: arrow.vectorFromArray([[]], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
                argument_names: arrow.vectorFromArray([[]], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
                argument_modes: arrow.vectorFromArray([[]], new arrow.List(new arrow.Field('item', new arrow.Utf8(), true))),
            }))
            : arrow.tableFromArrays({ table_schema: ['public'], table_name: ['test_table'], column_name: ['id'], ordinal_position: [1], data_type: ['bigint'] }))]);
        await updatePgCatalog({ info: vi.fn() } as any, 'connection', vi.fn(), 1, 'db', [], executor,
            catalog as any, {} as any, relations as any, functions as any, { processor });
        expect(processor).toHaveBeenCalledTimes(1);
        expect(processor.mock.calls[0][0].scripts).toHaveLength(2);
        expect(catalog.replaceDescriptor.mock.calls).toEqual([
            [relations.catalog_entry_id, expect.any(Number), descriptor],
            [functions.catalog_entry_id, expect.any(Number), descriptor],
        ]);
        expect(relations.replaceText).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE "db"."public"."test_table"'));
        expect(functions.replaceText).toHaveBeenCalledWith(expect.stringContaining('CREATE FUNCTION "db"."public"."test_fn"'));
    });

    it('does not publish relations when the parallel function fetch fails', async () => {
        const catalog = { replaceDescriptor: vi.fn() };
        const relations = { replaceText: vi.fn() };
        const functions = { replaceText: vi.fn() };
        const executor = vi.fn<QueryExecutor>((_id, args) => [1, args.query.includes('FROM pg_proc p')
            ? Promise.reject(new Error('functions unavailable'))
            : Promise.resolve(arrow.tableFromArrays({ table_schema: ['public'], table_name: ['test_table'], column_name: ['id'], ordinal_position: [1], data_type: ['bigint'] }))]);
        const processor = vi.fn();
        await expect(updatePgCatalog({ info: vi.fn() } as any, 'connection', vi.fn(), 1, 'db', [], executor,
            catalog as any, {} as any, relations as any, functions as any, { processor })).rejects.toThrow('functions unavailable');
        expect(processor).not.toHaveBeenCalled();
        expect(catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(relations.replaceText).not.toHaveBeenCalled();
        expect(functions.replaceText).not.toHaveBeenCalled();
    });
});
