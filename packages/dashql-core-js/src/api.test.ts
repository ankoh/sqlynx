import * as dashql from './index.js';

import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await loadCoreWasm();
    dql = await dashql.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(async () => {
    dql!.resetUnsafe();
});

describe('DashQL setup', () => {
    it('instantiates WebAssembly module', async () => {
        expect(dql).not.toBeNull();
        expect(dql).not.toBeUndefined();
    });

    it('copies strings into shared Wasm memory without encoding into it directly', () => {
        const heap = new Uint8Array(new SharedArrayBuffer(64));
        const module = {
            HEAPU8: heap,
            memory: { buffer: heap.buffer },
            _dashql_malloc: () => 8,
            _dashql_free: vi.fn(),
        } as any;
        const api = new dashql.DashQL(module);
        const encoder = new TextEncoder();
        api.encoder = {
            encodeInto(source: string, destination: Uint8Array) {
                if (destination.buffer instanceof SharedArrayBuffer) {
                    throw new TypeError('The provided Uint8Array value must not be shared');
                }
                return encoder.encodeInto(source, destination);
            },
        } as TextEncoder;

        expect(api.copyString('shell')).toEqual([8, 5]);
        expect(Array.from(heap.subarray(8, 14))).toEqual([115, 104, 101, 108, 108, 0]);
    });

    it('copies strings from shared Wasm memory before decoding them', () => {
        const heap = new Uint8Array(new SharedArrayBuffer(64));
        heap.set(new TextEncoder().encode('shell'), 8);
        const api = new dashql.DashQL({
            HEAPU8: heap,
            memory: { buffer: heap.buffer },
        } as any);
        const decoder = new TextDecoder();
        api.decoder = {
            decode(input?: AllowSharedBufferSource) {
                if (ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer) {
                    throw new TypeError('The provided ArrayBufferView value must not be shared');
                }
                return decoder.decode(input);
            },
        } as TextDecoder;

        expect(api.readString(8, 5)).toBe('shell');
    });

    it('copies FlatBuffer strings from shared Wasm memory before decoding them', () => {
        const decoder = dql!.decoder;
        const nativeDecoder = new TextDecoder();
        dql!.decoder = {
            decode(input?: AllowSharedBufferSource) {
                if (ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer) {
                    throw new TypeError('The provided ArrayBufferView value must not be shared');
                }
                return nativeDecoder.decode(input);
            },
        } as TextDecoder;

        try {
            const catalog = dql!.createCatalog();
            const script = dql!.createScript(catalog);
            script.replaceText('CREATE TABLE foo(a INT)');
            script.analyze();
            const analyzed = script.getAnalyzed();
            try {
                const table = analyzed.read().tables(0);
                expect(table?.tableName()?.tableName()).toBe('foo');
                expect(table?.tableColumns(0)?.columnName()).toBe('a');
            } finally {
                analyzed.destroy();
            }
        } finally {
            dql!.decoder = decoder;
        }
    });

});

describe('DashQL editor sessions', () => {
    const formattingConfig = () => new dashql.buffers.formatting.FormattingConfigT(
        dashql.buffers.formatting.FormattingDialect.HYPER,
        dashql.buffers.formatting.FormattingMode.INLINE,
        80,
        4,
    );

    it('owns and destroys the native session', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);

        expect(session.getText()).toBe('');
        expect(session.getCatalogEntryId()).toBe(session.catalog_entry_id);
        expect(session.getDocumentRevision()).toBe(0n);
        expect(session.getStateRevision()).toBe(0n);
        expect(dql!.registeredMemory.size).toBe(2);

        const update = session.replaceText(0n, 'select 1');
        expect(update.status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(update.documentRevision).toBe(1n);
        expect(dql!.registeredMemory.size).toBe(2);

        session.destroy();
        expect(dql!.registeredMemory.size).toBe(1);
        expect(() => session.getText()).toThrow(dashql.NULL_POINTER_EXCEPTION);
        session.destroy();
        catalog.destroy();
    });

    it('applies a Unicode batch in pre-change UTF-16 offsets', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'aéz');
        const event = new dashql.buffers.editor.EditorEventT(
            1n,
            [
                new dashql.buffers.editor.EditorTextChangeT(1n, 2n, '☃'),
                new dashql.buffers.editor.EditorTextChangeT(3n, 3n, '!'),
            ],
            new dashql.buffers.editor.EditorSelectionT(4n, 4n),
            dashql.buffers.editor.EditorEventOrigin.USER,
            dashql.buffers.editor.EditorEventIntent.EDIT,
            dashql.buffers.editor.EditorEventAction.TYPE,
            false,
        );

        const update = session.apply(event);

        expect(update.status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(update.offsetUnit).toBe(dashql.buffers.editor.EditorOffsetUnit.UTF16_CODE_UNITS);
        expect(update.textChanged).toBe(true);
        expect(update.selectionChanged).toBe(true);
        expect(update.primarySelection?.head).toBe(4n);
        expect(session.getText()).toBe('a☃z!');
        expect(session.getDocumentRevision()).toBe(2n);
    });

    it('clamps an insertion past the document end', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'a😀');
        const event = new dashql.buffers.editor.EditorEventT(
            1n,
            [new dashql.buffers.editor.EditorTextChangeT(100n, 100n, '!')],
            null,
            dashql.buffers.editor.EditorEventOrigin.USER,
            dashql.buffers.editor.EditorEventIntent.EDIT,
            dashql.buffers.editor.EditorEventAction.PASTE,
            false,
        );

        expect(session.apply(event).status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(session.getText()).toBe('a😀!');
    });

    it('publishes portable analysis and cursor state', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        const text = 'create table items (id int); select * from items;';
        session.replaceText(0n, text);
        const cursorUpdate = session.setCursor(1n, BigInt(text.length));

        const update = session.analyze();
        expect(update.status).toBe(dashql.buffers.editor.EditorUpdateStatus.OK);
        expect(cursorUpdate.analysisUpdated).toBe(true);
        expect(update.analysisUpdated).toBe(false);
        expect(update.analysisAvailable).toBe(true);
        expect(session.getStateRevision()).toBe(2n);
        expect(session.getCatalogRevision()).toBe(update.catalogRevision);

        expect(update.scriptAnnotations?.tableDefinitions).toHaveLength(1);
        expect(update.primaryCursorState?.textOffset).toBe(BigInt(text.length));
        expect(update.processingStatistics?.ropeBytes).toBeGreaterThan(0n);
        expect(dql!.registeredMemory.size).toBe(2);
    });

    it('completes at the session cursor', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 's');
        session.setCursor(1n, 1n);
        session.analyze();

        const completion = session.completeAtCursor(10);
        expect(completion.read().candidates(0)?.completionText()).toBe('select');
        completion.destroy();
    });

    it('compiles, formats, and diffs the session script', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'select 1 as value');
        session.analyze();

        const config = formattingConfig();
        const compilation = session.compileQuery(config);
        expect(compilation.read().sql()).toBe('select 1 as value');
        expect(compilation.read().errorsLength()).toBe(0);
        expect(compilation.read().cacheable()).toBe(true);
        expect(compilation.read().cacheSignature()).toMatch(/^[0-9a-f]{32}$/);
        compilation.destroy();

        expect(session.isFullyFormattable(config)).toBe(true);
        const formatted = session.format(config);
        expect(formatted.toString()).toBe('select 1 as value;');

        const target = dql!.createScript(catalog);
        target.replaceText('select 2 as value');
        target.parse();
        const diff = session.computeDiff(target);
        expect(diff.read().opsLength()).toBe(1);
        expect(diff.read().ops(0)?.code()).toBe(dashql.buffers.diff.ScriptDiffOpCode.UPDATE);

        diff.destroy();
        target.destroy();
        formatted.destroy();
    });

    it('decodes compiled SQL without passing shared memory to TextDecoder', () => {
        const decoder = dql!.decoder;
        const nativeDecoder = new TextDecoder();
        dql!.decoder = {
            decode(input?: AllowSharedBufferSource) {
                if (ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer) {
                    throw new TypeError('The provided ArrayBufferView value must not be shared');
                }
                return nativeDecoder.decode(input);
            },
        } as TextDecoder;

        try {
            const catalog = dql!.createCatalog();
            const session = dql!.createScriptSession(catalog);
            session.replaceText(0n, 'select 1 as value');
            session.analyze();
            const compilation = session.compileQuery(formattingConfig());
            try {
                expect(compilation.read().sql()).toBe('select 1 as value');
            } finally {
                compilation.destroy();
            }
        } finally {
            dql!.decoder = decoder;
        }
    });

    it('loads and drops the session-owned script from its catalog', () => {
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, 'create table items (id int)');
        session.analyze();

        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeFalsy();
        session.loadIntoCatalog(17);
        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeTruthy();
        session.dropFromCatalog();
        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeFalsy();

        session.loadIntoCatalog(23);
        session.destroy();
        expect(catalog.containsEntryId(session.catalog_entry_id)).toBeFalsy();
    });
});

describe('ContextObjectChildID', () => {
    it('create child ids', () => {
        const parentId = dashql.ExternalObjectID.create(1234, 5678);
        const childId = dashql.ContextObjectChildID.create(parentId, 91011);
        expect(childId).not.toEqual(parentId);
        expect(dashql.ContextObjectChildID.getParent(childId)).toEqual(parentId);
        expect(dashql.ContextObjectChildID.getChild(childId)).toEqual(91011);
        expect(childId.toString()).toEqual("22763282211344411091843");
    });
});
