import * as flatbuffers from 'flatbuffers';
import * as dashql from './index.js';

import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL;
const outputs: dashql.BatchOutput[] = ['scanned', 'parsed', 'analyzed', 'catalogDescriptor'];

beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await loadCoreWasm() });
});

afterEach(() => {
    vi.restoreAllMocks();
    dql.resetUnsafe();
});

function descriptor(text: string): Uint8Array {
    const result = dql.processBatch({ scripts: [{ id: 'schema', text, outputs: ['catalogDescriptor'] }] });
    expect(result.scripts[0].diagnostics).toEqual([]);
    expect(result.scripts[0].failure).toBeUndefined();
    return result.scripts[0].catalogDescriptor!;
}

describe('DashQL batches', () => {
    it('processes all sixteen output subsets in one native call', () => {
        const process = vi.spyOn(dql.bindings, 'processBatch');
        const scripts = Array.from({ length: 16 }, (_, mask) => ({
            id: String(mask),
            text: 'create table items(id int)',
            outputs: outputs.filter((_, bit) => (mask & (1 << bit)) !== 0),
        }));
        const result = dql.processBatch({ scripts });
        expect(process).toHaveBeenCalledTimes(1);
        expect(result.scripts).toHaveLength(16);
        for (let mask = 0; mask < 16; ++mask) {
            const script = result.scripts[mask];
            expect(script.id).toBe(String(mask));
            expect(script.diagnostics).toEqual([]);
            expect(script.failure).toBeUndefined();
            for (let bit = 0; bit < outputs.length; ++bit) {
                const bytes = script[outputs[bit]];
                if (mask & (1 << bit)) {
                    expect(Object.prototype.toString.call(bytes)).toBe('[object Uint8Array]');
                    expect(bytes!.byteLength).toBeGreaterThan(0);
                    expect(bytes!.byteOffset).toBe(0);
                    expect(bytes!.buffer.byteLength).toBe(bytes!.byteLength);
                } else {
                    expect(bytes).toBeUndefined();
                }
            }
            if (script.scanned) {
                const scanned = dashql.buffers.parser.ScannedScript.getRootAsScannedScript(new flatbuffers.ByteBuffer(script.scanned));
                expect(scanned.errorsLength()).toBe(0);
            }
            if (script.parsed) {
                const parsed = dashql.buffers.parser.ParsedScript.getRootAsParsedScript(new flatbuffers.ByteBuffer(script.parsed));
                expect(parsed.statementsLength()).toBe(1);
            }
            if (script.analyzed) {
                const analyzed = dashql.buffers.analyzer.AnalyzedScript.getRootAsAnalyzedScript(new flatbuffers.ByteBuffer(script.analyzed));
                expect(analyzed.tablesLength()).toBe(1);
            }
            if (script.catalogDescriptor) {
                const catalog = dashql.buffers.catalog.CatalogDescriptor.getRootAsCatalogDescriptor(new flatbuffers.ByteBuffer(script.catalogDescriptor));
                expect(catalog.tables(0)?.tableName()?.tableName()).toBe('items');
            }
        }
        expect(dql.registeredMemory.size).toBe(0);
    });

    it('supports empty requests, empty SQL, zero outputs and duplicate ids', () => {
        expect(dql.processBatch({ scripts: [] })).toEqual({ scripts: [] });
        const result = dql.processBatch({ scripts: [
            { id: '', text: '', outputs },
            { id: 'same', text: "select 'unterminated", outputs: [] },
            { id: 'same', text: 'select 1', outputs: ['parsed', 'parsed'] },
        ] });
        expect(result.scripts.map(script => script.id)).toEqual(['', 'same', 'same']);
        expect(result.scripts[0].diagnostics).toEqual([]);
        for (const output of outputs) expect(result.scripts[0][output]!.length).toBeGreaterThan(0);
        expect(result.scripts[1]).toEqual({ id: 'same', diagnostics: [] });
        expect(result.scripts[2].parsed).toBeDefined();
    });

    it('returns plain scan, parse and analysis diagnostics without inventing failures', () => {
        const result = dql.processBatch({ scripts: [
            { id: 'scan', text: "select 'unterminated", outputs: ['scanned'] },
            { id: 'parse', text: 'create table broken(', outputs: ['catalogDescriptor'] },
            { id: 'analyze', text: 'select * from a x, b x', outputs: ['analyzed'] },
            { id: 'valid', text: 'select 1', outputs: ['parsed'] },
        ] });
        for (let i = 0; i < 3; ++i) {
            const script = result.scripts[i];
            expect(script.failure).toBeUndefined();
            expect(script.diagnostics.some(diagnostic => diagnostic.stage === script.id)).toBe(true);
            for (const diagnostic of script.diagnostics) {
                expect(Object.getPrototypeOf(Object.getPrototypeOf(diagnostic))).toBeNull();
                expect(diagnostic.severity).toBe('error');
                expect(diagnostic.message.length).toBeGreaterThan(0);
                expect(diagnostic.offset).toBeGreaterThanOrEqual(0);
                expect(diagnostic.length).toBeGreaterThanOrEqual(0);
            }
        }
        expect(result.scripts[1].catalogDescriptor).toBeUndefined();
        expect(result.scripts[1].parsed).toBeUndefined();
        expect(result.scripts[3].parsed).toBeDefined();
    });

    it('retains descriptors for warnings and limits diagnostics to requested stages', () => {
        const result = dql.processBatch({ scripts: [
            { id: 'scan', text: 'create table broken(', outputs: ['scanned'] },
            { id: 'parse', text: 'select * from a x, b x', outputs: ['parsed'] },
            {
                id: 'warning',
                text: 'create table items(id int); select 1 as value visualize using vegalite ' +
                    '(mark => bar, dashboard => (row => -1, column => 15, width => 20, height => 0))',
                outputs: ['catalogDescriptor'],
            },
        ] });
        expect(result.scripts[0].diagnostics).toEqual([]);
        expect(result.scripts[1].diagnostics).toEqual([]);
        expect(result.scripts[2].diagnostics).toHaveLength(4);
        for (const diagnostic of result.scripts[2].diagnostics) {
            expect(diagnostic.stage).toBe('analyze');
            expect(diagnostic.severity).toBe('warning');
            expect(diagnostic.length).toBeGreaterThan(0);
        }
        expect(result.scripts[2].catalogDescriptor).toBeDefined();
    });

    it('borrows descriptor context while keeping scripts and successive batches independent', () => {
        const context = descriptor('create table context_table(id int)');
        const original = context.slice();
        const result = dql.processBatch({
            catalogDescriptors: [context],
            scripts: [
                { id: 'producer', text: 'create table local_table(id int)', outputs: ['catalogDescriptor'] },
                { id: 'consumer', text: 'select id from local_table', outputs: ['analyzed'] },
                { id: 'context', text: 'select id from context_table', outputs: ['analyzed'] },
            ],
        });
        const consumer = dashql.buffers.analyzer.AnalyzedScript.getRootAsAnalyzedScript(new flatbuffers.ByteBuffer(result.scripts[1].analyzed!));
        const contextual = dashql.buffers.analyzer.AnalyzedScript.getRootAsAnalyzedScript(new flatbuffers.ByteBuffer(result.scripts[2].analyzed!));
        expect(consumer.tableReferences(0)?.resolvedTable()).toBeNull();
        expect(contextual.tableReferences(0)?.resolvedTable()).not.toBeNull();
        expect(context).toEqual(original);
        expect(context.byteLength).toBeGreaterThan(0);
        const independent = dql.processBatch({ scripts: [
            { id: 'context', text: 'select id from context_table', outputs: ['analyzed'] },
        ] });
        const analyzed = dashql.buffers.analyzer.AnalyzedScript.getRootAsAnalyzedScript(new flatbuffers.ByteBuffer(independent.scripts[0].analyzed!));
        expect(analyzed.tableReferences(0)?.resolvedTable()).toBeNull();
    });

    it('keeps detached outputs readable after freeing owners, reusing memory and resetting', () => {
        const result = dql.processBatch({ scripts: [
            { id: 'portable', text: 'create table portable(id int)', outputs },
        ] });
        const original = outputs.map(output => result.scripts[0][output]!.slice());
        dql.resetUnsafe();
        for (let i = 0; i < 20; ++i) {
            dql.processBatch({ scripts: [{ id: 'reuse', text: 'select 123 as different', outputs }] });
        }
        outputs.forEach((output, i) => expect(result.scripts[0][output]).toEqual(original[i]));
        const catalog = dashql.buffers.catalog.CatalogDescriptor.getRootAsCatalogDescriptor(new flatbuffers.ByteBuffer(result.scripts[0].catalogDescriptor!));
        expect(catalog.tables(0)?.tableName()?.tableName()).toBe('portable');
        expect(dql.registeredMemory.size).toBe(0);
    });

    it('rejects unknown public output strings before entering native code', () => {
        const process = vi.spyOn(dql.bindings, 'processBatch');
        expect(() => dql.processBatch({ scripts: [
            { id: 'invalid', text: 'select 1', outputs: ['unknown' as dashql.BatchOutput] },
        ] })).toThrow('unknown batch output: unknown');
        expect(process).not.toHaveBeenCalled();
    });

    it('leaves invalid numeric masks to native per-script rejection', () => {
        const process = dql.bindings.processBatch;
        vi.spyOn(dql.bindings, 'processBatch').mockImplementation(bytes => {
            const request = dashql.buffers.batch.BatchRequest.getRootAsBatchRequest(new flatbuffers.ByteBuffer(bytes));
            expect(request.scripts(0)!.mutate_outputs(16)).toBe(true);
            return process(bytes);
        });
        const result = dql.processBatch({ scripts: [
            { id: 'invalid', text: 'select 1', outputs: ['parsed'] },
            { id: 'valid', text: 'select 1', outputs: ['parsed'] },
        ] });
        expect(result.scripts[0].failure!.length).toBeGreaterThan(0);
        expect(result.scripts[0].parsed).toBeUndefined();
        expect(result.scripts[1].failure).toBeUndefined();
        expect(result.scripts[1].parsed).toBeDefined();
    });

    it('rejects malformed contexts and malformed native requests', () => {
        expect(() => dql.processBatch({ scripts: [], catalogDescriptors: [new Uint8Array([0, 1, 2, 3])] })).toThrow();
        const process = dql.bindings.processBatch;
        vi.spyOn(dql.bindings, 'processBatch').mockImplementation(bytes => process(bytes.fill(0xff)));
        expect(() => dql.processBatch({ scripts: [] })).toThrow();
        expect(dql.registeredMemory.size).toBe(0);
    });

    it('throws when decoding the native result fails', () => {
        const process = dql.bindings.processBatch;
        vi.spyOn(dql.bindings, 'processBatch').mockImplementation(bytes => {
            const output = process(bytes);
            const response = dashql.buffers.batch.BatchResult.getRootAsBatchResult(new flatbuffers.ByteBuffer(output));
            expect(response.scripts(0)!.diagnostics(0)!.mutate_stage(255 as dashql.buffers.batch.ProcessingStage)).toBe(true);
            return output;
        });
        expect(() => dql.processBatch({ scripts: [
            { id: 'parse', text: 'create table broken(', outputs: ['catalogDescriptor'] },
        ] })).toThrow('unknown batch diagnostic stage');
        expect(dql.registeredMemory.size).toBe(0);
    });

    it('propagates native failures', () => {
        vi.spyOn(dql.bindings, 'processBatch').mockImplementation(() => {
            throw new Error('native call failed');
        });
        expect(() => dql.processBatch({ scripts: [] })).toThrow('native call failed');
    });
});

describe('DashQL catalog descriptors', () => {
    it('allocates ids and imports tables, columns and functions for analysis and completion', () => {
        const bytes = descriptor('create table db.sch.items(id int, title text); ' +
            'create function db.sch.item_count(input int) returns bigint;');
        const decoded = dashql.buffers.catalog.CatalogDescriptor.getRootAsCatalogDescriptor(new flatbuffers.ByteBuffer(bytes));
        expect(decoded.functionDeclarationsLength()).toBe(1);
        expect(decoded.functionDeclarations(0)?.returnType()).toBe('bigint');
        const catalog = dql.createCatalog();
        const id = catalog.allocateEntryId();
        const otherId = catalog.allocateEntryId();
        expect(id).not.toBe(otherId);
        expect(catalog.containsEntryId(id)).toBe(false);
        const before = catalog.createSnapshot();
        const version = before.read().catalogReader.catalogVersion();
        catalog.replaceDescriptor(id, 20, bytes);
        expect(before.ptr.isNull()).toBe(true);
        const snapshot = catalog.createSnapshot();
        expect(snapshot.read().catalogReader.catalogVersion()).toBe(version + 1n);
        expect(snapshot.read().catalogReader.tablesLength()).toBe(1);
        expect(catalog.describeEntries().unpackAndDestroy().entries[0].rank).toBe(20);
        bytes.fill(0);

        const query = dql.createScript(catalog);
        query.replaceText('select id from db.sch.items');
        query.analyze();
        const analyzed = query.getAnalyzed().unpackAndDestroy();
        expect(analyzed.tableReferences[0].resolvedTable.catalogTableId).toBe(dashql.ExternalObjectID.create(id, 0));
        expect(analyzed.resolvedColumnReferencesById).toHaveLength(1);
        for (const [text, expected] of [
            ['select * from ite', 'items'],
            ['select item_c', 'item_count()'],
            ['select tit', 'title'],
            ['select * from db.sch.', 'items'],
            ['select * from db.sch.items i where i.', 'id'],
        ]) {
            query.replaceText(text);
            query.analyze();
            query.moveCursor(text.length).destroy();
            const completion = query.completeAtCursor(50).unpackAndDestroy();
            expect(completion.candidates.map((candidate: dashql.buffers.completion.CompletionCandidateT) => candidate.completionText)).toContain(expected);
        }
        catalog.dropDescriptor(id);
        expect(snapshot.ptr.isNull()).toBe(true);
        expect(catalog.containsEntryId(id)).toBe(false);
        expect(catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(0);
    });

    it('publishes each descriptor pool once and retains the first success when the second fails', () => {
        const original = descriptor('create table original(id int)');
        const updated = descriptor('create table updated(id int)');
        const catalog = dql.createCatalog();
        const id = catalog.allocateEntryId();
        const otherId = catalog.allocateEntryId();
        const script = dql.createScript(catalog);
        script.replaceText('create table script_table(id int)');
        script.analyze();
        catalog.loadScript(script, 10);
        catalog.replaceDescriptor(id, 20, original);
        const snapshot = catalog.createSnapshot();
        const version = snapshot.read().catalogReader.catalogVersion();
        catalog.replaceDescriptor(id, 1, updated);
        expect(snapshot.ptr.isNull()).toBe(true);
        const current = catalog.createSnapshot();
        expect(current.read().catalogReader.catalogVersion()).toBe(version + 1n);
        expect(current.read().catalogReader.tablesLength()).toBe(2);
        expect(catalog.describeEntriesOf(id).unpackAndDestroy().entries[0].rank).toBe(1);
        expect(() => catalog.replaceDescriptor(otherId, 2, new Uint8Array([0, 1, 2, 3]))).toThrow();
        expect(catalog.createSnapshot()).toBe(current);
        expect(catalog.containsEntryId(otherId)).toBe(false);
        expect(current.read().catalogReader.catalogVersion()).toBe(version + 1n);
        expect(() => catalog.replaceDescriptor(id, 2, new Uint8Array([0, 1, 2, 3]))).toThrow();
        expect(catalog.createSnapshot()).toBe(current);
        expect(catalog.describeEntriesOf(id).unpackAndDestroy().entries[0].rank).toBe(1);
        const query = dql.createScript(catalog);
        query.replaceText('select id from updated');
        query.analyze();
        expect(query.getAnalyzed().unpackAndDestroy().tableReferences[0].resolvedTable.catalogTableId)
            .toBe(dashql.ExternalObjectID.create(id, 0));

        catalog.replaceDescriptor(otherId, 0xffffffff, original);
        expect(current.ptr.isNull()).toBe(true);
        const next = catalog.createSnapshot();
        expect(next.read().catalogReader.catalogVersion()).toBe(version + 2n);
        expect(catalog.containsEntryId(script.getCatalogEntryId())).toBe(true);
        expect(catalog.containsEntryId(otherId)).toBe(true);
        expect(next.read().catalogReader.tablesLength()).toBe(3);
        expect(catalog.describeEntriesOf(otherId).unpackAndDestroy().entries[0].rank).toBe(0xffffffff);
        catalog.dropDescriptor(id);
        expect(catalog.containsEntryId(otherId)).toBe(true);
        expect(catalog.containsEntryId(script.getCatalogEntryId())).toBe(true);
    });

    it('rejects colliding script ids and unallocated ids without invalidating the snapshot', () => {
        const bytes = descriptor('create table items(id int)');
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        script.replaceText('create table script_table(id int)');
        script.analyze();
        catalog.loadScript(script, 10);
        const snapshot = catalog.createSnapshot();
        const version = snapshot.read().catalogReader.catalogVersion();
        for (const id of [script.getCatalogEntryId(), 0xffffffff]) {
            expect(() => catalog.replaceDescriptor(id, 1, bytes)).toThrow();
            expect(catalog.createSnapshot()).toBe(snapshot);
            expect(snapshot.read().catalogReader.catalogVersion()).toBe(version);
        }
        expect(catalog.containsEntryId(script.getCatalogEntryId())).toBe(true);
        expect(snapshot.read().catalogReader.tablesLength()).toBe(1);
    });

    it('validates JS uint32 ids and ranks before entering native code', () => {
        const bytes = descriptor('create table items(id int)');
        const catalog = dql.createCatalog();
        const id = catalog.allocateEntryId();
        const snapshot = catalog.createSnapshot();
        const replace = vi.spyOn(dql.bindings.Catalog.prototype, 'replaceDescriptor');
        const drop = vi.spyOn(dql.bindings.Catalog.prototype, 'dropDescriptor');
        for (const invalid of [-1, 1.5, NaN, Infinity, -Infinity, 0x100000000]) {
            expect(() => catalog.replaceDescriptor(invalid, 0, bytes)).toThrow('catalogEntryId must be a uint32');
            expect(() => catalog.replaceDescriptor(id, invalid, bytes)).toThrow('rank must be a uint32');
            expect(() => catalog.dropDescriptor(invalid)).toThrow('catalogEntryId must be a uint32');
            expect(catalog.createSnapshot()).toBe(snapshot);
        }
        expect(replace).not.toHaveBeenCalled();
        expect(drop).not.toHaveBeenCalled();
        catalog.destroy();
        expect(() => catalog.allocateEntryId()).toThrow(dashql.NULL_POINTER_EXCEPTION);
        expect(() => catalog.replaceDescriptor(id, 0, bytes)).toThrow(dashql.NULL_POINTER_EXCEPTION);
        expect(() => catalog.dropDescriptor(id)).toThrow(dashql.NULL_POINTER_EXCEPTION);
    });

    it('passes raw descriptor bytes to the native catalog without modifying them', () => {
        const bytes = descriptor('create table items(id int)');
        const original = bytes.slice();
        const catalog = dql.createCatalog();
        const id = catalog.allocateEntryId();
        const memoryCount = dql.registeredMemory.size;
        const replace = vi.spyOn(dql.bindings.Catalog.prototype, 'replaceDescriptor');
        catalog.replaceDescriptor(id, 0, bytes);
        expect(replace.mock.calls[0][0]).toBe(id);
        expect(replace.mock.calls[0][1]).toBe(0);
        expect(replace.mock.calls[0][2]).toEqual(original);
        expect(bytes).toEqual(original);
        expect(() => catalog.replaceDescriptor(id, 0, new Uint8Array([0, 1, 2, 3]))).toThrow();
        expect(replace).toHaveBeenCalledTimes(2);
        expect(dql.registeredMemory.size).toBe(memoryCount);
    });

    it('keeps the snapshot when native replacement throws', () => {
        const bytes = descriptor('create table items(id int)');
        const catalog = dql.createCatalog();
        const id = catalog.allocateEntryId();
        const snapshot = catalog.createSnapshot();
        const memoryCount = dql.registeredMemory.size;
        vi.spyOn(dql.bindings.Catalog.prototype, 'replaceDescriptor').mockImplementation(() => {
            throw new Error('native replacement failed');
        });
        expect(() => catalog.replaceDescriptor(id, 0, bytes)).toThrow('native replacement failed');
        expect(catalog.createSnapshot()).toBe(snapshot);
        expect(dql.registeredMemory.size).toBe(memoryCount);
    });
});
