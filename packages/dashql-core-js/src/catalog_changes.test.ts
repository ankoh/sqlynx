import * as dashql from './index.js';

import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL;

beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await loadCoreWasm() });
});

afterEach(() => {
    dql.resetUnsafe();
});

const ChangeType = dashql.buffers.catalog.CatalogChangeType;

/// The tables of a catalog entry as `db.schema.table(a, b)`
function tablesOf(catalog: dashql.DashQLCatalog, entryId: number): string[] {
    const tables: string[] = [];
    for (const entry of catalog.describeEntriesOf(entryId).unpackAndDestroy().entries) {
        for (const schema of entry.schemas) {
            for (const table of schema.tables) {
                tables.push(`${schema.databaseName}.${schema.schemaName}.${table.tableName}(${table.columns.map(c => c.columnName).join(', ')})`);
            }
        }
    }
    return tables.sort();
}

/// Run a script statement by statement and collect the reported catalog changes
function runScript(text: string): dashql.buffers.catalog.CatalogChangeT[] {
    const session = dql.createScriptSession(dql.createCatalog());
    session.replaceText(0n, text);
    const execution = session.startExecution();
    const changes: dashql.buffers.catalog.CatalogChangeT[] = [];
    let update = execution.start();
    while (update.pendingStatement != null) {
        update = execution.resume(new dashql.buffers.execution.StatementResultT(
            update.pendingStatement.id,
            dashql.buffers.execution.StatementResultStatus.SUCCEEDED,
        ));
        changes.push(...update.catalogChanges);
    }
    execution.destroy();
    return dql.qualifyCatalogChanges(changes, { databaseName: 'db', schemaName: 'main' });
}

describe('Catalog changes', () => {
    it('are reported by the script execution and qualified with the defaults', () => {
        const changes = runScript('create table t (b int, a int); create table s.u as select 1 as x; drop table v; select 1');
        expect(changes.map(c => [c.changeType, c.databaseName, c.schemaName, c.relationName, c.columnNames])).toEqual([
            [ChangeType.CREATE_RELATION, 'db', 'main', 't', ['b', 'a']],
            [ChangeType.CREATE_RELATION, 'db', 's', 'u', ['x']],
            [ChangeType.DROP_RELATION, 'db', 'main', 'v', []],
        ]);
    });

    it('patch descriptor entries and roundtrip through SQL', () => {
        const changes = runScript('create table t (a int); create table u (b int); drop table t');
        const catalog = dql.createCatalog();
        const entryId = catalog.allocateEntryId();
        catalog.applyCatalogChanges(entryId, 10, changes);
        expect(tablesOf(catalog, entryId)).toEqual(['db.main.u(b)']);

        const changesSql = dql.appendCatalogChangesSql('', changes);
        expect(changesSql).toContain('CREATE TABLE "db"."main"."u"');
        expect(changesSql).toContain('DROP TABLE "db"."main"."t"');
        const restored = dql.createCatalog();
        const restoredId = restored.allocateEntryId();
        restored.applyCatalogChangesSql(restoredId, 10, changesSql);
        expect(tablesOf(restored, restoredId)).toEqual(['db.main.u(b)']);
        expect(() => restored.applyCatalogChangesSql(restoredId, 10, 'create table (')).toThrow();
    });
});
