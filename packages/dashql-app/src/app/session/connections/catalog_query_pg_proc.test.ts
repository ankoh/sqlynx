import * as arrow from 'apache-arrow';
import * as flatbuffers from 'flatbuffers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as dashql from '@ankoh/dashql-core';
import { setupWebHyperDB } from '../../../platform/hyperdb/hyperdb_provider_web.js';
import { TestLogger } from '../../../platform/logger/test_logger.js';
import { queryPgProc, generateCatalogSQLFromPgProc } from './catalog_query_pg_proc.js';
import type { QueryExecutor } from './query_executor.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

describe('PostgreSQL function query integration', () => {
    let dql: dashql.DashQL;
    beforeAll(async () => {
        dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
    });
    afterEach(() => dql.resetUnsafe());

    it('imports the live Hyper WASM function catalog through a batch descriptor', async () => {
        const database = await setupWebHyperDB('catalog_pg_proc_test', new TestLogger());
        const connection = await database.connect();
        try {
            const executor: QueryExecutor = (_id, args) => [1, connection.query(args.query)];
            const result = await queryPgProc('database', vi.fn(), 1, executor);
            expect(result).not.toBeNull();
            expect(result!.numRows).toBeGreaterThan(0);
            expect(result!.getChild('argument_types')!.type.typeId).toBe(arrow.Type.List);
            const sql = generateCatalogSQLFromPgProc(result!, '');
            const output = dql.processBatch({ scripts: [{ id: 'functions', text: sql, outputs: ['catalogDescriptor'] }] }).scripts[0];
            expect(output.failure).toBeUndefined();
            expect(output.diagnostics).toEqual([]);
            const descriptor = dashql.buffers.catalog.CatalogDescriptor.getRootAsCatalogDescriptor(
                new flatbuffers.ByteBuffer(output.catalogDescriptor!),
            );
            expect(descriptor.functionDeclarationsLength()).toBeGreaterThan(0);
            const power = Array.from({ length: descriptor.functionDeclarationsLength() }, (_, i) => descriptor.functionDeclarations(i)!)
                .find(fn => fn.functionName()?.functionName() === 'power');
            expect(power).toBeDefined();
            // Hyper exposes built-in names, but leaves their signature metadata null.
            expect(power!.paramsLength()).toBe(0);
            expect(power!.returnType()).toBe('any');
            const catalog = dql.createCatalog();
            const id = catalog.allocateEntryId();
            catalog.replaceDescriptor(id, 20, output.catalogDescriptor!);
            expect(catalog.containsEntryId(id)).toBe(true);
            const query = dql.createScript(catalog);
            query.replaceText('SELECT pow');
            query.analyze();
            query.moveCursor('SELECT pow'.length).destroy();
            expect(query.completeAtCursor(50).unpackAndDestroy().candidates
                .map((candidate: dashql.buffers.completion.CompletionCandidateT) => candidate.completionText)).toContain('power()');
        } finally {
            await connection.close();
            await database.terminate();
        }
    });
});
