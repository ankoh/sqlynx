//! A port of the C++ `test/cursor_test.cc`.

use dashql_buffers::parser::{AttributeKey, NodeType};
use dashql_core::catalog::{Catalog, QualifiedColumnName, QualifiedTableName};
use dashql_core::cursor::CursorContext;
use dashql_core::script::Script;

/// The expected state of a script cursor
#[derive(Default)]
struct ExpectedScriptCursor {
    /// The text of the token under the cursor, `None` if there is none
    scanner_token_text: Option<&'static str>,
    /// The statement under the cursor
    statement_id: Option<u32>,
    /// The attribute key of the AST node under the cursor
    ast_attribute_key: AttributeKey,
    /// The type of the AST node under the cursor
    ast_node_type: NodeType,
    /// The resolved or written name of the table ref under the cursor, `None` if not in a table ref
    table_ref_name: Option<&'static str>,
    /// The name of the column ref under the cursor, `None` if not in a column ref
    column_ref_name: Option<&'static str>,
}

fn join_names<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
    names.into_iter().filter(|n| !n.is_empty()).collect::<Vec<_>>().join(".")
}

fn print_table_name(name: &QualifiedTableName) -> String {
    join_names([name.database_name.text(), name.schema_name.text(), name.table_name.text()])
}

fn print_column_name(name: &QualifiedColumnName) -> String {
    join_names([name.table_alias.as_ref().map_or("", |a| a.text()), name.column_name.text()])
}

fn test(script: &mut Script, catalog: &Catalog, text_offset: usize, expected: ExpectedScriptCursor) {
    let trace = format!("CURSOR {text_offset}");
    let cursor = script.move_cursor(catalog, text_offset);
    let scanned = cursor.script.scanned.unwrap();
    let analyzed = cursor.script.analyzed.unwrap();

    // Check scanner token
    match expected.scanner_token_text {
        Some(token_text) => {
            let location = cursor.scanner_location.expect(&trace);
            let token = scanned.symbols[location.current.symbol_id as usize];
            let begin = token.location.offset as usize;
            let text = &scanned.text[begin..begin + token.location.length as usize];
            assert_eq!(text, token_text, "{trace}");
        }
        None => assert!(cursor.scanner_location.is_none(), "{trace}"),
    }
    // Check statement id
    assert_eq!(cursor.statement_id, expected.statement_id, "{trace}");
    // Check AST node type
    let ast_node = &analyzed.parsed.nodes[cursor.ast_node_id.expect(&trace) as usize];
    assert_eq!(ast_node.attribute_key(), expected.ast_attribute_key, "{trace}");
    assert_eq!(ast_node.node_type(), expected.ast_node_type, "{trace}");
    // Check table reference
    match expected.table_ref_name {
        Some(table_ref_name) => {
            let CursorContext::TableRef { table_reference_id, .. } = cursor.context else {
                panic!("{trace}: expected a table ref context, got {:?}", cursor.context);
            };
            assert!((table_reference_id as usize) < analyzed.table_references.len(), "{trace}");
            let table_ref = &analyzed.table_references[table_reference_id as usize];
            let relation = table_ref.inner.as_ref().expect(&trace);
            let table_name = match &relation.resolved_table {
                Some(resolved) => print_table_name(&resolved.table_name),
                None => print_table_name(&relation.table_name),
            };
            assert_eq!(table_name, table_ref_name, "{trace}");
        }
        None => assert!(!matches!(cursor.context, CursorContext::TableRef { .. }), "{trace}"),
    }
    // Check expression
    match expected.column_ref_name {
        Some(column_ref_name) => {
            let CursorContext::ColumnRef { expression_id } = cursor.context else {
                panic!("{trace}: expected a column ref context, got {:?}", cursor.context);
            };
            assert!((expression_id as usize) < analyzed.expressions.len(), "{trace}");
            let column_ref = analyzed.expressions[expression_id as usize].column_ref().expect(&trace);
            assert_eq!(print_column_name(&column_ref.column_name), column_ref_name, "{trace}");
        }
        None => assert!(!matches!(cursor.context, CursorContext::ColumnRef { .. }), "{trace}"),
    }
}

fn analyze(catalog: &Catalog, text: &str) -> Script {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, text);
    script.scan();
    script.parse();
    script.analyze(catalog, true).unwrap();
    script
}

#[test]
fn simple_no_external() {
    let catalog = Catalog::new();
    let mut script = analyze(&catalog, "select * from A b, C d where b.x = d.y");

    test(
        &mut script,
        &catalog,
        0,
        ExpectedScriptCursor {
            scanner_token_text: Some("select"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::NONE,
            ast_node_type: NodeType::OBJECT_SQL_SELECT,
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        9,
        ExpectedScriptCursor {
            scanner_token_text: Some("from"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::SQL_SELECT_FROM,
            ast_node_type: NodeType::ARRAY,
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        14,
        ExpectedScriptCursor {
            scanner_token_text: Some("A"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::NONE,
            ast_node_type: NodeType::NAME,
            table_ref_name: Some("a"),
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        16,
        ExpectedScriptCursor {
            scanner_token_text: Some("b"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::SQL_TABLEREF_ALIAS,
            ast_node_type: NodeType::NAME,
            table_ref_name: Some("a"),
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        23,
        ExpectedScriptCursor {
            scanner_token_text: Some("where"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::NONE,
            ast_node_type: NodeType::OBJECT_SQL_SELECT,
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        29,
        ExpectedScriptCursor {
            scanner_token_text: Some("b"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::NONE,
            ast_node_type: NodeType::NAME,
            column_ref_name: Some("b.x"),
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        30,
        ExpectedScriptCursor {
            scanner_token_text: Some("."),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::NONE,
            ast_node_type: NodeType::NAME,
            column_ref_name: Some("b.x"),
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        31,
        ExpectedScriptCursor {
            scanner_token_text: Some("x"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::NONE,
            ast_node_type: NodeType::NAME,
            column_ref_name: Some("b.x"),
            ..Default::default()
        },
    );
    test(
        &mut script,
        &catalog,
        33,
        ExpectedScriptCursor {
            scanner_token_text: Some("="),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::SQL_EXPRESSION_ARGS,
            ast_node_type: NodeType::ARRAY,
            ..Default::default()
        },
    );
}

#[test]
fn table_ref() {
    let catalog = Catalog::new();
    let mut script = analyze(&catalog, "select r_regionkey from region, n");

    test(
        &mut script,
        &catalog,
        32,
        ExpectedScriptCursor {
            scanner_token_text: Some("n"),
            statement_id: Some(0),
            ast_attribute_key: AttributeKey::NONE,
            ast_node_type: NodeType::NAME,
            table_ref_name: Some("n"),
            ..Default::default()
        },
    );
}
