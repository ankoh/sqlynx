//! Catalog changes of successful statements: derivation, compaction, the changes SQL, and
//! applying the changes to descriptor entries.

use dashql_buffers::analyzer::{QualifiedTableNameT, TableColumnT, TableT};
use dashql_buffers::catalog::{CatalogChangeT, CatalogChangeType, CatalogDescriptorT};
use dashql_buffers::editor::EditorOffsetUnit;
use dashql_buffers::execution::{StatementResultStatus, StatementResultT};
use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode};
use dashql_core::catalog::changes::{
    append_catalog_changes_sql, compact_catalog_changes, derive_catalog_change, parse_catalog_changes_sql, qualify_catalog_changes,
    render_catalog_changes_sql, CatalogChangeOptions, CatalogNameDefaults,
};
use dashql_core::catalog::{Catalog, CatalogEntryId};
use dashql_core::script::Script;
use dashql_core::script_execution::ScriptExecution;
use dashql_core::script_session::ScriptSession;
use std::cell::RefCell;
use std::rc::Rc;

fn defaults() -> CatalogNameDefaults {
    CatalogNameDefaults {
        database_name: "db".to_string(),
        schema_name: "main".to_string(),
    }
}

/// Describe a change as `create db.schema.relation(a, b)` or `drop db.schema.relation`
fn describe(change: &CatalogChangeT) -> String {
    let name = format!(
        "{}.{}.{}",
        change.database_name.as_deref().unwrap_or(""),
        change.schema_name.as_deref().unwrap_or(""),
        change.relation_name.as_deref().unwrap_or("")
    );
    match change.change_type {
        CatalogChangeType::CREATE_RELATION => format!(
            "create{} {}({})",
            if change.if_not_exists { " if not exists" } else { "" },
            name,
            change.column_names.as_deref().unwrap_or(&[]).join(", ")
        ),
        CatalogChangeType::DROP_RELATION => format!("drop {name}"),
        _ => "none".to_string(),
    }
}

/// Derive the changes of every statement of a script and qualify them with the defaults
fn derive_all(catalog: &Catalog, text: &str, options: &CatalogChangeOptions) -> Vec<Option<String>> {
    let mut script = Script::new(catalog);
    script.replace_text(text);
    script.analyze(catalog, true).unwrap();
    let analyzed = script.analyzed.clone().unwrap();
    (0..analyzed.parsed.statements.len())
        .map(|id| {
            let mut change = [derive_catalog_change(&analyzed, id, options)?];
            qualify_catalog_changes(&mut change, &defaults());
            Some(describe(&change[0]))
        })
        .collect()
}

fn create(database: &str, schema: &str, relation: &str, columns: &[&str]) -> CatalogChangeT {
    let mut change = CatalogChangeT::default();
    change.change_type = CatalogChangeType::CREATE_RELATION;
    change.database_name = Some(database.to_string());
    change.schema_name = Some(schema.to_string());
    change.relation_name = Some(relation.to_string());
    change.column_names = Some(columns.iter().map(|c| c.to_string()).collect());
    change
}

fn create_if_not_exists(database: &str, schema: &str, relation: &str, columns: &[&str]) -> CatalogChangeT {
    let mut change = create(database, schema, relation, columns);
    change.if_not_exists = true;
    change
}

fn drop(database: &str, schema: &str, relation: &str) -> CatalogChangeT {
    let mut change = CatalogChangeT::default();
    change.change_type = CatalogChangeType::DROP_RELATION;
    change.database_name = Some(database.to_string());
    change.schema_name = Some(schema.to_string());
    change.relation_name = Some(relation.to_string());
    change
}

fn table(database: &str, schema: &str, name: &str, columns: &[&str]) -> TableT {
    let mut table_name = QualifiedTableNameT::default();
    table_name.database_name = Some(database.to_string());
    table_name.schema_name = Some(schema.to_string());
    table_name.table_name = Some(name.to_string());
    let mut table = TableT::default();
    table.table_name = Some(Box::new(table_name));
    table.table_columns = Some(
        columns
            .iter()
            .map(|c| {
                let mut column = TableColumnT::default();
                column.column_name = Some(c.to_string());
                column
            })
            .collect(),
    );
    table
}

/// Load a descriptor with the tables into the catalog
fn add_descriptor(catalog: &mut Catalog, rank: u32, tables: Vec<TableT>) -> CatalogEntryId {
    let mut descriptor = CatalogDescriptorT::default();
    descriptor.tables = Some(tables);
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = descriptor.pack(&mut builder);
    builder.finish(packed, None);
    let id = catalog.allocate_entry_id();
    catalog.replace_descriptor(id, rank, builder.finished_data()).unwrap();
    id
}

/// The tables of a catalog entry as `db.schema.table(a, b)`
fn tables_of(catalog: &Catalog, id: CatalogEntryId) -> Vec<String> {
    let mut out = Vec::new();
    let Some(entries) = catalog.describe_entries_of(id) else { return out };
    for entry in entries.entries.unwrap_or_default() {
        for schema in entry.schemas.unwrap_or_default() {
            for table in schema.tables.unwrap_or_default() {
                let columns: Vec<String> =
                    table.columns.unwrap_or_default().into_iter().map(|c| c.column_name.unwrap_or_default()).collect();
                out.push(format!(
                    "{}.{}.{}({})",
                    schema.database_name.as_deref().unwrap_or(""),
                    schema.schema_name.as_deref().unwrap_or(""),
                    table.table_name.unwrap_or_default(),
                    columns.join(", ")
                ));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn derives_created_and_dropped_relations() {
    let catalog = Catalog::new();
    let changes = derive_all(
        &catalog,
        "create table orders (id int, amount double, customer text);
         create table sales.totals as select id, amount as total from orders;
         create view other.reporting.report as select id, amount as total from orders;
         select id as copied_id into copies from orders;
         insert into orders values (1, 2.0, 'a');
         drop table orders;
         drop view other.reporting.report;
         select 1;",
        &CatalogChangeOptions::default(),
    );
    assert_eq!(
        changes,
        vec![
            Some("create db.main.orders(id, amount, customer)".to_string()),
            Some("create db.sales.totals(id, total)".to_string()),
            Some("create other.reporting.report(id, total)".to_string()),
            Some("create db.main.copies(copied_id)".to_string()),
            None,
            Some("drop db.main.orders".to_string()),
            Some("drop other.reporting.report".to_string()),
            None,
        ]
    );
}

#[test]
fn derives_if_not_exists_and_temporary_relations() {
    let catalog = Catalog::new();
    let text = "create table if not exists t (a int);
                create temp table session_only (a int);
                create unlogged table persistent (a int);
                create temporary view v as select 1 as x;
                select 1 as y into temp copies;";
    assert_eq!(
        derive_all(&catalog, text, &CatalogChangeOptions::default()),
        vec![
            Some("create if not exists db.main.t(a)".to_string()),
            None,
            Some("create db.main.persistent(a)".to_string()),
            None,
            None,
        ]
    );
    let with_temporary = CatalogChangeOptions { include_temporary: true };
    assert_eq!(
        derive_all(&catalog, text, &with_temporary),
        vec![
            Some("create if not exists db.main.t(a)".to_string()),
            Some("create db.main.session_only(a)".to_string()),
            Some("create db.main.persistent(a)".to_string()),
            Some("create db.main.v(x)".to_string()),
            Some("create db.main.copies(y)".to_string()),
        ]
    );
}

#[test]
fn derives_relations_as_written() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("create table t (a int); drop table s.u;");
    script.analyze(&catalog, true).unwrap();
    let analyzed = script.analyzed.clone().unwrap();
    let options = CatalogChangeOptions::default();
    let mut changes: Vec<CatalogChangeT> = (0..2).filter_map(|id| derive_catalog_change(&analyzed, id, &options)).collect();
    assert_eq!(changes.iter().map(describe).collect::<Vec<_>>(), vec!["create ..t(a)", "drop .s.u"]);
    qualify_catalog_changes(&mut changes, &defaults());
    assert_eq!(changes.iter().map(describe).collect::<Vec<_>>(), vec!["create db.main.t(a)", "drop db.s.u"]);
}

#[test]
fn compacts_to_the_last_change_of_every_relation() {
    let compacted = compact_catalog_changes(vec![
        create("db", "main", "a", &["x"]),
        create("db", "main", "b", &["x"]),
        create_if_not_exists("db", "main", "a", &["y"]),
        drop("db", "main", "b"),
        create_if_not_exists("db", "main", "b", &["z"]),
        create_if_not_exists("db", "main", "c", &["w"]),
        drop("db", "main", "d"),
    ]);
    let described: Vec<String> = compacted.iter().map(describe).collect();
    assert_eq!(
        described,
        vec![
            // IF NOT EXISTS keeps a relation that was just created
            "create db.main.a(x)",
            // ... and creates one that was just dropped
            "create db.main.b(z)",
            // ... and stays conditional for relations of the base catalog
            "create if not exists db.main.c(w)",
            "drop db.main.d",
        ]
    );
}

#[test]
fn changes_roundtrip_through_sql() {
    let changes = vec![
        create("db", "main", "orders", &["id", "Mixed Case", "quote\"d"]),
        create_if_not_exists("db", "main", "maybe", &["a"]),
        create("db", "main", "empty", &[]),
        drop("db", "main", "gone"),
    ];
    let changes_sql = render_catalog_changes_sql(&changes);
    assert_eq!(
        changes_sql,
        "-- Catalog changes of executed statements

CREATE TABLE \"db\".\"main\".\"orders\" (
    \"id\" VARCHAR,
    \"Mixed Case\" VARCHAR,
    \"quote\"\"d\" VARCHAR
);

CREATE TABLE IF NOT EXISTS \"db\".\"main\".\"maybe\" (
    \"a\" VARCHAR
);

CREATE TABLE \"db\".\"main\".\"empty\" ();

DROP TABLE \"db\".\"main\".\"gone\";
"
    );
    let parsed: Vec<String> = parse_catalog_changes_sql(&changes_sql).unwrap().iter().map(describe).collect();
    let expected: Vec<String> = changes.iter().map(describe).collect();
    assert_eq!(parsed, expected);
}

#[test]
fn appends_to_changes_sql() {
    let changes_sql = append_catalog_changes_sql("", &[create("db", "main", "a", &["x"]), create("db", "main", "b", &["y"])]).unwrap();
    let changes_sql = append_catalog_changes_sql(&changes_sql, &[drop("db", "main", "a")]).unwrap();
    let described: Vec<String> = parse_catalog_changes_sql(&changes_sql).unwrap().iter().map(describe).collect();
    assert_eq!(described, vec!["create db.main.b(y)", "drop db.main.a"]);
    assert!(parse_catalog_changes_sql("create table (").is_err());
}

#[test]
fn applies_changes_to_a_descriptor_entry() {
    let mut catalog = Catalog::new();
    let id = add_descriptor(&mut catalog, 10, vec![table("db", "main", "kept", &["a"]), table("db", "main", "gone", &["b"])]);
    catalog
        .apply_catalog_changes(
            id,
            10,
            &[
                drop("db", "main", "gone"),
                create("db", "main", "added", &["x", "y", "x"]),
                create_if_not_exists("db", "main", "kept", &["replaced"]),
                create("db", "other", "kept", &["c"]),
            ],
        )
        .unwrap();
    assert_eq!(tables_of(&catalog, id), vec!["db.main.added(x, y)", "db.main.kept(a)", "db.other.kept(c)"]);

    // A replacement takes the new columns
    catalog.apply_catalog_changes(id, 10, &[create("db", "main", "kept", &["new"])]).unwrap();
    assert_eq!(tables_of(&catalog, id), vec!["db.main.added(x, y)", "db.main.kept(new)", "db.other.kept(c)"]);
}

#[test]
fn applying_changes_creates_an_unknown_entry() {
    let mut catalog = Catalog::new();
    let id = catalog.allocate_entry_id();
    catalog.apply_catalog_changes(id, 10, &[create("db", "main", "t", &["a"]), drop("db", "main", "u")]).unwrap();
    assert_eq!(tables_of(&catalog, id), vec!["db.main.t(a)"]);

    // Scripts are not descriptor entries
    let mut script = Script::new(&catalog);
    script.replace_text("create table s (a int);");
    script.analyze(&catalog, true).unwrap();
    catalog.load_script(script.analyzed.clone().unwrap(), 10).unwrap();
    assert!(catalog.apply_catalog_changes(script.catalog_entry_id(), 10, &[drop("db", "main", "s")]).is_err());
}

#[test]
fn execution_reports_the_changes_of_succeeded_statements() {
    let catalog = Rc::new(RefCell::new(Catalog::new()));
    let mut session = ScriptSession::new(catalog, EditorOffsetUnit::UTF8_BYTES).unwrap();
    session.replace_text(0, "create table t (v int); drop table u; select * from t;");
    let mut config = FormattingConfigT::default();
    config.mode = FormattingMode::INLINE;
    config.dialect = FormattingDialect::HYPER;
    let mut execution = ScriptExecution::new(&mut session, config);

    let succeed = |execution: &mut ScriptExecution, id: u64| {
        let mut result = StatementResultT::default();
        result.pending_statement_id = id;
        result.status = StatementResultStatus::SUCCEEDED;
        execution.resume(&result)
    };
    let operation = execution.start();
    assert!(operation.catalog_changes.is_none());
    let operation = succeed(&mut execution, operation.pending_statement.as_ref().unwrap().id);
    let changes: Vec<String> = operation.catalog_changes.iter().flatten().map(describe).collect();
    assert_eq!(changes, vec!["create ..t(v)"]);

    // A failed statement changes nothing
    let mut failed = StatementResultT::default();
    failed.pending_statement_id = operation.pending_statement.as_ref().unwrap().id;
    failed.status = StatementResultStatus::FAILED;
    let operation = execution.resume(&failed);
    assert!(operation.catalog_changes.is_none());
}
