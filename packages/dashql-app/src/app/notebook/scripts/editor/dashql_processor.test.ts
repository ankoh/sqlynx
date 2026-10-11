import * as dashql from '@ankoh/dashql-core';

import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
    analyzeScript,
    DashQLCompletionAbortEffect,
    DashQLCompletionStartEffect,
    DashQLCompletionNextCandidateVariantEffect,
    DashQLCompletionStatus,
    DashQLProcessorPlugin,
    DashQLProcessorUpdateIn,
    DashQLProcessorUpdateOut,
    DashQLUpdateEffect,
    transactionToEditorEvent,
} from './dashql_processor.js';
import { applyCompletion, computePatches } from './dashql_completion_patches.js';
import { DashQLDecorationPlugin } from './dashql_decorations.js';
import { deriveFocusFromEditorUpdate } from '../focus.js';
import { xcodeLight } from './themes/xcode.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await DASHQL_PRECOMPILED;
    dql = await dashql.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(() => {
    dql!.resetUnsafe();
});

function createScriptSession(catalog: dashql.DashQLCatalog, text: string, cursor = text.length) {
    const scriptSession = dql!.createScriptSession(catalog);
    scriptSession.replaceText(0n, text);
    const update = scriptSession.analyze();
    expect(update.analysisAvailable).toBe(true);
    const editorUpdate = scriptSession.setCursor(1n, BigInt(cursor));
    return { scriptSession, editorUpdate };
}

describe('CodeMirror portable editor events', () => {
    it('keeps an incrementally typed WITH prefix analyzable', () => {
        const catalog = dql!.createCatalog();
        const scriptSession = dql!.createScriptSession(catalog);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: scriptSession.getCatalogEntryId(),
            scriptSession,
            editorUpdate: scriptSession.analyze(),
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: '',
            selection: EditorSelection.cursor(0),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;

        for (const character of 'wit') {
            const offset = editorState.doc.length;
            editorState = editorState.update({
                changes: { from: offset, insert: character },
                selection: EditorSelection.cursor(offset + 1),
                annotations: Transaction.userEvent.of('input.type'),
            }).state;
        }

        expect(editorState.doc.toString()).toBe('wit');
        expect(scriptSession.getText()).toBe('wit');
        expect(editorState.field(DashQLProcessorPlugin).editorUpdate?.analysisAvailable).toBe(true);
    });

    it('does not warn when projecting a read-only editor update', () => {
        const catalog = dql!.createCatalog();
        const { scriptSession, editorUpdate } = createScriptSession(catalog, 'select 1');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            let editorState = EditorState.create({
                extensions: [DashQLProcessorPlugin],
            });

            editorState = editorState.update({
                changes: { from: 0, insert: 'select 1' },
                effects: DashQLUpdateEffect.of({
                    scriptKey: 1,
                    scriptSession: null,
                    editorUpdate,
                    scriptBuffers: null,
                    scriptCompletion: null,
                    scriptPendingDiff: null,
                    derivedFocus: null,
                    onUpdate: () => {},
                }),
            }).state;

            expect(editorState.doc.toString()).toBe('select 1');
            expect(editorState.field(DashQLProcessorPlugin).editorUpdate).toBe(editorUpdate);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            scriptSession.destroy();
            catalog.destroy();
        }
    });

    it('warns when an unconfigured editor changes without a projection', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const editorState = EditorState.create({
                extensions: [DashQLProcessorPlugin],
            }).update({
                changes: { from: 0, insert: 'select 1' },
            }).state;

            expect(editorState.doc.toString()).toBe('select 1');
            expect(warn).toHaveBeenCalledOnce();
        } finally {
            warn.mockRestore();
        }
    });

    it('does not warn for changes in an unconfigured read-only editor', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const editorState = EditorState.create({
                extensions: [EditorState.readOnly.of(true), DashQLProcessorPlugin],
            }).update({
                changes: { from: 0, insert: 'select 1' },
            }).state;

            expect(editorState.doc.toString()).toBe('select 1');
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('keeps highlighting when the catalog changes before a cursor move', () => {
        const catalog = dql!.createCatalog();
        const text = 'select value from items';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, 0);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: scriptSession.getCatalogEntryId(),
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(0),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;

        const schemaSession = dql!.createScriptSession(catalog);
        schemaSession.replaceText(0n, 'create table items (value int)');
        schemaSession.analyze();
        schemaSession.loadIntoCatalog(0);

        editorState = editorState.update({ selection: EditorSelection.cursor(7) }).state;
        const moved = editorState.field(DashQLProcessorPlugin).editorUpdate;
        expect(moved?.analysisAvailable).toBe(true);
        expect(moved?.analysisUpdated).toBe(true);
        expect(moved?.syntaxSpans.length).toBeGreaterThan(0);

        schemaSession.destroy();
    });

    it('renders focused and related semantic references after a cursor update', () => {
        const catalog = dql!.createCatalog();
        const schemaSession = dql!.createScriptSession(catalog);
        schemaSession.replaceText(0n, 'create table items (identifier int)');
        schemaSession.analyze();
        schemaSession.loadIntoCatalog(0);

        const text = 'select identifier from items where identifier > 0';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, 0);
        const scriptKey = scriptSession.getCatalogEntryId();
        let emitted: DashQLProcessorUpdateOut | null = null;
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: update => { emitted = update; },
        };
        const view = new EditorView({
            state: EditorState.create({
                doc: text,
                selection: EditorSelection.cursor(0),
                extensions: [DashQLProcessorPlugin, DashQLDecorationPlugin],
            }),
            parent: document.body,
        });
        view.dispatch({ effects: DashQLUpdateEffect.of(processorState) });
        view.dispatch({ selection: EditorSelection.cursor(8) });

        expect(emitted).not.toBeNull();
        const focusedUpdate = emitted!.editorUpdate!;
        view.dispatch({
            effects: DashQLUpdateEffect.of({
                ...view.state.field(DashQLProcessorPlugin),
                editorUpdate: focusedUpdate,
                derivedFocus: deriveFocusFromEditorUpdate(scriptKey, focusedUpdate),
            }),
        });

        expect(view.dom.querySelectorAll('.dashql-colref-cursor')).toHaveLength(1);
        expect(view.dom.querySelectorAll('.dashql-colref-focus')).toHaveLength(1);
        expect(view.dom.querySelectorAll('.dashql-tableref-focus')).toHaveLength(1);
        view.destroy();
        scriptSession.destroy();
        schemaSession.destroy();
        catalog.destroy();
    });

    it('renders semantic focus immediately on a local cursor transaction', () => {
        const catalog = dql!.createCatalog();
        const schemaSession = dql!.createScriptSession(catalog);
        schemaSession.replaceText(0n, 'create table items (identifier int)');
        schemaSession.analyze();
        schemaSession.loadIntoCatalog(0);

        const text = 'select identifier from items where identifier > 0';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, 0);
        const scriptKey = scriptSession.getCatalogEntryId();
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        const view = new EditorView({
            state: EditorState.create({
                doc: text,
                selection: EditorSelection.cursor(0),
                extensions: [DashQLProcessorPlugin, DashQLDecorationPlugin],
            }),
            parent: document.body,
        });
        view.dispatch({ effects: DashQLUpdateEffect.of(processorState) });
        view.dispatch({ selection: EditorSelection.cursor(8) });

        expect(view.dom.querySelectorAll('.dashql-colref-cursor')).toHaveLength(1);
        expect(view.dom.querySelectorAll('.dashql-colref-focus')).toHaveLength(1);
        expect(view.dom.querySelectorAll('.dashql-tableref-focus')).toHaveLength(1);
        view.destroy();
        scriptSession.destroy();
        schemaSession.destroy();
        catalog.destroy();
    });

    it('keeps relation and function syntax highlighting through the notebook round-trip', () => {
        const catalog = dql!.createCatalog();
        const schemaSession = dql!.createScriptSession(catalog);
        schemaSession.replaceText(0n, 'create table items (identifier int)');
        schemaSession.analyze();
        schemaSession.loadIntoCatalog(0);

        const text = 'select count(identifier) from items';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, 0);
        const scriptKey = scriptSession.getCatalogEntryId();
        let emitted: DashQLProcessorUpdateOut | null = null;
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: update => { emitted = update; },
        };
        const view = new EditorView({
            state: EditorState.create({
                doc: text,
                selection: EditorSelection.cursor(0),
                extensions: [xcodeLight, DashQLProcessorPlugin, DashQLDecorationPlugin],
            }),
            parent: document.body,
        });
        view.dispatch({ effects: DashQLUpdateEffect.of(processorState) });
        view.dispatch({ selection: EditorSelection.cursor(text.indexOf('identifier') + 1) });
        const focusedUpdate = emitted!.editorUpdate!;
        view.dispatch({
            effects: DashQLUpdateEffect.of({
                ...view.state.field(DashQLProcessorPlugin),
                editorUpdate: focusedUpdate,
                derivedFocus: deriveFocusFromEditorUpdate(scriptKey, focusedUpdate),
            }),
        });

        const functionNode = Array.from(view.dom.querySelectorAll('.dashql-function-ref'))
            .find(node => node.textContent === 'count');
        const relationNode = Array.from(view.dom.querySelectorAll('.dashql-tableref-resolved'))
            .find(node => node.textContent === 'items');
        expect(functionNode?.classList.contains('dashql-function-ref')).toBe(true);
        expect(relationNode?.classList.contains('dashql-tableref-resolved')).toBe(true);
        expect(getComputedStyle(functionNode!.querySelector('span')!).color).toBe('rgb(35, 87, 92)');
        expect(getComputedStyle(relationNode!.querySelector('span')!).color).toBe('rgb(82, 43, 178)');
        view.destroy();
        scriptSession.destroy();
        schemaSession.destroy();
        catalog.destroy();
    });

    it('does not materialize compatibility analysis buffers', () => {
        const catalog = dql!.createCatalog();
        const scriptSession = dql!.createScriptSession(catalog);
        scriptSession.replaceText(0n, 'select 1');
        const beforeAnalysis = dql!.registeredMemory.size;

        const update = scriptSession.analyze();
        expect(dql!.registeredMemory.size).toBe(beforeAnalysis);
        expect(update.analysisAvailable).toBe(true);
        expect(dql!.registeredMemory.size).toBe(beforeAnalysis);
    });

    it('encodes multi-range changes against the pre-change document', () => {
        const start = EditorState.create({
            doc: 'aéz😀q',
            selection: EditorSelection.cursor(1),
        });
        const transaction = start.update({
            changes: [
                { from: 1, to: 2, insert: '☃' },
                { from: 3, to: 5, insert: '!' },
            ],
            selection: EditorSelection.cursor(5),
            annotations: Transaction.userEvent.of('input.type'),
        });

        const event = transactionToEditorEvent(transaction, 7n);

        expect(event.expectedDocumentRevision).toBe(7n);
        expect(event.changes.map(change => [change.from, change.to, change.insert])).toEqual([
            [1n, 2n, '☃'],
            [3n, 5n, '!'],
        ]);
        expect(event.primarySelection).toEqual(expect.objectContaining({ anchor: 5n, head: 5n }));
        expect(event.origin).toBe(dashql.buffers.editor.EditorEventOrigin.USER);
        expect(event.action).toBe(dashql.buffers.editor.EditorEventAction.TYPE);
    });

    it('applies a Unicode multi-range edit as one session revision', () => {
        const catalog = dql!.createCatalog();
        const text = 'aéz😀q';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, 1);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(1),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;
        const revision = scriptSession.getDocumentRevision();
        editorState = editorState.update({
            changes: [
                { from: 1, to: 2, insert: '☃' },
                { from: 3, to: 5, insert: '!' },
            ],
            selection: EditorSelection.cursor(5),
            annotations: Transaction.userEvent.of('input.type'),
        }).state;

        expect(scriptSession.getText()).toBe('a☃z!q');
        expect(scriptSession.getDocumentRevision()).toBe(revision + 1n);
        expect(editorState.doc.toString()).toBe(scriptSession.getText());
    });
});

describe('DashQL processor completion triggers', () => {
    it('refreshes an open keyword hint when the case preference changes', () => {
        const catalog = dql!.createCatalog();
        const text = 'sel';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text);
        const onUpdate = vi.fn();
        const projected: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            keywordCase: dashql.buffers.formatting.KeywordCase.LOWER,
            onUpdate,
        };
        let state = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(text.length),
            extensions: [DashQLProcessorPlugin],
        });
        state = state.update({ effects: DashQLUpdateEffect.of(projected) }).state;
        state = state.update({ effects: DashQLCompletionStartEffect.of(null) }).state;
        const previous = state.field(DashQLProcessorPlugin).scriptCompletion;
        expect(previous).not.toBeNull();
        state = state.update({ effects: DashQLUpdateEffect.of({
            ...projected,
            scriptCompletion: previous,
            keywordCase: dashql.buffers.formatting.KeywordCase.UPPER,
        }) }).state;
        const refreshed = state.field(DashQLProcessorPlugin).scriptCompletion;
        expect(refreshed?.buffer).not.toBe(previous?.buffer);
        expect(refreshed?.buffer.read().candidates(refreshed.candidateId)?.completionText()).toBe('SELECT');
        expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ scriptCompletion: refreshed }));
        refreshed?.buffer.destroy();
        previous?.buffer.destroy();
        scriptSession.destroy();
        catalog.destroy();
    });
    it('cases keywords and continuations but not catalog identifiers', () => {
        const catalog = dql!.createCatalog();
        const schema = dql!.createScript(catalog);
        schema.insertTextAt(0, 'create table orders(id int);');
        schema.analyze();
        catalog.loadScript(schema, 0);
        const { scriptSession } = createScriptSession(catalog, 'select * from ord');
        const objects = scriptSession.completeAtCursor(20, dashql.buffers.formatting.KeywordCase.UPPER);
        expect(Array.from({ length: objects.read().candidatesLength() }, (_, i) => objects.read().candidates(i)?.completionText()))
            .toContain('orders');
        objects.destroy();
        scriptSession.replaceText(scriptSession.getDocumentRevision(), 'select * from orders group');
        scriptSession.setCursor(scriptSession.getDocumentRevision(), BigInt('select * from orders group'.length));
        const keywords = scriptSession.completeAtCursor(30, dashql.buffers.formatting.KeywordCase.UPPER);
        const candidates = Array.from({ length: keywords.read().candidatesLength() }, (_, i) => keywords.read().candidates(i));
        expect(candidates.find(candidate => candidate?.completionText() === 'GROUP')?.keywordContinuation()).toBe('BY');
        keywords.destroy();
        scriptSession.destroy();
        schema.destroy();
        catalog.destroy();
    });
    it('builds CodeMirror completion patches from UTF-8 candidate spans', () => {
        const catalog = dql!.createCatalog();
        const schemaScript = dql!.createScript(catalog);
        schemaScript.insertTextAt(0, 'create table orders(id int);');
        schemaScript.analyze();
        catalog.loadScript(schemaScript, 0);

        const text = "select 'é😀', ord";
        const { scriptSession } = createScriptSession(catalog, text);
        const completionBuffer = scriptSession.completeAtCursor(10);
        const completion = completionBuffer.read();
        let candidateId = -1;
        for (let i = 0; i < completion.candidatesLength(); ++i) {
            if (completion.candidates(i)?.displayText() === 'orders') {
                candidateId = i;
                break;
            }
        }
        expect(candidateId).toBeGreaterThanOrEqual(0);

        const completionState = computePatches({
            status: DashQLCompletionStatus.AVAILABLE,
            passiveHint: false,
            buffer: completionBuffer,
            candidateId,
            candidatePatch: [],
            catalogObjectId: 0,
            catalogObjectPatch: [],
            catalogObjectCursorOffset: null,
        }, EditorState.create({ doc: text }).doc, text.length);
        const updated = EditorState.create({ doc: text }).update({
            changes: applyCompletion(completionState.candidatePatch),
        }).newDoc.toString();

        expect(updated).toBe("select 'é😀', orders");
    });

    it('cycles catalog objects for the selected completion candidate', () => {
        const catalog = dql!.createCatalog();
        const schemaScript = dql!.createScript(catalog);
        schemaScript.insertTextAt(0, [
            'create table db0.public.orders(id int);',
            'create table db1.public.orders(id int);',
        ].join('\n'));
        schemaScript.analyze();
        catalog.loadScript(schemaScript, 0);

        const text = 'select * from ord';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text);
        const completionBuffer = scriptSession.completeAtCursor(10);
        const completion = completionBuffer.read();
        let candidateId = -1;
        for (let i = 0; i < completion.candidatesLength(); ++i) {
            if (completion.candidates(i)?.displayText() === 'orders') {
                candidateId = i;
                break;
            }
        }
        expect(candidateId).toBeGreaterThanOrEqual(0);
        expect(completion.candidates(candidateId)?.catalogObjectsLength()).toBe(2);

        const initialCompletion = computePatches({
            status: DashQLCompletionStatus.AVAILABLE,
            passiveHint: false,
            buffer: completionBuffer,
            candidateId,
            candidatePatch: [],
            catalogObjectId: 0,
            catalogObjectPatch: [],
            catalogObjectCursorOffset: null,
        }, EditorState.create({ doc: text }).doc, text.length);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: initialCompletion,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(text.length),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;

        editorState = editorState.update({
            effects: DashQLCompletionNextCandidateVariantEffect.of(null),
        }).state;

        const next = editorState.field(DashQLProcessorPlugin).scriptCompletion!;
        expect(next.catalogObjectId).toBe(1);
        const selectedObject = next.buffer.read().candidates(next.candidateId)!.catalogObjects(next.catalogObjectId)!;
        expect(next.catalogObjectPatch).not.toHaveLength(0);
        expect(selectedObject.qualifiedName(0)).toBe('db1');
    });

    it('does not start completion when deleting selected comments before a token', () => {
        const catalog = dql!.createCatalog();
        const text = `-- Fetch and visualize vega cars data from a parquet file, rendering a point
-- chart with year on the x-axis and weight on the y-axis.
SELECT * FROM read_parquet('vega_cars.parquet') VISUALIZE USING vegalite (
  mark => point,
  encoding => (
    x => (field => "Year", type => temporal),
    y => (field => "Weight_in_lbs", type => quantitative)
  )
);`;
        const cursorOffset = text.indexOf('VISUALIZE');
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, cursorOffset);
        expect(editorUpdate.primaryCursorState?.scannerRelativePosition).toBe(
            dashql.buffers.cursor.RelativeSymbolPosition.BEGIN_OF_SYMBOL,
        );
        expect(editorUpdate.primaryCursorState?.scannerSymbolCompletable).toBe(true);

        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.range(0, cursorOffset),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;
        editorState = editorState.update({
            changes: { from: 0, to: cursorOffset },
            selection: EditorSelection.cursor(0),
            annotations: Transaction.userEvent.of('delete.selection'),
        }).state;

        expect(editorState.doc.toString()).toBe(text.slice(cursorOffset));
        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
    });

    it('does not start completion when backspace deletes the newline before a token', () => {
        const catalog = dql!.createCatalog();
        const text = '\nSELECT';
        const cursorOffset = 1;
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, cursorOffset);
        expect(editorUpdate.primaryCursorState?.scannerRelativePosition).toBe(
            dashql.buffers.cursor.RelativeSymbolPosition.BEGIN_OF_SYMBOL,
        );
        expect(editorUpdate.primaryCursorState?.scannerSymbolCompletable).toBe(true);

        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(cursorOffset),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;
        editorState = editorState.update({
            changes: { from: 0, to: 1 },
            selection: EditorSelection.cursor(0),
            annotations: Transaction.userEvent.of('delete.backward'),
        }).state;

        expect(editorState.doc.toString()).toBe('SELECT');
        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
    });

    it('still starts completion when backspace deletes from a token', () => {
        const catalog = dql!.createCatalog();
        const text = 'SELECT';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(text.length),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;
        editorState = editorState.update({
            changes: { from: text.length - 1, to: text.length },
            selection: EditorSelection.cursor(text.length - 1),
            annotations: Transaction.userEvent.of('delete.backward'),
        }).state;

        expect(editorState.doc.toString()).toBe('SELEC');
        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).not.toBeNull();
    });

    it('does not start completion when typing at the beginning of a token', () => {
        const catalog = dql!.createCatalog();
        const schemaScript = dql!.createScript(catalog);
        schemaScript.insertTextAt(0, 'create table tableA("attrA" int)');
        schemaScript.analyze();
        catalog.loadScript(schemaScript, 0);

        const text = 'select * from tableA where ttr';
        const cursorOffset = text.indexOf('ttr');
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, cursorOffset);
        expect(editorUpdate.primaryCursorState?.scannerRelativePosition).toBe(
            dashql.buffers.cursor.RelativeSymbolPosition.BEGIN_OF_SYMBOL,
        );
        expect(editorUpdate.primaryCursorState?.scannerSymbolCompletable).toBe(true);

        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(cursorOffset),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;

        editorState = editorState.update({
            changes: { from: cursorOffset, insert: 'a' },
            selection: EditorSelection.cursor(cursorOffset + 1),
            annotations: Transaction.userEvent.of('input.type'),
        }).state;

        expect(editorState.doc.toString()).toBe('select * from tableA where attr');
        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
    });

    it('does not start completion for composed input at the beginning of a token', () => {
        const catalog = dql!.createCatalog();
        const text = 'select ttr';
        const cursorOffset = text.indexOf('ttr');
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, cursorOffset);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(cursorOffset),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;
        editorState = editorState.update({
            changes: { from: cursorOffset, insert: 'a' },
            selection: EditorSelection.cursor(cursorOffset + 1),
            annotations: Transaction.userEvent.of('input.type.compose'),
        }).state;

        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
    });

    it('dismisses an active completion when typing at the beginning of another token', () => {
        const catalog = dql!.createCatalog();
        const schemaScript = dql!.createScript(catalog);
        schemaScript.insertTextAt(0, 'create table tableA("attrA" int)');
        schemaScript.analyze();
        catalog.loadScript(schemaScript, 0);

        const text = 'select * from tableA where att ttr';
        const firstCursor = text.indexOf('att') + 3;
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text, firstCursor);
        const completionBuffer = scriptSession.completeAtCursor(10);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: {
                status: DashQLCompletionStatus.AVAILABLE,
                passiveHint: false,
                buffer: completionBuffer,
                candidateId: 0,
                candidatePatch: [],
                catalogObjectId: 0,
                catalogObjectPatch: [],
                catalogObjectCursorOffset: null,
            },
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(firstCursor),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;
        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).not.toBeNull();

        const secondCursor = editorState.doc.toString().indexOf('ttr');
        editorState = editorState.update({ selection: EditorSelection.cursor(secondCursor) }).state;
        editorState = editorState.update({
            changes: { from: secondCursor, insert: 'a' },
            selection: EditorSelection.cursor(secondCursor + 1),
            annotations: Transaction.userEvent.of('input.type'),
        }).state;

        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
    });

    it('does not restore a completion dismissed with Escape from a stale update', () => {
        const catalog = dql!.createCatalog();
        const schemaScript = dql!.createScript(catalog);
        schemaScript.insertTextAt(0, 'create table tableA("attrA" int)');
        schemaScript.analyze();
        catalog.loadScript(schemaScript, 0);

        const text = 'select * from tableA where att';
        const { scriptSession, editorUpdate } = createScriptSession(catalog, text);
        const processorState: DashQLProcessorUpdateIn = {
            scriptKey: 1,
            scriptSession,
            editorUpdate,
            scriptBuffers: null,
            scriptCompletion: null,
            scriptPendingDiff: null,
            derivedFocus: null,
            onUpdate: () => {},
        };
        let editorState = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(text.length),
            extensions: [DashQLProcessorPlugin],
        });
        editorState = editorState.update({ effects: DashQLUpdateEffect.of(processorState) }).state;
        editorState = editorState.update({
            changes: { from: text.length, insert: 'r' },
            selection: EditorSelection.cursor(text.length + 1),
            annotations: Transaction.userEvent.of('input.type'),
        }).state;

        const staleCompletion = editorState.field(DashQLProcessorPlugin).scriptCompletion;
        expect(staleCompletion).not.toBeNull();
        editorState = editorState.update({ effects: DashQLCompletionAbortEffect.of(null) }).state;
        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();

        const dismissedState = editorState.field(DashQLProcessorPlugin);
        editorState = editorState.update({
            effects: DashQLUpdateEffect.of({
                ...dismissedState,
                scriptCompletion: staleCompletion,
            }),
        }).state;

        expect(editorState.field(DashQLProcessorPlugin).scriptCompletion).toBeNull();
    });
});
