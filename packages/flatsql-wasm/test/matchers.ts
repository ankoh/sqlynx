import * as flatsql from '../src';

interface TestTable {
    name: string;
    columns: string[];
}

export function table(name: string, columns: string[] = []): TestTable {
    return {
        name,
        columns,
    };
}

export function expectTables(
    parsed: flatsql.proto.ParsedScript,
    analyzed: flatsql.proto.AnalyzedScript,
    tables: TestTable[],
) {
    expect(analyzed.tablesLength()).toEqual(tables.length);
    for (let i = 0; i < tables.length; ++i) {
        const table = analyzed.tables(i)!;
        const tableName = table.tableName()!;
        const parsedScripts = {
            [parsed.contextId()]: parsed,
        };
        const resolvedName = flatsql.QualifiedID.readTableName(tableName, parsedScripts);
        expect(resolvedName).toEqual({
            database: null,
            schema: null,
            table: tables[i].name,
        });
        for (let j = 0; j < tables[i].columns.length; ++j) {
            expect(j).toBeLessThan(table.columnCount());
            const column = analyzed.tableColumns(table.columnsBegin() + j)!;
            const columnName = flatsql.QualifiedID.readName(column.columnName(), parsedScripts);
            expect(columnName).toEqual(tables[i].columns[j]);
        }
    }
}
