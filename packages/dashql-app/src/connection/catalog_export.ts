import * as dashql from '@ankoh/dashql-core';
import * as pb from '@ankoh/dashql-protobuf';

export function encodeCatalogAsProto(snap: dashql.DashQLCatalogSnapshot): pb.dashql.catalog.Catalog {
    const snapReader = snap.read();

    const databases: pb.dashql.catalog.CatalogDatabase[] = [];
    const schemas: pb.dashql.catalog.CatalogSchema[] = [];
    const tables: pb.dashql.catalog.CatalogTable[] = [];
    const columns: pb.dashql.catalog.CatalogColumn[] = [];

    const tmpEntry = new dashql.buffers.FlatCatalogEntry();
    for (let i = 0; i < snapReader.catalogReader.databasesLength(); ++i) {
        const entry = snapReader.catalogReader.databases(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        databases.push(new pb.dashql.catalog.CatalogDatabase({ name }));
    }
    for (let i = 0; i < snapReader.catalogReader.schemasLength(); ++i) {
        const entry = snapReader.catalogReader.schemas(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        const schema = new pb.dashql.catalog.CatalogSchema({ name });
        schemas.push(schema);
        databases[entry.flatParentIdx()].schemas.push(schema);
    }
    for (let i = 0; i < snapReader.catalogReader.tablesLength(); ++i) {
        const entry = snapReader.catalogReader.tables(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        const table = new pb.dashql.catalog.CatalogTable({ name });
        tables.push(table);
        schemas[entry.flatParentIdx()].tables.push(table);
    }
    for (let i = 0; i < snapReader.catalogReader.columnsLength(); ++i) {
        const entry = snapReader.catalogReader.columns(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        const column = new pb.dashql.catalog.CatalogColumn({ name });
        columns.push(column);
        tables[entry.flatParentIdx()].columns.push(column);
    }

    const out = new pb.dashql.catalog.Catalog({ databases });
    return out;
}

