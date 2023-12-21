import * as sqlynx from '../src';

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
    _parsed: sqlynx.proto.ParsedScript,
    analyzed: sqlynx.proto.AnalyzedScript,
    tables: TestTable[],
) {
    expect(analyzed.tablesLength()).toEqual(tables.length);
    for (let i = 0; i < tables.length; ++i) {
        const table = analyzed.tables(i)!;
        const tableName = table.tableName()!;
        expect(tableName.tableName()).toEqual(tables[i].name);
        for (let j = 0; j < tables[i].columns.length; ++j) {
            expect(j).toBeLessThan(table.columnCount());
            const column = analyzed.tableColumns(table.columnsBegin() + j)!;
            const columnName = column.columnName();
            expect(columnName).toEqual(tables[i].columns[j]);
        }
    }
}
