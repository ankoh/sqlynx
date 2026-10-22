import * as dashql from '@ankoh/dashql-core';
import { Text } from '@codemirror/state';

import { deriveCompletionHints, InsertPatchWidget } from './dashql_completion_hint.js';
import { DashQLCompletionState, DashQLCompletionStatus } from './dashql_processor.js';
import { PATCH_INSERT_TEXT, CompletionPatchTarget, TextAnchor, computePatches } from './dashql_completion_patches.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await DASHQL_PRECOMPILED;
    dql = await dashql.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(async () => {
    dql!.resetUnsafe();
});

describe('Completion Hint', () => {
    it('does not increase the line height for an inline recommendation', () => {
        class TestInsertPatchWidget extends InsertPatchWidget {
            constructor() {
                super('select', 'completion-hint');
            }
        }

        const widget = new TestInsertPatchWidget();
        expect(widget.estimatedHeight).toBe(0);
        expect(widget.toDOM().style.lineHeight).toBe('0');
    });

    it('candidate hint quoting', async () => {
        const catalog = dql!.createCatalog();
        const schemaScriptPtr = dql!.createScript(catalog);
        const scriptPtr = dql!.createScript(catalog);

        schemaScriptPtr.insertTextAt(0, "create table tableA(\"attrA\" int)")
        schemaScriptPtr.analyze();
        catalog.loadScript(schemaScriptPtr, 0);

        const text = "select * from tableA where attr";
        scriptPtr.insertTextAt(0, text);
        scriptPtr.analyze();
        const cursor = scriptPtr.moveCursor(text.length);
        const completionPtr = scriptPtr.completeAtCursor(10);

        const completionReader = completionPtr.read()
        expect(completionReader.candidatesLength()).toEqual(10);
        const candidate = completionReader.candidates(0);
        expect(candidate?.completionText()).toEqual("\"attrA\"");

        // Compute completion hints
        const textBuffer = Text.of([text]);
        let completionState: DashQLCompletionState = {
            status: DashQLCompletionStatus.AVAILABLE,
            passiveHint: false,
            buffer: completionPtr,
            candidateId: 0,
            candidatePatch: [],
            catalogObjectId: 0,
            catalogObjectPatch: [],
            catalogObjectCursorOffset: null,
        };
        completionState = computePatches(completionState, textBuffer, text.length);
        const hints = deriveCompletionHints(completionState);

        // Check candidate hint
        expect(hints!.candidateHints.length).toEqual(2);
        expect(hints!.candidateHints[0]).toEqual({
            controls: false,
            target: CompletionPatchTarget.Candidate,
            type: PATCH_INSERT_TEXT,
            value: {
                at: text.length - "attr".length,
                text: "\"",
                textAnchor: TextAnchor.Right,
            }
        });
        expect(hints!.candidateHints[1]).toEqual({
            controls: true,
            target: CompletionPatchTarget.Candidate,
            type: PATCH_INSERT_TEXT,
            value: {
                at: text.length,
                text: "A\"",
                textAnchor: TextAnchor.Left,
            }
        });
    });

    it('candidate qualification', async () => {
        const catalog = dql!.createCatalog();
        const schemaScriptPtr = dql!.createScript(catalog);
        const scriptPtr = dql!.createScript(catalog);

        schemaScriptPtr.insertTextAt(0, "create table db0.schema0.\"tableA\"(\"attrA\" int)")
        schemaScriptPtr.analyze();
        catalog.loadScript(schemaScriptPtr, 0);

        const text = "select * from tab";
        scriptPtr.insertTextAt(0, text);
        scriptPtr.analyze();
        const cursor = scriptPtr.moveCursor(text.search(" tab") + 4);
        const completionPtr = scriptPtr.completeAtCursor(10);

        const completionReader = completionPtr.read()
        expect(completionReader.candidatesLength()).toEqual(10);
        const candidate = completionReader.candidates(0);
        expect(candidate?.completionText()).toEqual("\"tableA\"");

        // Compute completion hints
        const textBuffer = Text.of([text]);
        let completionState: DashQLCompletionState = {
            status: DashQLCompletionStatus.AVAILABLE,
            passiveHint: false,
            buffer: completionPtr,
            candidateId: 0,
            candidatePatch: [],
            catalogObjectId: 0,
            catalogObjectPatch: [],
            catalogObjectCursorOffset: null,
        };
        completionState = computePatches(completionState, textBuffer, text.length);
        const hints = deriveCompletionHints(completionState);

        // Check candidate hint
        expect(hints!.candidateHints.length).toEqual(2);
        expect(hints!.candidateHints[0]).toEqual({
            controls: false,
            target: CompletionPatchTarget.Candidate,
            type: PATCH_INSERT_TEXT,
            value: {
                at: text.length - "tab".length,
                text: "\"",
                textAnchor: TextAnchor.Right,
            }
        });
        expect(hints!.candidateHints[1]).toEqual({
            controls: true,
            target: CompletionPatchTarget.Candidate,
            type: PATCH_INSERT_TEXT,
            value: {
                at: text.length,
                text: "leA\"",
                textAnchor: TextAnchor.Left,
            }
        });

        // Tables in attached, non-default databases are completed with their
        // database and schema so the resulting query resolves unambiguously.
        expect(hints!.catalogObjectHints).toEqual([{
            controls: true,
            target: CompletionPatchTarget.CatalogObject,
            type: PATCH_INSERT_TEXT,
            value: {
                at: text.length - "tab".length,
                text: "db0.schema0.",
                textAnchor: TextAnchor.Left,
            },
        }]);
    });


    it.skip('use candidate as is', async () => {
        const catalog = dql!.createCatalog();
        const schemaScriptPtr = dql!.createScript(catalog);
        const scriptPtr = dql!.createScript(catalog);

        schemaScriptPtr.insertTextAt(0, "create table db0.schema0.\"tableA\"(\"attrA\" int)")
        schemaScriptPtr.analyze();
        catalog.loadScript(schemaScriptPtr, 0);

        const text = "select * from \"tableA\"";
        scriptPtr.insertTextAt(0, text);
        scriptPtr.analyze();
        const cursor = scriptPtr.moveCursor(text.search("\"tableA\"") + 4);
        const completionPtr = scriptPtr.completeAtCursor(10);

        const completionReader = completionPtr.read()
        expect(completionReader.candidatesLength()).toEqual(10);
        const candidate = completionReader.candidates(0);
        expect(candidate?.completionText()).toEqual("\"tableA\"");

        // Compute completion hints
        const textBuffer = Text.of([text]);
        let completionState: DashQLCompletionState = {
            status: DashQLCompletionStatus.AVAILABLE,
            passiveHint: false,
            buffer: completionPtr,
            candidateId: 0,
            candidatePatch: [],
            catalogObjectId: 0,
            catalogObjectPatch: [],
            catalogObjectCursorOffset: null,
        };
        completionState = computePatches(completionState, textBuffer, text.search("\"tableA\"") + 4);
        const hints = deriveCompletionHints(completionState);

        // Check candidate hint.
        // This time, the candidate can be used as is
        expect(hints!.candidateHints.length).toEqual(0);

        // Check qualification hint
        expect(hints!.catalogObjectHints.length).toEqual(1);
        expect(hints!.catalogObjectHints[0]).toEqual({
            controls: true,
            target: CompletionPatchTarget.CatalogObject,
            type: PATCH_INSERT_TEXT,
            value: {
                at: text.length - "tab".length,
                text: "db0.schema0.",
                textAnchor: TextAnchor.Right,
            }
        });
    });
});
