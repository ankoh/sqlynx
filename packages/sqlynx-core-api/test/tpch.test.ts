import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { expectTables, table } from './matchers.js';

const distPath = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

let fsql: sqlynx.SQLynx | null = null;

beforeAll(async () => {
    fsql = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
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

describe('SQLynx TPCH Parsing', () => {
    it(`Schema`, () => {
        const text = TPCH_SCHEMA;
        const script = fsql!.createScript(null, 1);
        script.insertTextAt(0, text);

        // Parse the script
        script.scan();
        const parserResult = script.parse();
        const parsedScript = parserResult.read(new sqlynx.proto.ParsedScript());
        expect(parsedScript.statementsLength()).toEqual(8);
        for (let i = 0; i < 8; ++i) {
            expect(parsedScript.statements(0)!.statementType()).toEqual(sqlynx.proto.StatementType.CREATE_TABLE);
        }
        expect(parsedScript.errorsLength()).toEqual(0);

        // Analyze the script
        const analyzerResult = script.analyze();
        const analyzedScript = analyzerResult.read(new sqlynx.proto.AnalyzedScript());
        expect(analyzedScript.tablesLength()).toEqual(8);

        // Test tables
        expectTables(parsedScript, analyzedScript, [
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
            table('supplier', ['s_suppkey', 's_name', 's_address', 's_nationkey', 's_phone', 's_acctbal', 's_comment']),
            table('partsupp', ['ps_partkey', 'ps_suppkey', 'ps_availqty', 'ps_supplycost', 'ps_comment']),
            table('customer', [
                'c_custkey',
                'c_name',
                'c_address',
                'c_nationkey',
                'c_phone',
                'c_acctbal',
                'c_mktsegment',
                'c_comment',
            ]),
            table('orders', [
                'o_orderkey',
                'o_custkey',
                'o_orderstatus',
                'o_totalprice',
                'o_orderdate',
                'o_orderpriority',
                'o_clerk',
                'o_shippriority',
                'o_comment',
            ]),
            table('lineitem', [
                'l_orderkey',
                'l_partkey',
                'l_suppkey',
                'l_linenumber',
                'l_quantity',
                'l_extendedprice',
                'l_discount',
                'l_tax',
                'l_returnflag',
                'l_linestatus',
                'l_shipdate',
                'l_commitdate',
                'l_receiptdate',
                'l_shipinstruct',
                'l_shipmode',
                'l_comment',
            ]),
            table('nation', ['n_nationkey', 'n_name', 'n_regionkey', 'n_comment']),
            table('region', ['r_regionkey', 'r_name', 'r_comment']),
        ]);

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
        const script = fsql!.createScript(null, 2);
        script.insertTextAt(0, text);

        // Parse the script
        script.scan();
        const parserResult = script.parse();
        const parsedScript = parserResult.read(new sqlynx.proto.ParsedScript());
        expect(parsedScript.statementsLength()).toEqual(1);
        expect(parsedScript.statements(0)!.statementType()).toEqual(sqlynx.proto.StatementType.SELECT);
        expect(parsedScript.errorsLength()).toEqual(0);

        // Analyze the script
        const analyzerResult = script.analyze();
        const analyzedScript = analyzerResult.read(new sqlynx.proto.AnalyzedScript());
        expect(analyzedScript.tablesLength()).toEqual(0);
        expect(analyzedScript.tableReferencesLength()).toBeGreaterThan(0);
        expect(analyzedScript.columnReferencesLength()).toBeGreaterThan(0);
        expect(analyzedScript.graphEdgesLength()).toEqual(8);

        analyzerResult.delete();
        parserResult.delete();
        script.delete();
    });
});
