import * as dashql from '@ankoh/dashql-core';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createReadonlyCodeMirrorExtensions } from '../scripts/editor/codemirror.js';
import { DashQLProcessorPlugin } from '../scripts/editor/dashql_processor.js';
import { updateCatalogScriptEditor } from './catalog_script_card.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL;
beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});
afterEach(() => dql.resetUnsafe());

describe('catalog script card', () => {
    it.each([
        ['relations', 'CREATE TABLE "default"."public"."items" ("id" bigint);'],
        ['functions', 'CREATE FUNCTION "default"."public"."answer"() RETURNS bigint;'],
    ])('projects syntax highlighting for %s', (_name, text) => {
        const catalog = dql.createCatalog();
        const script = dql.createScript(catalog);
        script.replaceText(text);
        script.analyze();
        const view = new EditorView({
            state: EditorState.create({ extensions: createReadonlyCodeMirrorExtensions() }),
            parent: document.body,
        });
        try {
            updateCatalogScriptEditor(view, script, text);

            const projection = view.state.field(DashQLProcessorPlugin).editorUpdate;
            expect(projection?.syntaxSpans.length).toBeGreaterThan(0);
            const createKeyword = Array.from(view.dom.querySelectorAll('span'))
                .find(node => node.textContent?.toLowerCase() === 'create');
            expect(createKeyword?.className).not.toBe('');
            expect(getComputedStyle(createKeyword!).color).not.toBe('rgb(61, 61, 61)');
        } finally {
            view.destroy();
            script.destroy();
            catalog.destroy();
        }
    });
});
