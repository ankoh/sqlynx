import * as dashql from '@ankoh/dashql-core';

import { EditorState } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import {
    buildDecorationsForRanges,
    commentTag,
    DashQLScannerDecorationUpdateEffect,
    DashQLStandaloneScannerDecorationPlugin,
} from './dashql_decorations_standalone.js';
import { xcodeLight } from './themes/xcode.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});
afterEach(() => dql!.resetUnsafe());

describe('scanner decorations', () => {
    it('highlights comments from the separate comment spans', () => {
        const text = '-- leading comment\nselect /* middle comment */ 1';
        const catalog = dql!.createCatalog();
        const script = dql!.createScript(catalog);
        script.insertTextAt(0, text);
        script.analyze();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, text);
        const update = session.analyze();
        const state = EditorState.create({
            doc: text,
            extensions: syntaxHighlighting(HighlightStyle.define([{ tag: commentTag, class: 'comment' }])),
        });

        const ranges: Array<{ from: number; to: number }> = [];
        buildDecorationsForRanges(state, update, [{ from: 0, to: text.length }]).between(
            0,
            text.length,
            (from, to, value) => {
                if (value.spec.class.split(' ').includes('comment')) ranges.push({ from, to });
            },
        );

        expect(ranges).toEqual([
            { from: 0, to: '-- leading comment'.length },
            { from: text.indexOf('/*'), to: text.indexOf('*/') + 2 },
        ]);
        session.destroy();
        script.destroy();
        catalog.destroy();
    });

    it('highlights relation and function identifiers', () => {
        const text = 'select util.read_parquet(path) from db.public.items';
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, text);
        const update = session.analyze();
        const state = EditorState.create({
            doc: text,
            extensions: syntaxHighlighting(HighlightStyle.define([
                { tag: tags.name, class: 'identifier' },
                { tag: tags.keyword, class: 'keyword' },
                { tag: tags.typeName, class: 'relation' },
                { tag: tags.function(tags.variableName), class: 'function' },
            ])),
        });

        const highlighted = new Map<string, string>();
        buildDecorationsForRanges(state, update, [{ from: 0, to: text.length }]).between(
            0,
            text.length,
            (from, to, value) => {
                highlighted.set(text.slice(from, to), value.spec.class);
            },
        );

        expect(highlighted.get('util')).toBe('function');
        expect(highlighted.get('read_parquet')).toBe('function');
        expect(highlighted.get('db')).toBe('relation');
        expect(highlighted.get('public')).toBe('relation');
        expect(highlighted.get('items')).toBe('relation');
        session.destroy();
        catalog.destroy();
    });

    it('renders relation and function colors with the production theme', () => {
        const text = 'select read_parquet(path) from items';
        const catalog = dql!.createCatalog();
        const session = dql!.createScriptSession(catalog);
        session.replaceText(0n, text);
        const update = session.analyze();
        const view = new EditorView({
            state: EditorState.create({
                doc: text,
                extensions: [xcodeLight, DashQLStandaloneScannerDecorationPlugin],
            }),
            parent: document.body,
        });
        view.dispatch({ effects: DashQLScannerDecorationUpdateEffect.of(update) });

        const functionNode = Array.from(view.dom.querySelectorAll('span')).find(node => node.textContent === 'read_parquet');
        const relationNode = Array.from(view.dom.querySelectorAll('span')).find(node => node.textContent === 'items');
        expect(functionNode?.className).not.toBe('');
        expect(relationNode?.className).not.toBe('');
        expect(getComputedStyle(functionNode!).color).not.toBe('rgb(61, 61, 61)');
        expect(getComputedStyle(relationNode!).color).not.toBe('rgb(61, 61, 61)');
        view.destroy();
        session.destroy();
        catalog.destroy();
    });
});
