//! A port of `packages/dashql-core/test/analyzer_insert_test.cc`.

use dashql_buffers::analyzer::TableReferenceRole;
use dashql_core::analyzer::{AnalyzedScript, TableRole};
use dashql_core::catalog::Catalog;
use dashql_core::pack::{pack_analyzed_script, pack_visualization};
use dashql_core::script::Script;
use std::sync::Arc;

/// Analyze a schema script and load it into the catalog
fn load_schema(catalog: &mut Catalog, sql: &str) -> Script {
    let script = analyze(catalog, sql);
    catalog.load_script(script.analyzed.clone().unwrap(), 0).unwrap();
    script
}

fn analyze(catalog: &Catalog, sql: &str) -> Script {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, sql);
    script.analyze(catalog, true).unwrap();
    script
}

fn analyzed(script: &Script) -> &Arc<AnalyzedScript> {
    script.analyzed.as_ref().unwrap()
}

/// The number of unresolved relations in all name scopes
fn unresolved_reads(analyzed: &AnalyzedScript) -> usize {
    analyzed
        .name_scopes
        .iter()
        .flat_map(|scope| scope.referenced_tables_by_name.iter())
        .filter(|(_, table)| table.is_unresolved_relation())
        .count()
}

#[test]
fn resolves_write_target_columns_and_source_reads() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int, label text); create table source (id int, label text);");
    let script = analyze(&catalog, "insert into target(id, label) select id, label from source returning id");
    let analyzed = analyzed(&script);

    assert_eq!(analyzed.table_references.len(), 2);
    let write_target = analyzed.table_references.iter().rposition(|r| r.role == TableRole::Write);
    let read_source = analyzed.table_references.iter().rposition(|r| r.role != TableRole::Write);
    let write_target = write_target.expect("write target");
    assert!(read_source.is_some());

    assert_eq!(analyzed.insert_statements.len(), 1);
    let insert = &analyzed.insert_statements[0];
    assert_eq!(insert.target as usize, write_target);
    assert!(insert.source_ast_node_id.is_some());
    assert!(insert.returning);
    assert_eq!(insert.target_columns.len(), 2);
    assert_eq!(insert.target_columns[0].column_name.text(), "id");
    assert_eq!(insert.target_columns[1].column_name.text(), "label");
    assert!(insert.target_columns[0].resolved.is_some());
    assert!(insert.target_columns[1].resolved.is_some());
}

#[test]
fn source_query_cannot_read_from_write_target() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int);");
    let script = analyze(&catalog, "insert into target(id) select id");
    let analyzed = analyzed(&script);

    assert_eq!(analyzed.expressions.len(), 1);
    let column = analyzed.expressions[0].column_ref().expect("column ref");
    assert!(!column.resolved.is_resolved());
}

#[test]
fn leading_cte_feeds_source_and_returning_uses_target() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int);");
    let script = analyze(&catalog, "with source as (select 1 as id) insert into target(id) select id from source returning id");
    let analyzed = analyzed(&script);

    assert_eq!(analyzed.insert_statements.len(), 1);
    assert!(analyzed.insert_statements[0].returning);
    assert_eq!(analyzed.table_references.len(), 2);
    assert_eq!(analyzed.table_references[0].role, TableRole::Read);
    assert_eq!(analyzed.table_references[1].role, TableRole::Write);

    let resolved_columns =
        analyzed.expressions.iter().filter_map(|e| e.column_ref()).filter(|c| c.resolved.is_resolved()).count();
    assert_eq!(resolved_columns, 2);
}

#[test]
fn unresolved_target_remains_a_write_reference() {
    let catalog = Catalog::new();
    let script = analyze(&catalog, "insert into missing(id) values (1)");
    let analyzed = analyzed(&script);

    assert_eq!(analyzed.table_references.len(), 1);
    assert_eq!(analyzed.table_references[0].role, TableRole::Write);
    assert_eq!(analyzed.insert_statements.len(), 1);
    assert_eq!(analyzed.insert_statements[0].target_columns.len(), 1);
    assert!(analyzed.insert_statements[0].target_columns[0].resolved.is_none());
}

#[test]
fn repeated_target_columns_remain_safe() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int);");
    let script = analyze(&catalog, "insert into target(id, id) values (1, 2); insert into target(id) values (3)");
    let analyzed = analyzed(&script);

    assert_eq!(analyzed.insert_statements.len(), 2);
    assert!(analyzed.insert_statements[0].target_columns[0].resolved.is_some());
    assert!(analyzed.insert_statements[0].target_columns[1].resolved.is_some());
    assert!(analyzed.insert_statements[1].target_columns[0].resolved.is_some());
}

#[test]
fn non_recursive_ctes_do_not_resolve_self_or_forward_references() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int);");
    let script = analyze(
        &catalog,
        "with first as (select * from later), later as (select * from later) insert into target select 1",
    );
    let analyzed = analyzed(&script);

    assert_eq!(analyzed.table_references.len(), 3);
    assert_eq!(unresolved_reads(analyzed), 2);
}

#[test]
fn returning_does_not_resolve_from_source_outputs() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int);");
    let script = analyze(&catalog, "insert into target select 1 as source_only returning source_only");
    let analyzed = analyzed(&script);

    let returning = analyzed
        .expressions
        .iter()
        .filter_map(|e| e.column_ref())
        .filter(|c| c.column_name.column_name.text() == "source_only")
        .last()
        .expect("returning column");
    assert!(!returning.resolved.is_resolved());
}

#[test]
fn leading_cte_does_not_see_write_target() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int);");
    let script = analyze(&catalog, "with source as (select id) insert into target default values");
    let analyzed = analyzed(&script);

    assert_eq!(analyzed.expressions.len(), 1);
    let column = analyzed.expressions[0].column_ref().expect("column ref");
    assert!(!column.resolved.is_resolved());
}

#[test]
fn packs_insert_metadata() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create table target (id int, label text);");
    let script = analyze(&catalog, "insert into target(id, label) values (1, 'one') returning id");

    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = pack_analyzed_script(analyzed(&script), &pack_visualization).pack(&mut builder);
    builder.finish(packed, None);
    let analyzed = flatbuffers::root::<dashql_buffers::analyzer::AnalyzedScript>(builder.finished_data()).unwrap();

    let inserts = analyzed.insert_statements().unwrap();
    assert_eq!(inserts.len(), 1);
    let insert = inserts.get(0);
    let target_columns = insert.target_columns().unwrap();
    assert_eq!(target_columns.len(), 2);
    assert_eq!(target_columns.get(0).column_name(), Some("id"));
    assert!(target_columns.get(0).resolved_column().is_some());
    assert!(insert.returning());
    let table_references = analyzed.table_references().unwrap();
    assert_eq!(table_references.len(), 1);
    assert_eq!(table_references.get(0).role(), TableReferenceRole::WRITE);
}
