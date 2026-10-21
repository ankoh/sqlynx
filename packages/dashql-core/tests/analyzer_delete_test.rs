//! A port of the C++ `test/analyzer_delete_test.cc`.

use dashql_buffers::analyzer::TableReferenceRole;
use dashql_core::analyzer::{AnalyzedScript, ColumnRef, TableRole};
use dashql_core::catalog::Catalog;
use dashql_core::pack::{pack_analyzed_script, pack_visualization};
use dashql_core::script::Script;
use std::sync::Arc;

/// The fixture: a catalog with the tables target, source and audit
struct AnalyzerDeleteTest {
    /// The catalog with the schema tables
    catalog: Catalog,
    /// The schema script, kept alive while its tables are in the catalog
    _schema: Script,
}

impl AnalyzerDeleteTest {
    fn new() -> Self {
        let mut catalog = Catalog::new();
        let mut schema = Script::new(&catalog);
        schema.insert_text_at(
            0,
            "create table target (id int, label text); create table source (id int, source_only text); create table audit (id int);",
        );
        schema.analyze(&catalog, true).unwrap();
        catalog.load_script(schema.analyzed.clone().unwrap(), 0).unwrap();
        Self { catalog, _schema: schema }
    }

    fn analyze(&self, sql: &str) -> Arc<AnalyzedScript> {
        let mut script = Script::new(&self.catalog);
        script.insert_text_at(0, sql);
        script.analyze(&self.catalog, true).unwrap();
        assert!(script.parsed.as_ref().unwrap().errors.is_empty());
        script.analyzed.clone().unwrap()
    }
}

/// The column refs of the analyzed script
fn column_refs(analyzed: &AnalyzedScript) -> impl Iterator<Item = &ColumnRef> {
    analyzed.expressions.iter().filter_map(|e| e.column_ref())
}

/// The number of unresolved relations in all name scopes
fn unresolved_reads(analyzed: &AnalyzedScript) -> usize {
    analyzed
        .name_scopes
        .iter()
        .flat_map(|scope| scope.sources.iter())
        .filter(|source| source.table.is_unresolved_relation())
        .count()
}

#[test]
fn resolves_write_target_and_using_reads() {
    let test = AnalyzerDeleteTest::new();
    let analyzed = test.analyze("delete from target as t using source as s where t.id = s.id returning t.label, s.source_only");
    assert_eq!(analyzed.table_references.len(), 2);
    for reference in &analyzed.table_references {
        let relation = reference.inner.as_ref().expect("relation expression");
        let expected_role = if relation.table_name.table_name.text() == "target" { TableRole::Write } else { TableRole::Read };
        assert_eq!(reference.role, expected_role);
        assert!(relation.resolved_table.is_some());
        assert_eq!(reference.ast_statement_id, Some(0));
    }
    assert_eq!(analyzed.expressions.len(), 4);
    for expression in &analyzed.expressions {
        let column = expression.column_ref().expect("column ref");
        assert!(column.resolved.is_resolved(), "{}", column.column_name.column_name.text());
    }

    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = pack_analyzed_script(&analyzed, &pack_visualization).pack(&mut builder);
    builder.finish(packed, None);
    let packed = flatbuffers::root::<dashql_buffers::analyzer::AnalyzedScript>(builder.finished_data()).unwrap();
    let packed_refs = packed.table_references().unwrap();
    assert_eq!(packed_refs.len(), 2);
    for i in 0..2 {
        let expected = if analyzed.table_references[i].role == TableRole::Write {
            TableReferenceRole::WRITE
        } else {
            TableReferenceRole::READ
        };
        assert_eq!(packed_refs.get(i).role(), expected);
    }
}

#[test]
fn resolves_correlated_where_and_returning_subqueries() {
    let test = AnalyzerDeleteTest::new();
    let analyzed = test.analyze(
        "delete from target t using source s where exists (select 1 from audit a where a.id = t.id) \
         returning (select a.id from audit a where a.id = s.id) as deleted_id",
    );
    assert_eq!(analyzed.table_references.len(), 4);
    let writes = analyzed.table_references.iter().filter(|r| r.role == TableRole::Write).count();
    assert_eq!(writes, 1);
    let mut columns = 0;
    for column in column_refs(&analyzed) {
        columns += 1;
        assert!(column.resolved.is_resolved(), "{}", column.column_name.column_name.text());
    }
    assert_eq!(columns, 5);
}

#[test]
fn leading_ctes_resolve_in_order_but_cannot_see_delete_relations() {
    let test = AnalyzerDeleteTest::new();
    let analyzed = test.analyze(
        "with first as (select id from source), second as (select id from first), isolated as (select label) \
         delete from target t using second s where t.id = s.id returning t.id",
    );
    assert_eq!(analyzed.table_references.len(), 4);
    for expression in &analyzed.expressions {
        let column = expression.column_ref().expect("column ref");
        assert_eq!(column.resolved.is_resolved(), column.column_name.column_name.text() != "label");
    }
}

#[test]
fn cte_does_not_shadow_write_target() {
    let test = AnalyzerDeleteTest::new();
    let analyzed = test.analyze(
        "with target as (select 1 as cte_only) delete from target t using target s where t.id = s.cte_only returning t.label",
    );
    assert_eq!(analyzed.table_references.len(), 2);
    for reference in analyzed.table_references.iter().filter(|r| r.role == TableRole::Write) {
        let target = reference.inner.as_ref().expect("relation expression");
        assert!(target.resolved_table.is_some());
    }
    for column in column_refs(&analyzed) {
        assert!(column.resolved.is_resolved());
    }
}

#[test]
fn non_recursive_ctes_do_not_resolve_self_or_forward_references() {
    let test = AnalyzerDeleteTest::new();
    let analyzed =
        test.analyze("with first as (select * from later), later as (select * from later) delete from target using first");
    assert_eq!(unresolved_reads(&analyzed), 2);
}

#[test]
fn recursive_cte_and_using_join_resolve_columns() {
    let test = AnalyzerDeleteTest::new();
    let analyzed = test.analyze(
        "with recursive ids as (select 1 as id union all select id + 1 from ids where id < 3) \
         delete from target t using ids i join source s on i.id = s.id where t.id = i.id returning t.label",
    );
    for column in column_refs(&analyzed) {
        assert!(column.resolved.is_resolved(), "{}", column.column_name.column_name.text());
    }
}

#[test]
fn inner_aliases_shadow_target_during_correlation() {
    let test = AnalyzerDeleteTest::new();
    let analyzed = test
        .analyze("delete from target t where exists (select 1 from source t where t.source_only = 'x') returning t.label");
    for column in column_refs(&analyzed) {
        assert!(column.resolved.is_resolved());
    }
}

#[test]
fn child_outputs_do_not_leak_into_delete_scope() {
    let test = AnalyzerDeleteTest::new();
    let analyzed =
        test.analyze("delete from target t where exists (select 1 as subquery_only) returning subquery_only, target.id");
    let unresolved_columns = column_refs(&analyzed).filter(|c| !c.resolved.is_resolved()).count();
    assert_eq!(unresolved_columns, 2);
}

#[test]
fn unresolved_target_remains_write_and_statements_are_isolated() {
    let test = AnalyzerDeleteTest::new();
    let analyzed = test.analyze(
        "delete from missing m where m.id = 1 returning m.id; delete from target where m.id = 2 returning id",
    );
    assert_eq!(analyzed.table_references.len(), 2);
    assert_eq!(analyzed.table_references[0].role, TableRole::Write);
    assert_eq!(analyzed.table_references[1].role, TableRole::Write);
    assert_eq!(analyzed.table_references[0].ast_statement_id, Some(0));
    assert_eq!(analyzed.table_references[1].ast_statement_id, Some(1));
    let missing = analyzed.table_references[0].inner.as_ref().expect("relation expression");
    assert!(missing.resolved_table.is_none());
    let last = analyzed.expressions[3].column_ref().expect("column ref");
    assert!(last.resolved.is_resolved());
}
