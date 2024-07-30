import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

let lnx: sqlynx.SQLynx | null = null;

beforeAll(async () => {
    lnx = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(lnx).not.toBeNull();
});

describe('Catalog Tests ', () => {
    it('clear catalog', () => {
        const catalog = lnx!.createCatalog();
        catalog.addDescriptorPool(1, 10);
        catalog.addSchemaDescriptorT(
            1,
            new sqlynx.proto.SchemaDescriptorT('db1', 'schema1', [
                new sqlynx.proto.SchemaTableT(0, 'table1', [
                    new sqlynx.proto.SchemaTableColumnT('column1'),
                    new sqlynx.proto.SchemaTableColumnT('column2'),
                    new sqlynx.proto.SchemaTableColumnT('column3'),
                ]),
            ]),
        );
        let descriptionBuffer = catalog.describeEntries();
        let description = descriptionBuffer.read(new sqlynx.proto.CatalogEntries());
        expect(description.entriesLength()).toEqual(1);
        descriptionBuffer.delete();

        descriptionBuffer = catalog.describeEntriesOf(1);
        description = descriptionBuffer.read(new sqlynx.proto.CatalogEntries());
        expect(description.entriesLength()).toEqual(1);
        descriptionBuffer.delete();

        catalog.clear();

        descriptionBuffer = catalog.describeEntries();
        description = descriptionBuffer.read(new sqlynx.proto.CatalogEntries());
        expect(description.entriesLength()).toEqual(0);
        descriptionBuffer.delete();
    });

    it('dynamic registration', () => {
        const catalog = lnx!.createCatalog();
        catalog.addDescriptorPool(1, 10);

        // Create and analyze a script referencing an unknown query_result
        const script = lnx!.createScript(catalog, 2);
        script.replaceText('select * from db1.schema1.table1');
        script.scan().delete();
        script.parse().delete();
        let analyzedBuffer = script.analyze();
        let analyzed = analyzedBuffer.read(new sqlynx.proto.AnalyzedScript());
        expect(analyzed.tableReferencesLength()).toEqual(1);

        // The analyzed script contains an unresolved query_result ref
        const tableRef = analyzed.tableReferences(0)!;
        let resolved = tableRef.resolvedTableId();
        expect(sqlynx.ExternalObjectID.isNull(resolved)).toBeTruthy();

        // Check the query_result name
        const tableName = tableRef.tableName(new sqlynx.proto.QualifiedTableName())!;
        expect(tableName.databaseName()).toEqual('db1');
        expect(tableName.schemaName()).toEqual('schema1');
        expect(tableName.tableName()).toEqual('table1');
        analyzedBuffer.delete();

        // Resolve the query_result declaration and add a schema descriptor to the descriptor pool
        catalog.addSchemaDescriptorT(
            1,
            new sqlynx.proto.SchemaDescriptorT('db1', 'schema1', [
                new sqlynx.proto.SchemaTableT(0, 'table1', [
                    new sqlynx.proto.SchemaTableColumnT('column1'),
                    new sqlynx.proto.SchemaTableColumnT('column2'),
                    new sqlynx.proto.SchemaTableColumnT('column3'),
                ]),
            ]),
        );

        // Now analyze the script again
        script.parse().delete();
        analyzedBuffer = script.analyze();
        analyzed = analyzedBuffer.read(new sqlynx.proto.AnalyzedScript());
        expect(analyzed.tableReferencesLength()).toEqual(1);
        resolved = tableRef.resolvedTableId();
        expect(sqlynx.ExternalObjectID.isNull(resolved)).toBeFalsy();

        // Delete all the memory
        analyzedBuffer.delete();
        script.delete();
        catalog.delete();
    });

    it('tpch flattening', () => {
        const catalog = lnx!.createCatalog();

        const schemaScript = lnx!.createScript(catalog, 1);
        schemaScript.insertTextAt(0, `
create table part (
   p_partkey integer not null,
   p_name varchar(55) not null,
   p_mfgr char(25) not null,
   p_brand char(10) not null,
   p_type varchar(25) not null,
   p_size integer not null,
   p_container char(10) not null,
   p_retailprice decimal(12,2) not null,
   p_comment varchar(23) not null,
   primary key (p_partkey)
);

create table supplier (
   s_suppkey integer not null,
   s_name char(25) not null,
   s_address varchar(40) not null,
   s_nationkey integer not null,
   s_phone char(15) not null,
   s_acctbal decimal(12,2) not null,
   s_comment varchar(101) not null,
   primary key (s_suppkey)
);

create table partsupp (
   ps_partkey integer not null,
   ps_suppkey integer not null,
   ps_availqty integer not null,
   ps_supplycost decimal(12,2) not null,
   ps_comment varchar(199) not null,
   primary key (ps_partkey,ps_suppkey)
);

create table customer (
   c_custkey integer not null,
   c_name varchar(25) not null,
   c_address varchar(40) not null,
   c_nationkey integer not null,
   c_phone char(15) not null,
   c_acctbal decimal(12,2) not null,
   c_mktsegment char(10) not null,
   c_comment varchar(117) not null,
   primary key (c_custkey)
);

create table orders (
   o_orderkey integer not null,
   o_custkey integer not null,
   o_orderstatus char(1) not null,
   o_totalprice decimal(12,2) not null,
   o_orderdate date not null,
   o_orderpriority char(15) not null,
   o_clerk char(15) not null,
   o_shippriority integer not null,
   o_comment varchar(79) not null,
   primary key (o_orderkey)
);

create table lineitem (
   l_orderkey integer not null,
   l_partkey integer not null,
   l_suppkey integer not null,
   l_linenumber integer not null,
   l_quantity decimal(12,2) not null,
   l_extendedprice decimal(12,2) not null,
   l_discount decimal(12,2) not null,
   l_tax decimal(12,2) not null,
   l_returnflag char(1) not null,
   l_linestatus char(1) not null,
   l_shipdate date not null,
   l_commitdate date not null,
   l_receiptdate date not null,
   l_shipinstruct char(25) not null,
   l_shipmode char(10) not null,
   l_comment varchar(44) not null,
   primary key (l_orderkey,l_linenumber)
);

create table nation (
   n_nationkey integer not null,
   n_name char(25) not null,
   n_regionkey integer not null,
   n_comment varchar(152) not null,
   primary key (n_nationkey)
);

create table region (
   r_regionkey integer not null,
   r_name char(25) not null,
   r_comment varchar(152) not null,
   primary key (r_regionkey)
);
        `);
        schemaScript.scan().delete();
        schemaScript.parse().delete();
        schemaScript.analyze().delete();

        catalog.loadScript(schemaScript, 0);

        const snapPtr = catalog.createSnapshot();
        const snap = snapPtr.read();
        expect(snap.catalogReader.databasesLength()).toEqual(1);
        expect(snap.catalogReader.schemasLength()).toEqual(1);
        expect(snap.catalogReader.tablesLength()).toEqual(8);
        expect(snap.catalogReader.columnsLength()).toEqual(61);

        const db = snap.catalogReader.databases(0)!;
        expect(db.childBegin()).toEqual(0);
        expect(db.childCount()).toEqual(1);
        expect(snap.readName(db.nameId())).toEqual("sqlynx");

        const schema = snap.catalogReader.schemas(0)!;
        expect(schema.parentId()).toEqual(0);
        expect(schema.childBegin()).toEqual(0);
        expect(schema.childCount()).toEqual(8);
        expect(snap.readName(schema.nameId())).toEqual("default");

        const tableNames = [
            "customer",
            "lineitem",
            "nation",
            "orders",
            "part",
            "partsupp",
            "region",
            "supplier",
        ];

        for (let i = 0; i < 8; ++i) {
            const table = snap.catalogReader.tables(i)!;
            expect(table.parentId()).toEqual(0);
            expect(snap.readName(table.nameId())).toEqual(tableNames[i]);
        }

        snapPtr.delete();
        schemaScript.delete();
        catalog.delete();
    });
});
