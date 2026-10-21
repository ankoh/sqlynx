//! Name resolution through the FROM sources of the name scopes: derived tables, column aliases,
//! correlation, qualified stars, merged join columns and output column names.

use dashql_buffers::analyzer::AnalyzerErrorType;
use dashql_core::analyzer::{AnalyzedScript, ColumnResolution};
use dashql_core::catalog::Catalog;
use dashql_core::script::Script;
use std::sync::Arc;

/// The fixture: a catalog with the tables t, u, v and w
struct NameResolutionTest {
    /// The catalog with the schema tables
    catalog: Catalog,
    /// The schema script, kept alive while its tables are in the catalog
    _schema: Script,
}

impl NameResolutionTest {
    fn new() -> Self {
        let mut catalog = Catalog::new();
        let mut schema = Script::new(&catalog);
        schema.insert_text_at(
            0,
            "create table t (a int, b int); create table u (a int, c int); create table v (id int, x int); create table w (id int, y int);",
        );
        schema.analyze(&catalog, true).unwrap();
        catalog.load_script(schema.analyzed.clone().unwrap(), 0).unwrap();
        Self { catalog, _schema: schema }
    }

    fn analyze(&self, sql: &str) -> Arc<AnalyzedScript> {
        let mut script = Script::new(&self.catalog);
        script.insert_text_at(0, sql);
        script.analyze(&self.catalog, true).unwrap();
        assert!(script.parsed.as_ref().unwrap().errors.is_empty(), "{sql}");
        script.analyzed.clone().unwrap()
    }

    /// Describe the column refs of a script in text order. A ref is written as it is spelled,
    /// followed by the catalog column it resolves to, `local` for a column computed in the script,
    /// or `?` if unresolved.
    fn resolve(&self, sql: &str) -> Vec<String> {
        let analyzed = self.analyze(sql);
        let mut expressions: Vec<_> = analyzed.expressions.iter().collect();
        expressions.sort_by_key(|e| analyzed.parsed.nodes[e.ast_node_id as usize].symbol_span().offset());
        expressions
            .into_iter()
            .filter_map(|e| e.column_ref())
            .map(|column_ref| {
                let name = &column_ref.column_name;
                let spelled = match &name.table_alias {
                    Some(alias) => format!("{}.{}", alias.text(), name.column_name.text()),
                    None => name.column_name.text().to_string(),
                };
                let target = match (column_ref.resolved, &column_ref.resolved_ids) {
                    (ColumnResolution::Unresolved, _) => "?".to_string(),
                    (_, None) => "local".to_string(),
                    (_, Some(ids)) => {
                        let (table_id, column) = ids.catalog_table_column_id.unpack_table_column_id();
                        let table = self.catalog.table_by_id(table_id).expect("catalog table");
                        let column = &table.table_columns[column as usize];
                        format!("{}.{}", table.table_name.table_name.text(), column.column_name.text())
                    }
                };
                format!("{spelled} -> {target}")
            })
            .collect()
    }
}

#[test]
fn derived_table_columns_are_visible_through_the_alias() {
    let test = NameResolutionTest::new();
    assert_eq!(
        test.resolve("select s.a, s.z, z from (select a, b as z from t) s"),
        ["s.a -> t.a", "s.z -> t.b", "z -> t.b", "a -> t.a", "b -> t.b"]
    );
}

#[test]
fn unaliased_derived_table_columns_are_visible() {
    let test = NameResolutionTest::new();
    assert_eq!(test.resolve("select z from (select b as z from t)"), ["z -> t.b", "b -> t.b"]);
}

#[test]
fn derived_table_column_aliases_rename_by_position() {
    let test = NameResolutionTest::new();
    assert_eq!(
        test.resolve("select s.p, s.b, s.a from (select a, b from t) s(p)"),
        ["s.p -> t.a", "s.b -> t.b", "s.a -> ?", "a -> t.a", "b -> t.b"]
    );
}

#[test]
fn table_column_aliases_rename_by_position() {
    let test = NameResolutionTest::new();
    assert_eq!(test.resolve("select x.p, x.b, x.a from t as x(p)"), ["x.p -> t.a", "x.b -> t.b", "x.a -> ?"]);
}

#[test]
fn values_columns_are_named_by_the_column_aliases() {
    let test = NameResolutionTest::new();
    assert_eq!(test.resolve("select r.k, r.l from (values (1, 2)) r(k, l)"), ["r.k -> local", "r.l -> local"]);
}

#[test]
fn expression_subquery_outputs_are_not_visible() {
    let test = NameResolutionTest::new();
    assert_eq!(
        test.resolve("select c from t where a in (select c from u)"),
        ["c -> ?", "a -> t.a", "c -> u.c"]
    );
}

#[test]
fn expression_subquery_outputs_do_not_shadow_schema_inference() {
    let test = NameResolutionTest::new();
    let analyzed = test.analyze("select q from missing where id in (select q from missing2)");
    let schema = analyzed.inferred_table_schemas.iter().find(|s| s.table_name.table_name.text() == "missing").unwrap();
    let columns: Vec<_> = schema.columns.iter().map(|c| c.column_name.text()).collect();
    assert_eq!(columns, ["q", "id"]);
}

#[test]
fn expression_subqueries_correlate_with_the_parent() {
    let test = NameResolutionTest::new();
    assert_eq!(
        test.resolve("select a from t where exists (select 1 from u where u.c = t.b)"),
        ["a -> t.a", "u.c -> u.c", "t.b -> t.b"]
    );
}

#[test]
fn derived_tables_do_not_correlate_with_their_siblings() {
    let test = NameResolutionTest::new();
    assert_eq!(test.resolve("select * from t, (select t.a as k) s"), ["t.a -> ?"]);
    assert_eq!(test.resolve("select * from t, lateral (select t.a as k) s"), ["t.a -> t.a"]);
    // A lateral derived table only sees the FROM items before it
    assert_eq!(test.resolve("select * from lateral (select t.a as k) s, t"), ["t.a -> ?"]);
}

#[test]
fn derived_tables_correlate_with_outer_queries() {
    let test = NameResolutionTest::new();
    assert_eq!(
        test.resolve("select (select s.k from (select t.a as k) s) from t"),
        ["s.k -> t.a", "t.a -> t.a"]
    );
}

#[test]
fn ctes_do_not_correlate_with_the_from_clause() {
    let test = NameResolutionTest::new();
    // c.k is the column of the CTE, which has no catalog column
    assert_eq!(test.resolve("with c as (select t.b as k) select c.k from t, c"), ["t.b -> ?", "c.k -> local"]);
}

#[test]
fn qualified_star_forwards_the_columns_of_one_source() {
    let test = NameResolutionTest::new();
    let resolved = test.resolve("select q.c, q.a from (select s.* from t, (select c from u) s) q");
    // The qualifier of s.* is no column ref
    assert_eq!(resolved, ["q.c -> u.c", "q.a -> ?", "c -> u.c"]);
}

#[test]
fn qualified_star_is_no_column_of_an_unresolved_table() {
    let test = NameResolutionTest::new();
    let analyzed = test.analyze("select m.* from missing m");
    assert!(analyzed.inferred_table_schemas.is_empty());
}

#[test]
fn star_forwards_sources_in_from_order() {
    let test = NameResolutionTest::new();
    // Both t and the derived table provide a, the first one in FROM order wins
    assert_eq!(
        test.resolve("select q.a, q.c from (select * from (select c, a from u) s, t) q"),
        ["q.a -> u.a", "q.c -> u.c", "c -> u.c", "a -> u.a"]
    );
}

#[test]
fn using_columns_are_not_ambiguous() {
    let test = NameResolutionTest::new();
    let analyzed = test.analyze("select id, x, y from v join w using (id)");
    assert!(analyzed.errors.is_empty(), "{:?}", analyzed.errors);
    assert_eq!(test.resolve("select id, x, y from v join w using (id)"), ["id -> v.id", "x -> v.x", "y -> w.y"]);
    assert_eq!(test.resolve("select id from v natural join w"), ["id -> v.id"]);
}

#[test]
fn columns_outside_of_using_stay_ambiguous() {
    let test = NameResolutionTest::new();
    let analyzed = test.analyze("select id from v, w");
    assert_eq!(analyzed.errors.len(), 1);
    assert_eq!(analyzed.errors[0].error_type, AnalyzerErrorType::COLUMN_REF_AMBIGUOUS);
    let analyzed = test.analyze("select a from t join u using (b)");
    assert_eq!(analyzed.errors.len(), 1);
    assert_eq!(analyzed.errors[0].error_type, AnalyzerErrorType::COLUMN_REF_AMBIGUOUS);
}

#[test]
fn order_by_prefers_output_columns() {
    let test = NameResolutionTest::new();
    assert_eq!(test.resolve("select a + 1 as n from t order by n"), ["a -> t.a", "n -> local"]);
    assert_eq!(test.resolve("select b as a from t order by a"), ["b -> t.b", "a -> t.b"]);
    // Only bare names refer to output columns
    assert_eq!(test.resolve("select b as n from t order by n + 1"), ["b -> t.b", "n -> ?"]);
}

#[test]
fn group_by_prefers_input_columns() {
    let test = NameResolutionTest::new();
    assert_eq!(test.resolve("select b as a from t group by a"), ["b -> t.b", "a -> t.a"]);
    assert_eq!(test.resolve("select b as n from t group by n"), ["b -> t.b", "n -> t.b"]);
}

#[test]
fn set_operations_order_by_the_left_output_columns() {
    let test = NameResolutionTest::new();
    assert_eq!(
        test.resolve("select a from t union select c from u order by a"),
        ["a -> t.a", "c -> u.c", "a -> t.a"]
    );
}

#[test]
fn computed_columns_keep_their_position() {
    let test = NameResolutionTest::new();
    assert_eq!(
        test.resolve("with c(p, q) as (select case when a > 0 then 1 end, b from t) select c.q from c"),
        ["a -> t.a", "b -> t.b", "c.q -> t.b"]
    );
}
