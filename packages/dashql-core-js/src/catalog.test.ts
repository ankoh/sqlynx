import * as dashql from './index.js';

import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL;

beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await loadCoreWasm() });
});

afterEach(() => {
    dql.resetUnsafe();
});

describe('DashQLCatalog', () => {
    it('loads ranked relation and function scripts as one catalog generation', () => {
        const catalog = dql.createCatalog();
        const relations = dql.createScript(catalog);
        const functions = dql.createScript(catalog);
        relations.insertTextAt(0, 'create table db.schema.items(id int);');
        functions.insertTextAt(0, 'create function db.schema.item_count() returns int;');
        relations.analyze();
        functions.analyze();
        const previousVersion = catalog.createSnapshot().read().catalogReader.catalogVersion();

        catalog.loadScripts([[relations, 20], [functions, 10]]);

        const snapshot = catalog.createSnapshot().read().catalogReader;
        expect(snapshot.catalogVersion()).toBe(previousVersion + 1n);
        expect(snapshot.tablesLength()).toBe(1);
        expect(catalog.containsEntryId(relations.getCatalogEntryId())).toBeTruthy();
        expect(catalog.containsEntryId(functions.getCatalogEntryId())).toBeTruthy();
    });
});
