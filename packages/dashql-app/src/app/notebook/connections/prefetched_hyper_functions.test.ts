import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as dashql from '@ankoh/dashql-core';
import {
    fetchPrefetchedHyperFunctions,
    loadPrefetchedHyperFunctions,
    PREFETCHED_HYPER_FUNCTIONS_SQL,
    qualifyPrefetchedHyperFunctions,
} from './prefetched_hyper_functions.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL;

beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});

afterEach(() => {
    vi.restoreAllMocks();
    dql.resetUnsafe();
});

describe('prefetched Hyper functions', () => {
    it('parses the bundled function catalog', async () => {
        const sql = PREFETCHED_HYPER_FUNCTIONS_SQL;
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        const analyze = vi.spyOn(script, 'analyze');
        const parse = vi.spyOn(script, 'parse');

        const functionCount = loadPrefetchedHyperFunctions(dql, catalog, script, sql);

        expect(functionCount).toBe(350);
        expect(script.toString()).toBe(sql);
        expect(analyze).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        expect(catalog.describeEntries().unpackAndDestroy().entries[0].catalogEntryType)
            .toBe(dashql.buffers.catalog.CatalogEntryType.DESCRIPTOR_POOL);
        expect(sql).toContain('CREATE FUNCTION "hyper"."pg_catalog"."date_add"() RETURNS any;');
        expect(sql).toContain('CREATE AGGREGATE "hyper"."pg_catalog"."count"() RETURNS any;');
        expect(sql).toContain('CREATE FUNCTION "hyper"."tableau"."sqrt"() RETURNS any;');
    });

    it('uses the bundled SQL without fetching a runtime URL', async () => {
        await expect(fetchPrefetchedHyperFunctions()).resolves.toContain(
            'CREATE FUNCTION "hyper"."pg_catalog"."abs"() RETURNS any;',
        );
    });

    it('qualifies functions for the user-facing Hyper database', () => {
        const sql = qualifyPrefetchedHyperFunctions('hyper', new Date('2026-08-30T12:34:56.789Z'));

        expect(sql).toMatch(/^-- DashQL Connection Functions\./);
        expect(sql).toContain('-- Catalog Source: Bundled Hyper function catalog');
        expect(sql).toContain('-- Last Refresh: 2026-08-30T12:34:56.789Z');
        expect(sql).toContain('CREATE FUNCTION "hyper"."pg_catalog"."abs"() RETURNS any;');
        expect(sql).not.toContain('"default"."pg_catalog"');
    });

    it('rejects invalid SQL before replacing the function script', () => {
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        script.replaceText('-- existing functions');

        expect(() => loadPrefetchedHyperFunctions(dql, catalog, script, '<!doctype html><html></html>'))
            .toThrow('contains invalid SQL');
        expect(script.toString()).toBe('-- existing functions');
    });

    it('rejects an empty function descriptor without replacing published functions', () => {
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        loadPrefetchedHyperFunctions(dql, catalog, script, PREFETCHED_HYPER_FUNCTIONS_SQL);
        const snapshot = catalog.createSnapshot();
        expect(() => loadPrefetchedHyperFunctions(dql, catalog, script, '-- no functions'))
            .toThrow('function catalog is empty');
        expect(catalog.createSnapshot()).toBe(snapshot);
        expect(script.toString()).toBe(PREFETCHED_HYPER_FUNCTIONS_SQL);
    });
});
