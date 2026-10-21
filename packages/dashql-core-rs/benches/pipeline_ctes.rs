//! Pipeline benchmarks over growing CTE chains, the counterpart of the former
//! `benchmarks/benchmark_pipeline_ctes.cc`.
//!
//! The main script is `with cte_0 as (<TPC-H q1>), ..., cte_<n-1> as (<TPC-H q1>) select 1`, analyzed
//! against the TPC-H schema in the catalog. Each benchmark goes through the `Script` facade like the
//! C++ benchmark.
//!
//!   bazel run -c opt //packages/dashql-core-rs:bench_pipeline_ctes [-- <filter>]

mod harness;

use dashql_core::catalog::Catalog;
use dashql_core::script::Script;
use harness::bench;
use std::hint::black_box;

const TPCH_SCHEMA: &str = r#"
create table part (p_partkey integer not null, p_name varchar(55) not null, p_mfgr char(25) not null, p_brand char(10) not null, p_type varchar(25) not null, p_size integer not null, p_container char(10) not null, p_retailprice decimal(12,2) not null, p_comment varchar(23) not null, primary key (p_partkey));
create table supplier (s_suppkey integer not null, s_name char(25) not null, s_address varchar(40) not null, s_nationkey integer not null, s_phone char(15) not null, s_acctbal decimal(12,2) not null, s_comment varchar(101) not null, primary key (s_suppkey));
create table partsupp (ps_partkey integer not null, ps_suppkey integer not null, ps_availqty integer not null, ps_supplycost decimal(12,2) not null, ps_comment varchar(199) not null, primary key (ps_partkey,ps_suppkey));
create table customer (c_custkey integer not null, c_name varchar(25) not null, c_address varchar(40) not null, c_nationkey integer not null, c_phone char(15) not null, c_acctbal decimal(12,2) not null, c_mktsegment char(10) not null, c_comment varchar(117) not null, primary key (c_custkey));
create table orders (o_orderkey integer not null, o_custkey integer not null, o_orderstatus char(1) not null, o_totalprice decimal(12,2) not null, o_orderdate date not null, o_orderpriority char(15) not null, o_clerk char(15) not null, o_shippriority integer not null, o_comment varchar(79) not null, primary key (o_orderkey));
create table lineitem (l_orderkey integer not null, l_partkey integer not null, l_suppkey integer not null, l_linenumber integer not null, l_quantity decimal(12,2) not null, l_extendedprice decimal(12,2) not null, l_discount decimal(12,2) not null, l_tax decimal(12,2) not null, l_returnflag char(1) not null, l_linestatus char(1) not null, l_shipdate date not null, l_commitdate date not null, l_receiptdate date not null, l_shipinstruct char(25) not null, l_shipmode char(10) not null, l_comment varchar(44) not null, primary key (l_orderkey,l_linenumber));
create table nation (n_nationkey integer not null, n_name char(25) not null, n_regionkey integer not null, n_comment varchar(152) not null, primary key (n_nationkey));
create table region (r_regionkey integer not null, r_name char(25) not null, r_comment varchar(152) not null, primary key (r_regionkey));
"#;

/// TPC-H query 1, verbatim from the C++ benchmark (including its `&#60;=`)
const TPCH_1: &str = r#"
select
    l_returnflag,
    l_linestatus,
    sum(l_quantity) as sum_qty,
    sum(l_extendedprice) as sum_base_price,
    sum(l_extendedprice * (1 - l_discount)) as sum_disc_price,
    sum(l_extendedprice * (1 - l_discount) * (1 + l_tax)) as sum_charge,
    avg(l_quantity) as avg_qty,
    avg(l_extendedprice) as avg_price,
    avg(l_discount) as avg_disc,
    count(*) as count_order
from
    lineitem
where
    l_shipdate &#60;= date '1998-12-01' - interval '90' day
group by
    l_returnflag,
    l_linestatus
order by
    l_returnflag,
    l_linestatus
"#;

/// The CTE counts of the C++ benchmark
const CTE_COUNTS: [usize; 14] = [1, 5, 10, 20, 30, 40, 50, 100, 150, 200, 250, 300, 500, 1000];

fn generate_query(cte_count: usize) -> String {
    let mut out = String::new();
    if cte_count > 0 {
        out += &format!("WITH cte_0 AS (\n{TPCH_1})\n");
    }
    for i in 1..cte_count {
        out += &format!(", cte_{i} AS (\n{TPCH_1})\n");
    }
    out += "select 1\n";
    out
}

/// A catalog with the analyzed TPC-H schema and the analyzed main script with `cte_count` CTEs
fn setup(cte_count: usize) -> (Catalog, Script) {
    let mut catalog = Catalog::new();
    let mut schema = Script::new(&catalog);
    schema.insert_text_at(0, TPCH_SCHEMA);
    schema.analyze(&catalog, true).expect("analyze schema");
    let analyzed = schema.analyzed.clone().expect("analyzed schema");
    catalog.load_script(analyzed, 0).expect("load schema");

    let mut main = Script::new(&catalog);
    main.insert_text_at(0, &generate_query(cte_count));
    // Dry run
    if let Err(e) = main.analyze(&catalog, true) {
        eprintln!("dry run failed: {e:?}");
    }
    (catalog, main)
}

fn main() {
    let filter = std::env::args().nth(1).unwrap_or_default();
    let run = |name: String, f: &mut dyn FnMut()| {
        if name.contains(&filter) {
            bench(&name, f);
        }
    };
    for n in CTE_COUNTS {
        let (_catalog, mut main) = setup(n);
        run(format!("scan_query/{n}"), &mut || {
            main.scan();
            black_box(&main);
        });
    }
    for n in CTE_COUNTS {
        let (_catalog, mut main) = setup(n);
        run(format!("parse_query/{n}"), &mut || {
            main.parse();
            black_box(&main);
        });
    }
    for n in CTE_COUNTS {
        let (catalog, mut main) = setup(n);
        run(format!("analyze_query/{n}"), &mut || {
            main.analyze(&catalog, false).expect("analyze");
            black_box(&main);
        });
    }
}
