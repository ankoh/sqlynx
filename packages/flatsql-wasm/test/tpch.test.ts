import '@jest/globals';

import * as flatsql from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './flatsql.wasm');

let fsql: flatsql.FlatSQL | null = null;

beforeAll(async () => {
    fsql = await flatsql.FlatSQL.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(fsql).not.toBeNull();
});

const TPCH_SCHEMA = `
create table part (p_partkey integer not null, p_name varchar(55) not null, p_mfgr char(25) not null, p_brand char(10) not null, p_type varchar(25) not null, p_size integer not null, p_container char(10) not null, p_retailprice decimal(12,2) not null, p_comment varchar(23) not null, primary key (p_partkey));
create table supplier (s_suppkey integer not null, s_name char(25) not null, s_address varchar(40) not null, s_nationkey integer not null, s_phone char(15) not null, s_acctbal decimal(12,2) not null, s_comment varchar(101) not null, primary key (s_suppkey));
create table partsupp (ps_partkey integer not null, ps_suppkey integer not null, ps_availqty integer not null, ps_supplycost decimal(12,2) not null, ps_comment varchar(199) not null, primary key (ps_partkey,ps_suppkey));
create table customer (c_custkey integer not null, c_name varchar(25) not null, c_address varchar(40) not null, c_nationkey integer not null, c_phone char(15) not null, c_acctbal decimal(12,2) not null, c_mktsegment char(10) not null, c_comment varchar(117) not null, primary key (c_custkey));
create table orders (o_orderkey integer not null, o_custkey integer not null, o_orderstatus char(1) not null, o_totalprice decimal(12,2) not null, o_orderdate date not null, o_orderpriority char(15) not null, o_clerk char(15) not null, o_shippriority integer not null, o_comment varchar(79) not null, primary key (o_orderkey));
create table lineitem (l_orderkey integer not null, l_partkey integer not null, l_suppkey integer not null, l_linenumber integer not null, l_quantity decimal(12,2) not null, l_extendedprice decimal(12,2) not null, l_discount decimal(12,2) not null, l_tax decimal(12,2) not null, l_returnflag char(1) not null, l_linestatus char(1) not null, l_shipdate date not null, l_commitdate date not null, l_receiptdate date not null, l_shipinstruct char(25) not null, l_shipmode char(10) not null, l_comment varchar(44) not null, primary key (l_orderkey,l_linenumber));
create table nation (n_nationkey integer not null, n_name char(25) not null, n_regionkey integer not null, n_comment varchar(152) not null, primary key (n_nationkey));
create table region (r_regionkey integer not null, r_name char(25) not null, r_comment varchar(152) not null, primary key (r_regionkey));`;

describe('FlatSQL TPCH Parsing', () => {
    it(`Schema`, () => {
        const text = TPCH_SCHEMA;
        const script = fsql!.createScript();
        script.insertTextAt(0, text);

        // Parse the script
        const parserResult = script.parse();
        const parsedScript = parserResult.read(new flatsql.proto.ParsedScript());
        expect(parsedScript.statementsLength()).toEqual(8);
        for (let i = 0; i < 8; ++i) {
            expect(parsedScript.statements(0)!.statementType()).toEqual(flatsql.proto.StatementType.CREATE_TABLE);
        }
        expect(parsedScript.errorsLength()).toEqual(0);

        // Analyze the script
        const analyzerResult = script.analyze();
        const analyzedScript = analyzerResult.read(new flatsql.proto.AnalyzedScript());
        expect(analyzedScript.tablesLength()).toEqual(8);

        // Test tables
        const table = (name: string, columns: string[] = []) => ({
            name,
            columns,
        });
        const expectedTables = [
            table('part', [
                'p_partkey',
                'p_name',
                'p_mfgr',
                'p_brand',
                'p_type',
                'p_size',
                'p_container',
                'p_retailprice',
                'p_comment',
            ]),
            table('supplier'),
            table('partsupp'),
            table('customer'),
            table('orders'),
            table('lineitem'),
            table('nation'),
            table('region'),
        ];
        for (let i = 0; i < expectedTables.length; ++i) {
            const table = analyzedScript.tables(i)!;
            const tableName = table.tableName()!;
            const resolvedName = flatsql.FlatID.readTableName(tableName, parsedScript);
            expect(resolvedName).toEqual({
                database: null,
                schema: null,
                table: expectedTables[i].name,
            });
            for (let j = 0; j < expectedTables[i].columns.length; ++j) {
                expect(j).toBeLessThan(table.columnCount());
                const column = analyzedScript.tableColumns(table.columnsBegin() + j)!;
                const columnName = flatsql.FlatID.readName(column.columnName(), parsedScript);
                expect(columnName).toEqual(expectedTables[i].columns[j]);
            }
            const colNames = table.columnsBegin;
        }

        analyzerResult.delete();
        parserResult.delete();
        script.delete();
    });

    it(`Q2`, () => {
        const text = `
select
    s_acctbal,
    s_name,
    n_name,
    p_partkey,
    p_mfgr,
    s_address,
    s_phone,
    s_comment
from
    part,
    supplier,
    partsupp,
    nation,
    region
where
    p_partkey = ps_partkey
    and s_suppkey = ps_suppkey
    and p_size = 15
    and p_type like '%BRASS'
    and s_nationkey = n_nationkey
    and n_regionkey = r_regionkey
    and r_name = 'EUROPE'
    and ps_supplycost = (
        select
            min(ps_supplycost)
        from
            partsupp,
            supplier,
            nation,
            region
        where
            p_partkey = ps_partkey
            and s_suppkey = ps_suppkey
            and s_nationkey = n_nationkey
            and n_regionkey = r_regionkey
            and r_name = 'EUROPE'
    )
order by
    s_acctbal desc,
    n_name,
    s_name,
    p_partkey
limit 100
        `;
        const script = fsql!.createScript();
        script.insertTextAt(0, text);

        // Parse the script
        const parserResult = script.parse();
        const parsedScript = parserResult.read(new flatsql.proto.ParsedScript());
        expect(parsedScript.statementsLength()).toEqual(1);
        expect(parsedScript.statements(0)!.statementType()).toEqual(flatsql.proto.StatementType.SELECT);
        expect(parsedScript.errorsLength()).toEqual(0);

        // Analyze the script
        const analyzerResult = script.analyze();
        const analyzedScript = analyzerResult.read(new flatsql.proto.AnalyzedScript());
        expect(analyzedScript.tablesLength()).toEqual(0);
        expect(analyzedScript.tableReferencesLength()).toBeGreaterThan(0);
        expect(analyzedScript.columnReferencesLength()).toBeGreaterThan(0);
        expect(analyzedScript.graphEdgesLength()).toEqual(9);

        analyzerResult.delete();
        parserResult.delete();
        script.delete();
    });
});
