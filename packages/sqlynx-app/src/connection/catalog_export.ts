import * as sqlynx from '@ankoh/sqlynx-core';
import * as proto from '@ankoh/sqlynx-protobuf';

export function encodeCatalogAsProto(snap: sqlynx.SQLynxCatalogSnapshot): proto.sqlynx_catalog.pb.Catalog {
    const snapReader = snap.read();

    const databases: proto.sqlynx_catalog.pb.CatalogDatabase[] = [];
    const schemas: proto.sqlynx_catalog.pb.CatalogSchema[] = [];
    const tables: proto.sqlynx_catalog.pb.CatalogTable[] = [];
    const columns: proto.sqlynx_catalog.pb.CatalogColumn[] = [];

    const tmpEntry = new sqlynx.proto.FlatCatalogEntry();
    for (let i = 0; i < snapReader.catalogReader.databasesLength(); ++i) {
        const entry = snapReader.catalogReader.databases(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        databases.push(new proto.sqlynx_catalog.pb.CatalogDatabase({ name }));
    }
    for (let i = 0; i < snapReader.catalogReader.schemasLength(); ++i) {
        const entry = snapReader.catalogReader.schemas(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        const schema = new proto.sqlynx_catalog.pb.CatalogSchema({ name });
        schemas.push(schema);
        databases[entry.flatParentIdx()].schemas.push(schema);
    }
    for (let i = 0; i < snapReader.catalogReader.tablesLength(); ++i) {
        const entry = snapReader.catalogReader.tables(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        const table = new proto.sqlynx_catalog.pb.CatalogTable({ name });
        tables.push(table);
        schemas[entry.flatParentIdx()].tables.push(table);
    }
    for (let i = 0; i < snapReader.catalogReader.columnsLength(); ++i) {
        const entry = snapReader.catalogReader.columns(i, tmpEntry)!;
        const name = snapReader.readName(entry.nameId());
        const column = new proto.sqlynx_catalog.pb.CatalogColumn({ name });
        columns.push(column);
        tables[entry.flatParentIdx()].columns.push(column);
    }

    const out = new proto.sqlynx_catalog.pb.Catalog({ databases });
    return out;
}

