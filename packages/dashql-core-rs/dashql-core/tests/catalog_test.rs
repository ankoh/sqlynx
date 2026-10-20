//! A port of `packages/dashql-core/test/catalog_test.cc`.
//!
//! Rust scripts do not reference a catalog and `Catalog::load_scripts` takes analyzed scripts, so
//! the C++ checks for unanalyzed scripts (`CATALOG_SCRIPT_NOT_ANALYZED`) and scripts of another
//! catalog (`CATALOG_MISMATCH`) have no Rust counterpart.

use dashql_buffers::status::StatusCode;
use dashql_core::catalog::{Catalog, CatalogEntryId, Rank};
use dashql_core::script::Script;

fn analyze(catalog: &Catalog, text: &str) -> Script {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, text);
    script.analyze(catalog, true).unwrap();
    script
}

#[test]
fn flatten_empty() {
    let catalog = Catalog::new();
    let flat = catalog.flatten();
    assert_eq!(flat.catalog_version, catalog.version() as u64);
}

const TPCH_SCHEMA: &str = r#"
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
"#;

#[test]
fn flatten_example_schema() {
    let mut catalog = Catalog::new();

    // Create script with TPCH schema
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, TPCH_SCHEMA);
    script.scan();
    script.parse();
    script.analyze(&catalog, true).unwrap();
    let analyzed = script.analyzed.clone().unwrap();

    // Make sure the analyzed script matches expectations
    assert_eq!(analyzed.entry.databases_by_name.len(), 1);
    assert_eq!(analyzed.entry.schemas_by_qualified_name.len(), 1);
    assert_eq!(analyzed.entry.tables_by_qualified_name.len(), 8);

    // Add to catalog
    catalog.load_script(analyzed, 1).unwrap();

    // Flatten the catalog
    let flat = catalog.flatten();
    assert_eq!(flat.catalog_version, catalog.version() as u64);
    assert_eq!(flat.databases.unwrap().len(), 1);
    assert_eq!(flat.schemas.unwrap().len(), 1);
}

#[test]
fn load_scripts_publishes_one_ranked_generation() {
    let mut catalog = Catalog::new();
    let relations = analyze(&catalog, "create table db.schema.items(id int);");
    let functions = analyze(&catalog, "create function db.schema.item_count() returns int;");
    let previous_version = catalog.version();

    catalog
        .load_scripts(&[(relations.analyzed.clone().unwrap(), 20), (functions.analyzed.clone().unwrap(), 10)])
        .unwrap();

    assert_eq!(catalog.version(), previous_version + 1);
    assert!(catalog.contains(relations.catalog_entry_id()));
    assert!(catalog.contains(functions.catalog_entry_id()));
    let entries: Vec<(CatalogEntryId, Rank, usize, usize)> = catalog
        .entries_ranked()
        .map(|(rank, entry)| {
            let data = entry.data();
            (data.catalog_entry_id, rank, data.table_declarations.len(), data.function_declarations.len())
        })
        .collect();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0], (functions.catalog_entry_id(), 10, 0, 1));
    assert_eq!(entries[1], (relations.catalog_entry_id(), 20, 1, 0));
}

#[test]
fn load_scripts_updates_loaded_scripts_and_ranks_once() {
    let mut catalog = Catalog::new();
    let mut first = analyze(&catalog, "create table db.schema.old_table(id int);");
    let second = analyze(&catalog, "create table db.schema.second_table(id int);");
    catalog.load_script(first.analyzed.clone().unwrap(), 1).unwrap();
    catalog.load_script(second.analyzed.clone().unwrap(), 2).unwrap();

    first.replace_text("create table db.schema.new_table(id int);");
    first.analyze(&catalog, true).unwrap();
    let previous_version = catalog.version();
    catalog.load_scripts(&[(first.analyzed.clone().unwrap(), 30), (second.analyzed.clone().unwrap(), 20)]).unwrap();

    assert_eq!(catalog.version(), previous_version + 1);
    let ranked: Vec<(CatalogEntryId, Rank)> =
        catalog.entries_ranked().map(|(rank, entry)| (entry.data().catalog_entry_id, rank)).collect();
    assert_eq!(ranked, vec![(second.catalog_entry_id(), 20), (first.catalog_entry_id(), 30)]);
    let entry = catalog.entry(first.catalog_entry_id()).expect("first").data();
    assert_eq!(entry.table_declarations.len(), 1);
    assert_eq!(entry.table_declarations[0].table_name.table_name.text(), "new_table");
}

#[test]
fn load_scripts_validation_failure_preserves_catalog() {
    let mut catalog = Catalog::new();
    let loaded = analyze(&catalog, "create table db.schema.loaded(id int);");
    let valid = analyze(&catalog, "create table db.schema.valid(id int);");
    catalog.load_script(loaded.analyzed.clone().unwrap(), 1).unwrap();
    let previous_version = catalog.version();

    // The C++ batches with an unanalyzed script and with a script of another catalog cannot be
    // expressed, see the module comment.
    let valid_analyzed = valid.analyzed.clone().unwrap();
    let error = catalog.load_scripts(&[(valid_analyzed.clone(), 2), (valid_analyzed, 3)]).unwrap_err();
    assert_eq!(error.status, Some(StatusCode::EXTERNAL_ID_COLLISION));
    assert_eq!(catalog.version(), previous_version);
    assert!(catalog.contains(loaded.catalog_entry_id()));
    assert!(!catalog.contains(valid.catalog_entry_id()));
}
