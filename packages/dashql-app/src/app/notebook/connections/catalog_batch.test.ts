import * as flatbuffers from 'flatbuffers';
import { describe, expect, it, vi } from 'vitest';
import * as buffers from '@ankoh/dashql-core/buffers';
import type { DashQLCatalog, DashQLScript } from '@ankoh/dashql-core';
import type { BatchRequest, BatchResult } from '@ankoh/dashql-core';
import { beginCatalogBatch, disposeCatalogBatchWorker, initializeCatalogBatchWorker, invalidateCatalogBatch, publishCatalogBatch, publishCatalogBatchSync } from './catalog_batch.js';
import { DashQL } from '@ankoh/dashql-core';

function fixture() {
    const builder = new flatbuffers.Builder();
    builder.finish(new buffers.catalog.CatalogDescriptorT().pack(builder));
    const descriptor = builder.asUint8Array();
    const processor = vi.fn(async (request: BatchRequest): Promise<BatchResult> => ({
        scripts: request.scripts.map(script => ({ id: script.id, diagnostics: [], catalogDescriptor: descriptor })),
    }));
    const source = (id: number) => {
        let text = `old SQL ${id}`;
        return {
            catalog_entry_id: id,
            replaceText: vi.fn((next: string) => { text = next; }),
            toString: () => text,
            analyze: vi.fn(),
            parse: vi.fn(),
        } as unknown as DashQLScript;
    };
    const relation = source(1);
    const functions = source(2);
    const entries = [
        { script: relation, text: 'next relations', rank: 10 },
        { script: functions, text: 'next functions', rank: 20 },
    ];
    const pools = new Map<number, Uint8Array>([[1, new Uint8Array([1])], [2, new Uint8Array([2])]]);
    const catalog = { replaceDescriptor: vi.fn((id: number, _rank: number, bytes: Uint8Array) => { pools.set(id, bytes); }) } as unknown as DashQLCatalog;
    const core = { processBatch: vi.fn() } as unknown as DashQL;
    return { core, catalog, entries, relation, functions, processor, descriptor, pools };
}

describe('catalog batch publication', () => {
    it('fails without an explicitly initialized worker instead of creating one lazily', async () => {
        const f = fixture();
        const worker = vi.spyOn(globalThis, 'Worker');
        try {
            await expect(publishCatalogBatch(f.core, f.catalog, f.entries)).rejects.toThrow('enable setupBatchWorker');
            expect(worker).not.toHaveBeenCalled();
            expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
            expect(f.relation.replaceText).not.toHaveBeenCalled();
        } finally {
            worker.mockRestore();
        }
    });

    it('rejects delayed metadata after provider disposal before creating a worker or changing sources', async () => {
        const f = fixture();
        const validate = beginCatalogBatch(f.catalog);
        const worker = vi.spyOn(globalThis, 'Worker');
        try {
            disposeCatalogBatchWorker(f.core);
            await expect(publishCatalogBatch(f.core, f.catalog, f.entries, {}, validate))
                .rejects.toThrow('enable setupBatchWorker');
            expect(worker).not.toHaveBeenCalled();
            expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
            expect(f.relation.replaceText).not.toHaveBeenCalled();
        } finally {
            worker.mockRestore();
        }
    });

    it('settles an outstanding batch when its provider is disposed', async () => {
        const f = fixture();
        f.processor.mockImplementation(() => new Promise(() => {}));
        const publication = publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor });
        disposeCatalogBatchWorker(f.core);
        await expect(publication).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(f.relation.replaceText).not.toHaveBeenCalled();
    });

    it('does not commit a resolved result when disposal precedes its continuation', async () => {
        const f = fixture();
        const publication = publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor });
        disposeCatalogBatchWorker(f.core);
        await expect(publication).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(f.relation.replaceText).not.toHaveBeenCalled();
    });

    it('publishes through the default worker and rejects use after provider disposal', async () => {
        // The browser harness shares its native Core. Give disposal a test-local lifecycle identity.
        const core: DashQL = Object.create(await DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED }));
        const catalog = core.createCatalog();
        const script = core.createScript(catalog);
        const entries = [{ script, text: 'create table worker_items(id int)', rank: 10 }];
        const NativeWorker = globalThis.Worker;
        const worker = vi.spyOn(globalThis, 'Worker').mockImplementation(function (url, options) {
            return new NativeWorker(url, options);
        });
        try {
            await initializeCatalogBatchWorker(core);
            await initializeCatalogBatchWorker(core);
            expect(worker).toHaveBeenCalledTimes(1);
            expect(await publishCatalogBatch(core, catalog, entries)).toEqual([{ tables: 1, functions: 0 }]);
            expect(worker).toHaveBeenCalledTimes(1);
            expect(script.toString()).toBe(entries[0].text);
            expect(catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(1);
            disposeCatalogBatchWorker(core);
            await expect(publishCatalogBatch(core, catalog, entries)).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            disposeCatalogBatchWorker(core);
            script.destroy();
            catalog.destroy();
            worker.mockRestore();
        }
    });

    it('prepares descriptors and publishes each identity immediately after writing its persistence SQL', async () => {
        const f = fixture();
        const replace = vi.mocked(f.catalog.replaceDescriptor).getMockImplementation()!;
        vi.mocked(f.catalog.replaceDescriptor).mockImplementation((id, rank, bytes) => {
            expect(f.relation.toString()).toBe('next relations');
            if (id === 1) {
                expect(f.functions.replaceText).not.toHaveBeenCalled();
                expect(f.functions.toString()).toBe('old SQL 2');
            } else {
                expect(f.functions.toString()).toBe('next functions');
                expect(f.pools.get(1)).toBe(f.descriptor);
            }
            replace(id, rank, bytes);
        });
        expect(await publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor }))
            .toEqual([{ tables: 0, functions: 0 }, { tables: 0, functions: 0 }]);
        expect(f.processor).toHaveBeenCalledWith({ scripts: [
            { id: '1', text: 'next relations', outputs: ['catalogDescriptor'] },
            { id: '2', text: 'next functions', outputs: ['catalogDescriptor'] },
        ] });
        expect(f.catalog.replaceDescriptor).toHaveBeenCalledTimes(2);
        expect(f.catalog.replaceDescriptor).toHaveBeenNthCalledWith(1, 1, 10, f.descriptor);
        expect(f.catalog.replaceDescriptor).toHaveBeenNthCalledWith(2, 2, 20, f.descriptor);
        expect(f.pools.get(1)).toBe(f.descriptor);
        expect(f.pools.get(2)).toBe(f.descriptor);
        expect(f.relation.toString()).toBe('next relations');
        expect(f.functions.toString()).toBe('next functions');
        expect(f.relation.analyze).not.toHaveBeenCalled();
        expect(f.functions.parse).not.toHaveBeenCalled();
        expect(f.core.processBatch).not.toHaveBeenCalled();
    });

    it.each(['worker failure', 'diagnostic', 'missing descriptor', 'empty descriptor', 'script failure', 'wrong identity', 'duplicate identity', 'wrong script count', 'missing functions'])
        ('rejects %s before changing any source or pool', async failure => {
            const f = fixture();
            if (failure === 'worker failure') f.processor.mockRejectedValue(new Error('worker failed'));
            else {
                const result = await f.processor({ scripts: [
                    { id: '1', text: '', outputs: [] }, { id: '2', text: '', outputs: [] },
                ] });
                if (failure === 'diagnostic') result.scripts[1].diagnostics.push({ stage: 'parse', severity: 'error', offset: 0, length: 1, message: 'invalid' });
                if (failure === 'missing descriptor') delete result.scripts[1].catalogDescriptor;
                if (failure === 'empty descriptor') result.scripts[1].catalogDescriptor = new Uint8Array();
                if (failure === 'script failure') result.scripts[1].failure = 'analysis failed';
                if (failure === 'wrong identity') result.scripts[1].id = 'other';
                if (failure === 'duplicate identity') result.scripts[1].id = '1';
                if (failure === 'wrong script count') result.scripts.pop();
                f.processor.mockResolvedValue(result);
            }
            const entries = f.entries.map((entry, i) => ({ ...entry, requireFunctions: failure === 'missing functions' && i === 1 }));
            await expect(publishCatalogBatch(f.core, f.catalog, entries, { processor: f.processor })).rejects.toThrow();
            expect(f.relation.toString()).toBe('old SQL 1');
            expect(f.functions.toString()).toBe('old SQL 2');
            expect(f.relation.replaceText).not.toHaveBeenCalled();
            expect(f.functions.replaceText).not.toHaveBeenCalled();
            expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
            expect(f.pools.get(1)).toEqual(new Uint8Array([1]));
            expect(f.pools.get(2)).toEqual(new Uint8Array([2]));
            expect(f.core.processBatch).not.toHaveBeenCalled();
        });

    it.each(['first', 'second'])('rolls back only the failing %s source write and retains earlier publication', async position => {
        const f = fixture();
        const script = position === 'first' ? f.relation : f.functions;
        vi.mocked(script.replaceText).mockImplementationOnce(() => { throw new Error('source allocation failed'); });
        await expect(publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor })).rejects.toThrow('source allocation failed');
        expect(f.catalog.replaceDescriptor).toHaveBeenCalledTimes(position === 'first' ? 0 : 1);
        expect(script.replaceText).toHaveBeenNthCalledWith(1, position === 'first' ? 'next relations' : 'next functions');
        expect(script.replaceText).toHaveBeenNthCalledWith(2, position === 'first' ? 'old SQL 1' : 'old SQL 2');
        expect(f.relation.toString()).toBe(position === 'first' ? 'old SQL 1' : 'next relations');
        expect(f.functions.toString()).toBe('old SQL 2');
        expect(f.pools.get(1)).toEqual(position === 'first' ? new Uint8Array([1]) : f.descriptor);
        expect(f.pools.get(2)).toEqual(new Uint8Array([2]));
        if (position === 'first') expect(f.functions.replaceText).not.toHaveBeenCalled();
        else {
            expect(f.catalog.replaceDescriptor).toHaveBeenCalledExactlyOnceWith(1, 10, f.descriptor);
            expect(f.relation.replaceText).toHaveBeenCalledExactlyOnceWith('next relations');
        }
    });

    it.each(['first', 'second'])('restores only the %s source that mutated before throwing', async position => {
        const f = fixture();
        const script = position === 'first' ? f.relation : f.functions;
        const replace = script.replaceText;
        const implementation = vi.mocked(replace).getMockImplementation()!;
        vi.mocked(replace).mockImplementationOnce(text => {
            implementation(text);
            throw new Error('source write failed after mutation');
        });
        await expect(publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor }))
            .rejects.toThrow('source write failed after mutation');
        expect(f.catalog.replaceDescriptor).toHaveBeenCalledTimes(position === 'first' ? 0 : 1);
        expect(f.relation.toString()).toBe(position === 'first' ? 'old SQL 1' : 'next relations');
        expect(f.functions.toString()).toBe('old SQL 2');
        expect(script.replaceText).toHaveBeenCalledTimes(2);
        expect(script.replaceText).toHaveBeenLastCalledWith(position === 'first' ? 'old SQL 1' : 'old SQL 2');
        expect(f.pools.get(1)).toEqual(position === 'first' ? new Uint8Array([1]) : f.descriptor);
        expect(f.pools.get(2)).toEqual(new Uint8Array([2]));
        if (position === 'first') expect(f.functions.replaceText).not.toHaveBeenCalled();
        else expect(f.relation.replaceText).toHaveBeenCalledExactlyOnceWith('next relations');
    });

    it.each(['first', 'second'])('rolls back only the %s source on import failure and retains earlier pools', async position => {
        const f = fixture();
        const replace = vi.mocked(f.catalog.replaceDescriptor).getMockImplementation()!;
        vi.mocked(f.catalog.replaceDescriptor).mockImplementation((id, rank, bytes) => {
            expect(id === 1 ? f.relation.toString() : f.functions.toString()).toBe(id === 1 ? 'next relations' : 'next functions');
            if (id === (position === 'first' ? 1 : 2)) throw new Error('import failed');
            replace(id, rank, bytes);
        });
        await expect(publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor }))
            .rejects.toThrow('import failed');
        expect(f.catalog.replaceDescriptor).toHaveBeenCalledTimes(position === 'first' ? 1 : 2);
        expect(f.catalog.replaceDescriptor).toHaveBeenNthCalledWith(1, 1, 10, f.descriptor);
        expect(f.relation.toString()).toBe(position === 'first' ? 'old SQL 1' : 'next relations');
        expect(f.functions.toString()).toBe('old SQL 2');
        expect(f.pools.get(1)).toEqual(position === 'first' ? new Uint8Array([1]) : f.descriptor);
        expect(f.pools.get(2)).toEqual(new Uint8Array([2]));
        const script = position === 'first' ? f.relation : f.functions;
        expect(script.replaceText).toHaveBeenCalledTimes(2);
        expect(script.replaceText).toHaveBeenNthCalledWith(1, position === 'first' ? 'next relations' : 'next functions');
        expect(script.replaceText).toHaveBeenNthCalledWith(2, position === 'first' ? 'old SQL 1' : 'old SQL 2');
        if (position === 'first') expect(f.functions.replaceText).not.toHaveBeenCalled();
        else {
            expect(f.catalog.replaceDescriptor).toHaveBeenNthCalledWith(2, 2, 20, f.descriptor);
            expect(f.relation.replaceText).toHaveBeenCalledExactlyOnceWith('next relations');
        }
    });

    it('stops waiting for a nonresolving worker on abort and removes the event listener', async () => {
        const f = fixture();
        const abort = new AbortController();
        const add = vi.spyOn(abort.signal, 'addEventListener');
        const remove = vi.spyOn(abort.signal, 'removeEventListener');
        f.processor.mockImplementation(() => new Promise(() => {}));
        const publication = publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor, abortSignal: abort.signal });
        abort.abort('cancelled');
        await expect(publication).rejects.toMatchObject({ name: 'AbortError' });
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(f.relation.replaceText).not.toHaveBeenCalled();
    });

    it.each(['success', 'failure'])('removes the abort listener after worker %s', async outcome => {
        const f = fixture();
        const abort = new AbortController();
        const add = vi.spyOn(abort.signal, 'addEventListener');
        const remove = vi.spyOn(abort.signal, 'removeEventListener');
        if (outcome === 'failure') f.processor.mockRejectedValue(new Error('worker failed'));
        const publication = publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor, abortSignal: abort.signal });
        if (outcome === 'failure') await expect(publication).rejects.toThrow('worker failed');
        else await publication;
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    });

    it.each(['diagnostic', 'rejection'])('reports a superseded late %s as cancellation before inspecting it', async outcome => {
        const f = fixture();
        f.processor.mockImplementation(async request => {
            invalidateCatalogBatch(f.catalog);
            if (outcome === 'rejection') throw new Error('worker disposed');
            return { scripts: request.scripts.map(script => ({ id: script.id, diagnostics: [], failure: 'invalid SQL' })) };
        });
        await expect(publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(f.relation.replaceText).not.toHaveBeenCalled();
    });

    it('consumes a late worker rejection after cancellation', async () => {
        const f = fixture();
        const abort = new AbortController();
        let rejectWorker!: (error: Error) => void;
        f.processor.mockImplementation(() => new Promise((_resolve, reject) => { rejectWorker = reject; }));
        const publication = publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor, abortSignal: abort.signal });
        abort.abort();
        await expect(publication).rejects.toMatchObject({ name: 'AbortError' });
        rejectWorker(new Error('late worker failure'));
        await Promise.resolve();
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
    });

    it('consumes cancellation when a processor aborts and throws synchronously', async () => {
        const f = fixture();
        const abort = new AbortController();
        f.processor.mockImplementation(() => {
            abort.abort();
            throw new Error('worker disposed');
        });
        await expect(publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor, abortSignal: abort.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
    });

    it.each(['aborted', 'superseded', 'deleted', 'not current'])('does not publish a %s worker response', async invalidation => {
        const f = fixture();
        const abort = new AbortController();
        let current = true;
        const options = { processor: f.processor, abortSignal: abort.signal, isCurrent: () => current };
        f.processor.mockImplementation(async request => {
            const result = { scripts: request.scripts.map(script => ({ id: script.id, diagnostics: [], catalogDescriptor: f.descriptor })) };
            if (invalidation === 'aborted') abort.abort('cancelled');
            if (invalidation === 'superseded') beginCatalogBatch(f.catalog);
            if (invalidation === 'deleted') invalidateCatalogBatch(f.catalog);
            if (invalidation === 'not current') current = false;
            return result;
        });
        await expect(publishCatalogBatch(f.core, f.catalog, f.entries, options)).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(f.relation.toString()).toBe('old SQL 1');
        expect(f.functions.toString()).toBe('old SQL 2');
    });

    it('allocates a refresh generation before fetching so an older fetch cannot overwrite a newer refresh', async () => {
        const f = fixture();
        const oldFetch = beginCatalogBatch(f.catalog);
        await publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor });
        vi.mocked(f.catalog.replaceDescriptor).mockClear();
        await expect(publishCatalogBatch(f.core, f.catalog, f.entries, { processor: f.processor }, oldFetch))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(f.processor).toHaveBeenCalledTimes(1);
    });

    it('synchronous preparation rejects processing failures before mutating source SQL', () => {
        const f = fixture();
        vi.mocked(f.core.processBatch).mockImplementation(() => { throw new Error('batch failed'); });
        expect(() => publishCatalogBatchSync(f.core, f.catalog, f.entries)).toThrow('batch failed');
        expect(f.catalog.replaceDescriptor).not.toHaveBeenCalled();
        expect(f.relation.toString()).toBe('old SQL 1');
        expect(f.functions.toString()).toBe('old SQL 2');
    });
});
