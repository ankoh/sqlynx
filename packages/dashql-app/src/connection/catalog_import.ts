import * as dashql from '@ankoh/dashql-core';
import * as pb from '@ankoh/dashql-protobuf';

export function decodeCatalogFileFromProto(file: pb.dashql.file.FileCatalog): dashql.proto.SchemaDescriptorsT {
    if (!file.catalog) {
        return new dashql.proto.SchemaDescriptorsT();
    }
    let tableCount: number = 0;
    const schemas: dashql.proto.SchemaDescriptorT[] = [];

    for (const dbReader of file.catalog.databases) {
        for (const schemaReader of dbReader.schemas) {
            const tables: dashql.proto.SchemaTableT[] = [];
            for (const tableReader of schemaReader.tables) {
                const columns: dashql.proto.SchemaTableColumnT[] = [];
                let ordinalPos = 0;
                for (const columnReader of tableReader.columns) {
                    const column = new dashql.proto.SchemaTableColumnT(columnReader.name, ordinalPos++);
                    columns.push(column);
                }
                const tableId = tableCount++;
                const table = new dashql.proto.SchemaTableT(tableId, tableReader.name, columns);
                tables.push(table);
            }
            const schema = new dashql.proto.SchemaDescriptorT(dbReader.name, schemaReader.name, tables);
            schemas.push(schema);
        }
    }
    return new dashql.proto.SchemaDescriptorsT(schemas);
}
