import * as core from '@ankoh/dashql-core';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildCatalogNameIndex, CatalogNameIndex } from '../../ai/catalog_name_index.js';
import { NLIdentifierExtensions, NLIdentifierHintField, NLIdentifierIndex, NLIdentifierIndexEffect } from './nl_identifier_plugin.js';

import * as styles from './nl_identifier_plugin.module.css';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: core.DashQL;
let catalog: core.DashQLCatalog;
let index: CatalogNameIndex;
beforeAll(async () => {
    dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
    catalog = dql.createCatalog();
    const schema = dql.createScript(catalog);
    schema.replaceText([
        'create table orders (amount int, customer_name text);',
        'create table customers (id int, name text, region text);',
        'create table metrics (metric_a int, metric_b int, metric_c int, metric_d int, metric_e int, metric_f int);',
    ].join('\n'));
    schema.analyze();
    catalog.loadScript(schema, 0);
    index = buildCatalogNameIndex(catalog);
});
afterAll(() => {
    catalog.destroy();
    dql.resetUnsafe();
});

describe('Natural language identifiers', () => {
    let view: EditorView;
    beforeEach(() => {
        view = new EditorView({
            state: EditorState.create({ extensions: [NLIdentifierIndex, ...NLIdentifierExtensions] }),
            parent: document.body,
        });
        view.dispatch({ effects: NLIdentifierIndexEffect.of(index) });
    });
    afterEach(() => view.destroy());

    const type = (text: string) => view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length },
        userEvent: 'input.type',
    });
    const press = (key: string) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const highlighted = () => Array.from(view.contentDOM.querySelectorAll(`.${styles.identifier_table}, .${styles.identifier_column}`))
        .map(element => element.textContent);
    const hint = () => view.state.field(NLIdentifierHintField);

    it('highlights finished identifiers only', () => {
        type('total amount of orders');
        expect(highlighted()).toEqual(['amount']);
        type(' ');
        expect(highlighted()).toEqual(['amount', 'orders']);
    });

    it('never highlights function words', () => {
        type('show the region of all customers ');
        expect(highlighted()).toEqual(['region', 'customers']);
    });

    it('hints a completion late and accepts it with Tab', () => {
        type('total ord');
        expect(hint()).toBeNull();
        type('e');
        expect(hint()).toEqual({ cursor: 10, insert: 'rs' });
        press('Tab');
        expect(view.state.doc.toString()).toBe('total orders');
        expect(hint()).toBeNull();
    });

    it('prefers the columns of mentioned tables', () => {
        type('orders by cus');
        expect(hint()).toBeNull();
        type('t');
        expect(hint()?.insert).toBe('omer_name');
    });

    it('completes qualified columns from the first character', () => {
        type('customers.r');
        expect(hint()?.insert).toBe('egion');
    });

    it('hints nothing for ambiguous prefixes or without typing', () => {
        type('metric');
        expect(hint()).toBeNull();
        type(' orde');
        expect(hint()).not.toBeNull();
        view.dispatch({ selection: { anchor: 0 } });
        expect(hint()).toBeNull();
    });

    it('drops the hint with Escape', () => {
        type('orde');
        expect(hint()).not.toBeNull();
        press('Escape');
        expect(hint()).toBeNull();
        expect(view.state.doc.toString()).toBe('orde');
    });
});
