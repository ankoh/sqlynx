import * as arrow from 'apache-arrow';
import * as flatbuffers from 'flatbuffers';
import { describe, expect, it, vi } from 'vitest';
import * as buffers from '@ankoh/dashql-core/buffers';
import type { BatchRequest } from '@ankoh/dashql-core';
import type { QueryExecutor } from './query_executor.js';
import { updateInformationSchemaCatalog } from './catalog_query_information_schema.js';

describe('information_schema batch refresh', () => {
    it('queries all catalogs when no catalog is configured', async () => {
        let query = '';
        const executor = vi.fn<QueryExecutor>((_connectionId, args) => {
            query = args.query;
            return [1, Promise.resolve(arrow.tableFromArrays({}))];
        });
        await expect(updateInformationSchemaCatalog('session', vi.fn(), 7, '', [], executor,
            {} as any, {} as any, {} as any, {} as any)).rejects.toThrow('information_schema returned no catalog relations');
        expect(query).not.toContain("WHERE table_catalog = ''");
    });

    it('rejects an empty metadata result instead of reporting a successful refresh', async () => {
        const executor = vi.fn<QueryExecutor>(() => [1, Promise.resolve(arrow.tableFromArrays({}))]);
        await expect(updateInformationSchemaCatalog('session', vi.fn(), 7, 'catalog', [], executor,
            {} as any, {} as any, {} as any, {} as any)).rejects.toThrow('information_schema returned no catalog relations');
    });

    it.each(['success', 'worker failure', 'aborted'])('publishes only a successfully prepared, current response: %s', async outcome => {
        const catalog = { replaceDescriptor: vi.fn() };
        const source = { catalog_entry_id: 7, replaceText: vi.fn(), toString: () => '' };
        const abort = new AbortController();
        const executor = vi.fn<QueryExecutor>(() => [1, Promise.resolve(arrow.tableFromArrays({
            table_catalog: ['db'], table_schema: ['public'], table_name: ['items'], column_name: ['id'], ordinal_position: [1], data_type: ['bigint'],
        }))]);
        const builder = new flatbuffers.Builder();
        builder.finish(new buffers.catalog.CatalogDescriptorT().pack(builder));
        const processor = vi.fn(async (request: BatchRequest) => {
            if (outcome === 'worker failure') throw new Error('worker failed');
            if (outcome === 'aborted') abort.abort();
            return { scripts: request.scripts.map(script => ({ id: script.id, diagnostics: [], catalogDescriptor: builder.asUint8Array() })) };
        });
        const refresh = updateInformationSchemaCatalog('connection', vi.fn(), 1, 'db', [], executor,
            catalog as any, {} as any, source as any, {} as any, { processor, abortSignal: abort.signal });
        if (outcome === 'success') {
            await refresh;
            expect(catalog.replaceDescriptor).toHaveBeenCalledExactlyOnceWith(source.catalog_entry_id, expect.any(Number), expect.any(Uint8Array));
            expect(source.replaceText).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE "db"."public"."items"'));
        } else {
            await expect(refresh).rejects.toThrow();
            expect(catalog.replaceDescriptor).not.toHaveBeenCalled();
            expect(source.replaceText).not.toHaveBeenCalled();
        }
        expect(executor.mock.calls[0][1].abortSignal).toBe(abort.signal);
    });
});
