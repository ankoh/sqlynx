import * as core from '@ankoh/dashql-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    buildCatalogNameIndex,
    CatalogNameIndex,
    CatalogNameKind,
    collectMentionedIdentifiers,
    findIdentifierMatches,
    lookupIdentifier,
    lookupPrefix,
} from './catalog_name_index.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: core.DashQL;
let catalog: core.DashQLCatalog;
let index: CatalogNameIndex;
beforeAll(async () => {
    dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
    catalog = dql.createCatalog();
    const schema = dql.createScript(catalog);
    schema.replaceText('create table orders (amount int, customer_name text, id int); create table customers (id int, name text, top int);');
    schema.analyze();
    catalog.loadScript(schema, 0);
    index = buildCatalogNameIndex(catalog.createSnapshot().read());
});
afterAll(() => {
    catalog.destroy();
    dql.resetUnsafe();
});

describe('Catalog name index', () => {
    it('finds tables and columns ignoring case', () => {
        expect(lookupIdentifier(index, 'Orders')).toEqual([{ name: 'orders', kind: CatalogNameKind.Table, table: null }]);
        expect(lookupIdentifier(index, 'amount')).toEqual([{ name: 'amount', kind: CatalogNameKind.Column, table: 'orders' }]);
        expect(lookupIdentifier(index, 'name')).toEqual([{ name: 'name', kind: CatalogNameKind.Column, table: 'customers' }]);
    });

    it('ignores short words and function words', () => {
        expect(lookupIdentifier(index, 'id')).toBeNull();
        expect(lookupIdentifier(index, 'top')).toBeNull();
    });

    it('resolves qualified columns only within their table', () => {
        expect(lookupIdentifier(index, 'orders.amount')).toEqual([{ name: 'amount', kind: CatalogNameKind.Column, table: 'orders' }]);
        expect(lookupIdentifier(index, 'customers.amount')).toBeNull();
        expect(lookupIdentifier(index, 'orders.id')).toEqual([{ name: 'id', kind: CatalogNameKind.Column, table: 'orders' }]);
    });

    it('finds distinct names by prefix', () => {
        expect(lookupPrefix(index, 'cust', 10)).toEqual(['customer_name', 'customers']);
        expect(lookupPrefix(index, 'CUST', 1)).toEqual(['customer_name']);
        expect(lookupPrefix(index, 'zzz', 10)).toEqual([]);
    });

    it('locates and describes the mentioned identifiers', () => {
        const text = 'the amount of orders by customers.name';
        expect(findIdentifierMatches(index, text).map(match => text.substring(match.from, match.to)))
            .toEqual(['amount', 'orders', 'customers.name']);
        expect(collectMentionedIdentifiers(index, text)).toEqual([
            'amount (column of orders)',
            'orders (table)',
            'name (column of customers)',
        ]);
    });
});
