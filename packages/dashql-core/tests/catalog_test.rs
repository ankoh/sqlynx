//! A port of the C++ `test/catalog_test.cc`.
//!
//! `Catalog::load_scripts` takes analyzed scripts, so the C++ check for unanalyzed scripts
//! (`CATALOG_SCRIPT_NOT_ANALYZED`) has no Rust counterpart.

use dashql_buffers::status::StatusCode;
use dashql_core::catalog::{Catalog, CatalogEntryId, CatalogObjectType, ExternalObjectId, QualifiedCatalogObjectId, Rank};
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

    // The C++ batch with an unanalyzed script cannot be expressed, see the module comment.
    let valid_analyzed = valid.analyzed.clone().unwrap();
    let error = catalog.load_scripts(&[(valid_analyzed.clone(), 2), (valid_analyzed.clone(), 3)]).unwrap_err();
    assert_eq!(error.status, Some(StatusCode::EXTERNAL_ID_COLLISION));
    assert_eq!(catalog.version(), previous_version);
    assert!(catalog.contains(loaded.catalog_entry_id()));
    assert!(!catalog.contains(valid.catalog_entry_id()));

    let other_catalog = Catalog::new();
    let mismatched = analyze(&other_catalog, "create table db.schema.other(id int);");
    let error = catalog.load_scripts(&[(valid_analyzed, 2), (mismatched.analyzed.clone().unwrap(), 3)]).unwrap_err();
    assert_eq!(error.status, Some(StatusCode::CATALOG_MISMATCH));
    assert_eq!(catalog.version(), previous_version);
    assert!(!catalog.contains(valid.catalog_entry_id()));
}

#[test]
fn describe_entries_lists_scripts_as_one_anonymous_schema() {
    let mut catalog = Catalog::new();
    assert!(catalog.describe_entries().entries.unwrap().is_empty());
    let first = analyze(&catalog, "create table db.main.items(id int, name text); create table db.main.tags(tag text);");
    let second = analyze(&catalog, "create table other.misc(x int);");
    catalog.load_script(first.analyzed.clone().unwrap(), 5).unwrap();
    catalog.load_script(second.analyzed.clone().unwrap(), 2).unwrap();

    // The entries are described in rank order
    let entries = catalog.describe_entries().entries.unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].catalog_entry_id, second.catalog_entry_id());
    assert_eq!(entries[1].catalog_entry_id, first.catalog_entry_id());
    assert!(entries.iter().all(|e| e.rank == 0));
    let schemas = entries[1].schemas.as_ref().unwrap();
    assert_eq!(schemas.len(), 1);
    let tables = schemas[0].tables.as_ref().unwrap();
    assert_eq!(tables.len(), 2);
    assert_eq!(tables[0].table_id, 0);
    assert_eq!(tables[0].table_name.as_deref(), Some("items"));
    let columns = tables[0].columns.as_ref().unwrap();
    assert_eq!(columns.iter().map(|c| c.column_name.as_deref().unwrap()).collect::<Vec<_>>(), vec!["id", "name"]);
    assert_eq!(tables[1].table_id, 1);

    let single = catalog.describe_entries_of(second.catalog_entry_id()).unwrap().entries.unwrap();
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].catalog_entry_id, second.catalog_entry_id());
    assert!(catalog.describe_entries_of(9999).is_none());
}

#[test]
fn statistics_count_scripts() {
    let mut catalog = Catalog::new();
    let script = analyze(&catalog, "create table db.main.t(a int, b int); create table db.other.u(c int);");
    catalog.load_script(script.analyzed.clone().unwrap(), 0).unwrap();
    let content = catalog.statistics().content.unwrap();
    assert_eq!((content.database_count, content.schema_count, content.table_count, content.table_column_count), (1, 2, 2, 3));
}

#[test]
fn drop_script_removes_unreferenced_databases_and_schemas() {
    let mut catalog = Catalog::new();
    let first = analyze(&catalog, "create table db.main.t(a int);");
    let second = analyze(&catalog, "create table db.main.u(a int); create table other.x.v(a int);");
    catalog.load_script(first.analyzed.clone().unwrap(), 1).unwrap();
    catalog.load_script(second.analyzed.clone().unwrap(), 2).unwrap();
    assert_eq!(catalog.databases().len(), 2);
    assert_eq!(catalog.schemas().len(), 2);

    let version = catalog.version();
    catalog.drop_script(second.catalog_entry_id());
    assert!(catalog.version() > version);
    assert!(!catalog.contains(second.catalog_entry_id()));
    // db.main stays referenced by the first script
    assert_eq!(catalog.databases().keys().map(|k| &**k).collect::<Vec<_>>(), vec!["db"]);
    assert_eq!(catalog.schemas().len(), 1);
    assert_eq!(catalog.entries_by_qualified_schema().len(), 1);
    assert_eq!(catalog.entries_by_schema().len(), 1);

    // Unknown scripts are ignored
    let version = catalog.version();
    catalog.drop_script(second.catalog_entry_id());
    assert_eq!(catalog.version(), version);

    catalog.drop_script(first.catalog_entry_id());
    assert!(catalog.databases().is_empty());
    assert!(catalog.schemas().is_empty());
    assert_eq!(catalog.entries_ranked().count(), 0);
}

#[test]
fn clear_removes_all_entries() {
    let mut catalog = Catalog::new();
    let script = analyze(&catalog, "create table db.main.t(a int);");
    catalog.load_script(script.analyzed.clone().unwrap(), 1).unwrap();
    let version = catalog.version();
    catalog.clear();
    assert!(catalog.version() > version);
    assert!(!catalog.contains(script.catalog_entry_id()));
    assert!(catalog.entry(script.catalog_entry_id()).is_none());
    assert!(catalog.databases().is_empty());
    assert!(catalog.schemas().is_empty());
    assert_eq!(catalog.entries_ranked().count(), 0);
    assert!(catalog.flatten().databases.unwrap().is_empty());
}

#[test]
fn entries_resolve_tables_by_name() {
    let mut catalog = Catalog::new();
    let first = analyze(&catalog, "create table db.main.t(a int); create table db.main.u(b int);");
    let second = analyze(&catalog, "create table db.main.t(c int);");
    catalog.load_script(first.analyzed.clone().unwrap(), 1).unwrap();
    catalog.load_script(second.analyzed.clone().unwrap(), 2).unwrap();

    let entry = catalog.entry(first.catalog_entry_id()).unwrap().data();
    let mut found = Vec::new();
    entry.resolve_table_in_schema("main", "t", &mut found, 10);
    assert_eq!(found.len(), 1);
    // A limit stops the search
    let mut found = Vec::new();
    entry.resolve_table_everywhere("u", &mut found, 1);
    assert_eq!(found.len(), 1);
    let mut found = Vec::new();
    entry.resolve_table_everywhere("missing", &mut found, 10);
    assert!(found.is_empty());
}

#[test]
fn external_object_ids_pack_and_unpack() {
    let id = ExternalObjectId::new(7, 9);
    assert!(!id.is_null());
    assert_eq!(ExternalObjectId::unpack(id.pack()), id);
    let default = ExternalObjectId::default();
    assert!(default.is_null());
    assert_eq!((default.origin, default.object), (u32::MAX, u32::MAX));

    let table = QualifiedCatalogObjectId::table(id);
    assert_eq!(table.object_type(), CatalogObjectType::TableDeclaration);
    assert_eq!(table.unpack_table_id(), id);
    let column = QualifiedCatalogObjectId::table_column(id, 3);
    assert_eq!(column.object_type(), CatalogObjectType::ColumnDeclaration);
    assert_eq!(column.unpack_table_column_id(), (id, 3));
    let function = QualifiedCatalogObjectId::function(id);
    assert_eq!(function.object_type(), CatalogObjectType::FunctionDeclaration);
    assert_eq!(function.unpack_function_id(), id);
    let database = QualifiedCatalogObjectId::database(256);
    assert_eq!(database.object_type(), CatalogObjectType::DatabaseReference);
    assert_eq!(database.unpack_database_id(), 256);
    let schema = QualifiedCatalogObjectId::schema(256, 65536);
    assert_eq!(schema.object_type(), CatalogObjectType::SchemaReference);
    assert_eq!(schema.unpack_schema_id(), (256, 65536));
    assert_eq!(QualifiedCatalogObjectId::deferred().object_type(), CatalogObjectType::Deferred);
}

#[test]
fn database_and_schema_ids_are_reserved_once() {
    let catalog = Catalog::new();
    let first = catalog.reserve_database_id("db");
    assert_eq!(catalog.reserve_database_id("db"), first);
    assert_ne!(catalog.reserve_database_id("other"), first);
    let schema = catalog.reserve_schema_id("db", "main", first);
    assert_eq!(catalog.reserve_schema_id("db", "main", first), schema);
    assert_ne!(catalog.reserve_schema_id("db", "second", first), schema);
    assert_eq!(schema.unpack_schema_id().0, first.unpack_database_id());
    let entry_a = catalog.allocate_entry_id();
    assert_eq!(catalog.allocate_entry_id(), entry_a + 1);
}
