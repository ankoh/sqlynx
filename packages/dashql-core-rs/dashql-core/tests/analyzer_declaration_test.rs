//! A port of `packages/dashql-core/test/analyzer_declaration_test.cc`.

use dashql_core::catalog::{Catalog, TableDeclaration};
use dashql_core::script::Script;

/// Analyze a script that declares a single table
fn analyze_single_table(input: &str, catalog: &Catalog) -> Script {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, input);
    script.analyze(catalog, true).unwrap();
    assert_eq!(script.analyzed.as_ref().unwrap().entry.table_declarations.len(), 1);
    script
}

fn single_table(script: &Script) -> &TableDeclaration {
    &script.analyzed.as_ref().unwrap().entry.table_declarations[0]
}

fn expect_columns(table: &TableDeclaration, expected: &[&str]) {
    let names: Vec<&str> = table.table_columns.iter().map(|c| c.column_name.text()).collect();
    assert_eq!(names, expected);
}

/// Analyze and load the schema `create table source (id int, amount int)`
fn load_source_schema(catalog: &mut Catalog) -> Script {
    let mut schema = Script::new(catalog);
    schema.insert_text_at(0, "create table source (id int, amount int)");
    schema.analyze(catalog, true).unwrap();
    catalog.load_script(schema.analyzed.clone().unwrap(), 0).unwrap();
    schema
}

#[test]
fn create_table_as_derives_named_select_columns() {
    let mut catalog = Catalog::new();
    let _schema = load_source_schema(&mut catalog);

    let script = analyze_single_table(
        "create table result as with selected as (select * from source) select *, amount + 1, id as renamed from selected",
        &catalog,
    );
    let table = single_table(&script);
    assert_eq!(table.table_name.table_name.text(), "result");
    assert_eq!(table.ast_statement_id, Some(0));
    expect_columns(table, &["amount", "id", "renamed"]);
}

#[test]
fn explicit_create_aliases_override_select_output_names() {
    let catalog = Catalog::new();
    let script = analyze_single_table("create view result(first, second) as select 1 as old, 2 as names", &catalog);
    let table = single_table(&script);
    assert_eq!(table.table_name.table_name.text(), "result");
    assert_eq!(table.ast_statement_id, Some(0));
    expect_columns(table, &["first", "second"]);
}

#[test]
fn explicit_create_table_aliases_override_select_output_names() {
    let catalog = Catalog::new();
    let script = analyze_single_table("create table result(first, second) as select 1 as old, 2 as names", &catalog);
    let table = single_table(&script);
    assert_eq!(table.ast_statement_id, Some(0));
    expect_columns(table, &["first", "second"]);
}

#[test]
fn view_derives_cte_alias_columns() {
    let catalog = Catalog::new();
    let script = analyze_single_table(
        "create view result as with source(first, second) as (select 1 as old, 2 as names) select * from source",
        &catalog,
    );
    let table = single_table(&script);
    assert_eq!(table.ast_statement_id, Some(0));
    expect_columns(table, &["first", "second"]);
}

#[test]
fn select_into_declares_table_from_resolved_star() {
    let mut catalog = Catalog::new();
    let _schema = load_source_schema(&mut catalog);

    let script = analyze_single_table("select *, id as copied_id, amount + 1 into result from source", &catalog);
    let table = single_table(&script);
    assert_eq!(table.table_name.table_name.text(), "result");
    assert_eq!(table.ast_statement_id, Some(0));
    expect_columns(table, &["amount", "id", "copied_id"]);
}

#[test]
fn ordinary_create_table_keeps_declared_columns_and_statement_id() {
    let catalog = Catalog::new();
    let script = analyze_single_table("create table result (z int, a int)", &catalog);
    let table = single_table(&script);
    assert_eq!(table.ast_statement_id, Some(0));
    expect_columns(table, &["a", "z"]);
}

#[test]
fn derived_table_columns_are_indexed() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(
        0,
        "create table source (id int); create table derived as select id as copied_id from source; select copied_id from derived",
    );
    script.analyze(&catalog, true).unwrap();

    let analyzed = script.analyzed.as_ref().unwrap();
    assert_eq!(analyzed.entry.table_declarations.len(), 2);
    let derived = &analyzed.entry.table_declarations[1];
    assert_eq!(derived.ast_statement_id, Some(1));
    assert!(derived.table_columns_by_name.contains_key("copied_id"));
}

#[test]
fn set_operation_uses_left_input_columns() {
    let catalog = Catalog::new();
    let script = analyze_single_table("create view result as select 1 as first union all select 2 as second", &catalog);
    expect_columns(single_table(&script), &["first"]);
}
