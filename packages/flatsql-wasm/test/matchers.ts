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
    for (let i = 0; i < tables.length; ++i) {
        const table = analyzed.tables(i)!;
        const tableName = table.tableName()!;
        const resolvedName = flatsql.FlatID.readTableName(tableName, parsed);
        expect(resolvedName).toEqual({
            database: null,
            schema: null,
            table: tables[i].name,
        });
        for (let j = 0; j < tables[i].columns.length; ++j) {
            expect(j).toBeLessThan(table.columnCount());
            const column = analyzed.tableColumns(table.columnsBegin() + j)!;
            const columnName = flatsql.FlatID.readName(column.columnName(), parsed);
            expect(columnName).toEqual(tables[i].columns[j]);
        }
    }
}
