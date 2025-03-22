import * as dashql from '@ankoh/dashql-core';
import * as pb from '@ankoh/dashql-protobuf';

export function decodeCatalogFileFromProto(file: pb.dashql.file.FileCatalog): dashql.buffers.SchemaDescriptorsT {
    if (!file.catalog) {
        return new dashql.buffers.SchemaDescriptorsT();
    }
    let tableCount: number = 0;
    const schemas: dashql.buffers.SchemaDescriptorT[] = [];

    for (const dbReader of file.catalog.databases) {
        for (const schemaReader of dbReader.schemas) {
            const tables: dashql.buffers.SchemaTableT[] = [];
            for (const tableReader of schemaReader.tables) {
                const columns: dashql.buffers.SchemaTableColumnT[] = [];
                let ordinalPos = 0;
                for (const columnReader of tableReader.columns) {
                    const column = new dashql.buffers.SchemaTableColumnT(columnReader.name, ordinalPos++);
                    columns.push(column);
                }
                const tableId = tableCount++;
                const table = new dashql.buffers.SchemaTableT(tableId, tableReader.name, columns);
                tables.push(table);
            }
            const schema = new dashql.buffers.SchemaDescriptorT(dbReader.name, schemaReader.name, tables);
            schemas.push(schema);
        }
    }
    return new dashql.buffers.SchemaDescriptorsT(schemas);
}
