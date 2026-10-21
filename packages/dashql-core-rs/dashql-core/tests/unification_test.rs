//! A port of the C++ `test/unification_test.cc`.

use dashql_core::catalog::{Catalog, ExternalObjectId, INITIAL_DATABASE_ID, INITIAL_ENTRY_ID, INITIAL_SCHEMA_ID};
use dashql_core::script::Script;
use std::collections::HashSet;
use std::sync::Arc;

/// Create and analyze a script
fn analyze(catalog: &Catalog, text: &str) -> Script {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, text);
    script.analyze(catalog, true).unwrap();
    script
}

fn load(catalog: &mut Catalog, script: &Script, rank: u32) {
    catalog.load_script(script.analyzed.clone().unwrap(), rank).unwrap();
}

fn schema_key(database: &str, schema: &str) -> (Arc<str>, Arc<str>) {
    (Arc::from(database), Arc::from(schema))
}

#[test]
fn empty_catalog_has_no_schema() {
    let catalog = Catalog::new();
    let flat = catalog.flatten();
    assert_eq!(flat.databases.unwrap().len(), 0);
    assert_eq!(flat.schemas.unwrap().len(), 0);
}

#[test]
fn single_table_in_default_schema() {
    let mut catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, "create table foo(a int);");
    script.scan();
    script.parse();
    script.analyze(&catalog, true).unwrap();
    load(&mut catalog, &script, 1);

    let flat = catalog.flatten();
    let (databases, schemas, tables, columns) =
        (flat.databases.unwrap(), flat.schemas.unwrap(), flat.tables.unwrap(), flat.columns.unwrap());
    let names = flat.name_dictionary.unwrap();

    // "foo" should get expanded to dashql.default.foo
    // The flat catalog should therefore have exactly 1 database, 1 schema, 1 table, 1 column
    assert_eq!(databases.len(), 1);
    assert_eq!(schemas.len(), 1);
    assert_eq!(tables.len(), 1);
    assert_eq!(columns.len(), 1);
    assert_eq!(databases[0].catalog_object_id, INITIAL_DATABASE_ID as u64);
    assert_eq!(schemas[0].catalog_object_id, INITIAL_SCHEMA_ID as u64);
    assert_eq!(tables[0].catalog_object_id, ExternalObjectId::new(script.catalog_entry_id(), 0).pack());

    // Check names
    assert_eq!(names.len(), 3);
    assert_eq!(names[databases[0].name_id as usize], "");
    assert_eq!(names[schemas[0].name_id as usize], "");
    assert_eq!(names[tables[0].name_id as usize], "foo");
    assert_eq!(names[columns[0].name_id as usize], "a");
}

#[test]
fn multiple_tables_in_default_schema() {
    let mut catalog = Catalog::new();
    let mut schema0 = Script::new(&catalog);
    let mut schema1 = Script::new(&catalog);
    schema0.insert_text_at(0, "create table foo(a int);");
    schema1.insert_text_at(0, "create table bar(a int);");

    schema0.analyze(&catalog, true).unwrap();
    load(&mut catalog, &schema0, 1);
    schema1.analyze(&catalog, true).unwrap();
    load(&mut catalog, &schema1, 2);

    let flat = catalog.flatten();
    let (databases, schemas, tables, columns) =
        (flat.databases.unwrap(), flat.schemas.unwrap(), flat.tables.unwrap(), flat.columns.unwrap());

    // Both tables are expanded to the default database and schema
    assert_eq!(databases.len(), 1);
    assert_eq!(schemas.len(), 1);
    assert_eq!(tables.len(), 2);
    assert_eq!(columns.len(), 2);

    assert_eq!(databases[0].catalog_object_id, INITIAL_DATABASE_ID as u64);
    assert_eq!(schemas[0].catalog_object_id, INITIAL_SCHEMA_ID as u64);

    // Tables names are ordered lexicographically in the flattend schema
    assert_eq!(tables[0].catalog_object_id, ExternalObjectId::new(schema1.catalog_entry_id(), 0).pack());
    assert_eq!(tables[1].catalog_object_id, ExternalObjectId::new(schema0.catalog_entry_id(), 0).pack());
    assert_eq!(tables[0].flat_parent_idx, 0);
    assert_eq!(tables[1].flat_parent_idx, 0);
    assert_eq!(tables[0].flat_entry_idx, 0);
    assert_eq!(tables[1].flat_entry_idx, 1);
}

#[test]
fn multiple_tables_in_multiple_schemas() {
    let mut catalog = Catalog::new();
    let mut schema0 = Script::new(&catalog);
    let mut schema1 = Script::new(&catalog);
    schema0.insert_text_at(0, "create table in_default_0(a int);");
    schema1.insert_text_at(0, "create table in_default_1(a int); create table separate.schema.in_separate_0(b int);");

    schema0.analyze(&catalog, true).unwrap();
    load(&mut catalog, &schema0, 1);
    schema1.analyze(&catalog, true).unwrap();
    load(&mut catalog, &schema1, 2);

    let flat = catalog.flatten();
    let (databases, schemas, tables, columns) =
        (flat.databases.unwrap(), flat.schemas.unwrap(), flat.tables.unwrap(), flat.columns.unwrap());

    // The expectations are based on lexicograhical order: "" < "separate"
    assert_eq!(databases.len(), 2);
    assert_eq!(schemas.len(), 2);
    assert_eq!(tables.len(), 3);
    assert_eq!(columns.len(), 3);

    assert_eq!(databases[0].catalog_object_id, INITIAL_DATABASE_ID as u64);
    assert_eq!(databases[1].catalog_object_id, INITIAL_DATABASE_ID as u64 + 1);
    assert_eq!(schemas[0].catalog_object_id, INITIAL_SCHEMA_ID as u64);
    assert_eq!(schemas[1].catalog_object_id, INITIAL_SCHEMA_ID as u64 + 1);

    // in_default_0 < in_default_1
    assert_eq!(tables[0].catalog_object_id, ExternalObjectId::new(schema0.catalog_entry_id(), 0).pack());
    assert_eq!(tables[1].catalog_object_id, ExternalObjectId::new(schema1.catalog_entry_id(), 0).pack());
    assert_eq!(tables[0].flat_parent_idx, 0);
    assert_eq!(tables[1].flat_parent_idx, 0);
    // separate.schema.in_separate_0 is written last
    assert_eq!(tables[2].catalog_object_id, ExternalObjectId::new(schema1.catalog_entry_id(), 1).pack());
    assert_eq!(tables[2].flat_parent_idx, 1);
}

#[test]
fn simple_table_reference() {
    let mut catalog = Catalog::new();
    let mut schema = Script::new(&catalog);
    let mut query = Script::new(&catalog);
    schema.insert_text_at(0, "create table db1.schema1.table1(a int);create table db2.schema2.table2(a int);");
    query.insert_text_at(0, "select * from db2.schema2.table2");

    schema.analyze(&catalog, true).unwrap();
    load(&mut catalog, &schema, 1);

    // Analyze query after loading the schema script in the catalog
    query.analyze(&catalog, true).unwrap();
    let analyzed = query.analyzed.as_ref().unwrap();

    // Check flattened catalog
    let flat = catalog.flatten();
    let (databases, schemas, tables, columns) =
        (flat.databases.unwrap(), flat.schemas.unwrap(), flat.tables.unwrap(), flat.columns.unwrap());
    let names = flat.name_dictionary.unwrap();

    assert_eq!(databases.len(), 2);
    assert_eq!(schemas.len(), 2);
    assert_eq!(tables.len(), 2);
    assert_eq!(columns.len(), 2);

    assert_eq!(names[databases[0].name_id as usize], "db1");
    assert_eq!(names[databases[1].name_id as usize], "db2");
    assert_eq!(names[schemas[0].name_id as usize], "schema1");
    assert_eq!(names[schemas[1].name_id as usize], "schema2");

    assert_eq!(tables[0].catalog_object_id, ExternalObjectId::new(schema.catalog_entry_id(), 0).pack());
    assert_eq!(tables[1].catalog_object_id, ExternalObjectId::new(schema.catalog_entry_id(), 1).pack());

    // Check table reference
    assert_eq!(analyzed.table_references.len(), 1);
    let relation = analyzed.table_references[0].inner.as_ref().expect("relation expression");
    let resolved = relation.resolved_table.as_ref().expect("resolved table");
    let (database_id, schema_id) = resolved.catalog_schema_id.unpack_schema_id();
    assert_eq!(database_id as u64, databases[1].catalog_object_id);
    assert_eq!(schema_id as u64, schemas[1].catalog_object_id);
    assert_eq!(resolved.catalog_table_id.unpack_table_id().pack(), tables[1].catalog_object_id);
}

#[test]
fn parallel_database_registration() {
    let mut catalog = Catalog::new();
    let schema0 = analyze(&catalog, "create table db1.schema1.table1(a int);");
    let schema1 = analyze(&catalog, "create table db1.schema2.table2(a int);");
    let analyzed0 = &schema0.analyzed.as_ref().unwrap().entry;
    let analyzed1 = &schema1.analyzed.as_ref().unwrap().entry;
    let db0 = &analyzed0.database_references[analyzed0.databases_by_name["db1"]];
    let db1 = &analyzed1.database_references[analyzed1.databases_by_name["db1"]];
    let db_id = db0.database_id();
    assert_eq!(db1.database_id(), db_id);

    load(&mut catalog, &schema0, 1);
    load(&mut catalog, &schema1, 2);
    assert_eq!(catalog.databases().len(), 1);
    let db = catalog.databases().get("db1").expect("db1");
    assert_eq!(db.object_id.unpack_database_id(), db_id);
    assert_eq!(catalog.schemas().len(), 2);
    assert!(catalog.contains(schema0.catalog_entry_id()));
    assert!(catalog.contains(schema1.catalog_entry_id()));
}

#[test]
fn independent_schema_registration() {
    let mut catalog = Catalog::new();
    let schema0 = analyze(&catalog, "create table schema1.table1(a int);");
    let schema1 = analyze(&catalog, "create table schema1.table2(a int);");
    let analyzed0 = &schema0.analyzed.as_ref().unwrap().entry;
    let analyzed1 = &schema1.analyzed.as_ref().unwrap().entry;
    let key = schema_key("", "schema1");
    let schema_id = analyzed0.schema_references[analyzed0.schemas_by_qualified_name[&key]].object_id;
    assert_eq!(analyzed1.schema_references[analyzed1.schemas_by_qualified_name[&key]].object_id, schema_id);

    load(&mut catalog, &schema0, 1);
    load(&mut catalog, &schema1, 2);
    assert_eq!(catalog.databases().len(), 1);
    assert_eq!(catalog.schemas().len(), 1);
    let schema = catalog.schemas().get(&key).expect("schema1");
    assert_eq!(schema.object_id, schema_id);
    assert!(catalog.contains(schema0.catalog_entry_id()));
    assert!(catalog.contains(schema1.catalog_entry_id()));
}

#[test]
fn independent_declaration_analysis_uses_canonical_ids() {
    let mut catalog = Catalog::new();
    let mut schema0 = Script::new(&catalog);
    let mut schema1 = Script::new(&catalog);
    schema0.insert_text_at(0, "create table db1.schema1.table1(a int);");
    schema1.insert_text_at(0, "create table db1.schema1.table2(b int);");
    schema0.parse();
    schema1.parse();

    schema0.analyze(&catalog, false).unwrap();
    schema1.analyze(&catalog, false).unwrap();

    let analyzed0 = &schema0.analyzed.as_ref().expect("analyzed").entry;
    let analyzed1 = &schema1.analyzed.as_ref().expect("analyzed").entry;
    let db0 = analyzed0.databases_by_name.get("db1").expect("db1");
    let db1 = analyzed1.databases_by_name.get("db1").expect("db1");
    assert_eq!(analyzed0.database_references[*db0].object_id, analyzed1.database_references[*db1].object_id);
    let key = schema_key("db1", "schema1");
    let s0 = analyzed0.schemas_by_qualified_name.get(&key).expect("schema1");
    let s1 = analyzed1.schemas_by_qualified_name.get(&key).expect("schema1");
    assert_eq!(analyzed0.schema_references[*s0].object_id, analyzed1.schema_references[*s1].object_id);

    load(&mut catalog, &schema0, 1);
    load(&mut catalog, &schema1, 2);
    assert!(catalog.contains(schema0.catalog_entry_id()));
    assert!(catalog.contains(schema1.catalog_entry_id()));

    let flat = catalog.flatten();
    let tables = flat.tables.unwrap();
    assert_eq!(flat.databases.unwrap().len(), 1);
    assert_eq!(flat.schemas.unwrap().len(), 1);
    assert_eq!(tables.len(), 2);
    assert_ne!(tables[0].catalog_object_id, tables[1].catalog_object_id);
}

#[test]
fn script_construction_allocates_unique_entry_ids_without_reuse() {
    let catalog = Catalog::new();
    let script_count = 1024;
    let mut unique_ids = HashSet::new();
    for _ in 0..script_count {
        let script = Script::new(&catalog);
        unique_ids.insert(script.catalog_entry_id());
    }
    assert_eq!(unique_ids.len(), script_count);
    assert_eq!(*unique_ids.iter().min().unwrap(), INITIAL_ENTRY_ID);
    assert_eq!(*unique_ids.iter().max().unwrap(), INITIAL_ENTRY_ID + script_count as u32 - 1);
}
