//! Tests of the script compiler: the executable SQL of a script, its statements and the compiled
//! visualization of a terminal VISUALIZE statement.

use dashql_buffers::execution::{
    CompiledScriptStatementKind as CompiledKind, ScriptCompilationErrorCode as ErrorCode, ScriptCompilationResultT,
    ScriptCompilationStatementKind as StatementKind,
};
use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode};
use dashql_buffers::parser::StatementType;
use dashql_core::catalog::{Catalog, PROTO_NULL_U32};
use dashql_core::compiler::{compile, read_executable_text, CompilationOptions};
use dashql_core::script::Script;
use dashql_parser::span::TextSpan;

fn config() -> FormattingConfigT {
    let mut config = FormattingConfigT::default();
    config.mode = FormattingMode::INLINE;
    config.dialect = FormattingDialect::HYPER;
    config
}

fn compile_with(text: &str, options: CompilationOptions) -> ScriptCompilationResultT {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text(text);
    compile(&mut script, &catalog, &config(), options)
}

fn compile_text(text: &str) -> ScriptCompilationResultT {
    compile_with(text, CompilationOptions::default())
}

fn error_codes(result: &ScriptCompilationResultT) -> Vec<ErrorCode> {
    result.errors.as_ref().unwrap().iter().map(|e| e.code).collect()
}

fn statement_sqls(result: &ScriptCompilationResultT) -> Vec<&str> {
    result.statements.as_ref().unwrap().iter().map(|s| s.sql.as_deref().unwrap()).collect()
}

#[test]
fn default_options_allow_extensions_and_parse() {
    let options = CompilationOptions::default();
    assert!(options.allow_extensions);
    assert!(options.parse_if_outdated);
}

#[test]
fn empty_script_is_an_error() {
    let result = compile_text("");
    assert_eq!(error_codes(&result), vec![ErrorCode::EMPTY_SCRIPT]);
    assert_eq!(result.terminal_statement_id, PROTO_NULL_U32);
    assert_eq!(result.sql.as_deref(), Some(""));
    assert!(result.statements.as_ref().unwrap().is_empty());
}

#[test]
fn unparsed_script_without_parse_is_an_error() {
    let result = compile_with("select 1", CompilationOptions { allow_extensions: true, parse_if_outdated: false });
    assert_eq!(error_codes(&result), vec![ErrorCode::EMPTY_SCRIPT]);
    assert_eq!(result.errors.as_ref().unwrap()[0].message.as_deref(), Some("script is not parsed"));
}

#[test]
fn outdated_parse_is_refreshed() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select 1");
    script.parse();
    script.replace_text("select 2");
    let result = compile(&mut script, &catalog, &config(), CompilationOptions::default());
    assert!(result.errors.as_ref().unwrap().is_empty());
    assert_eq!(result.sql.as_deref(), Some("select 2"));
}

#[test]
fn single_query() {
    let result = compile_text("select 1");
    assert!(result.errors.as_ref().unwrap().is_empty());
    assert_eq!(result.kind, StatementKind::QUERY);
    assert_eq!(result.terminal_statement_id, 0);
    assert!(result.cacheable);
    assert_eq!(result.sql.as_deref(), Some("select 1"));
    let statements = result.statements.as_ref().unwrap();
    assert_eq!(statements.len(), 1);
    assert_eq!(statements[0].kind, CompiledKind::OUTPUT);
    assert_eq!(statements[0].statement_type, StatementType::SELECT);
    assert!(!result.cache_signature.as_deref().unwrap().is_empty());
}

#[test]
fn commands_precede_the_terminal_query() {
    let result = compile_text("create table t (a int); insert into t values (1); select a from t;");
    assert!(result.errors.as_ref().unwrap().is_empty());
    assert_eq!(result.terminal_statement_id, 2);
    assert_eq!(result.sql.as_deref(), Some("select a from t"));
    let kinds: Vec<_> = result.statements.as_ref().unwrap().iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec![CompiledKind::COMMAND, CompiledKind::COMMAND, CompiledKind::OUTPUT]);
    let types: Vec<_> = result.statements.as_ref().unwrap().iter().map(|s| s.statement_type).collect();
    assert_eq!(types, vec![StatementType::CREATE_TABLE, StatementType::INSERT, StatementType::SELECT]);
    assert_eq!(statement_sqls(&result)[0], "create table t (a int)");
}

#[test]
fn script_of_commands_is_not_cacheable() {
    let result = compile_text("create table t (a int)");
    assert!(result.errors.as_ref().unwrap().is_empty());
    assert!(!result.cacheable);
    assert_eq!(result.statements.as_ref().unwrap()[0].kind, CompiledKind::COMMAND);
}

#[test]
fn returning_statements_produce_output() {
    let result = compile_text("create table t (a int); insert into t values (1) returning a;");
    assert!(result.errors.as_ref().unwrap().is_empty());
    assert_eq!(result.statements.as_ref().unwrap()[1].kind, CompiledKind::OUTPUT);

    let result = compile_text("create table t (a int); delete from t where a = 1 returning a;");
    assert!(result.errors.as_ref().unwrap().is_empty());
    assert_eq!(result.statements.as_ref().unwrap()[1].kind, CompiledKind::OUTPUT);

    // Without RETURNING they are commands
    let result = compile_text("create table t (a int); insert into t values (1); delete from t");
    let kinds: Vec<_> = result.statements.as_ref().unwrap().iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec![CompiledKind::COMMAND; 3]);
}

#[test]
fn output_statement_must_be_last() {
    let result = compile_text("select 1; select 2;");
    assert_eq!(error_codes(&result), vec![ErrorCode::OUTPUT_STATEMENT_NOT_LAST]);
    let error = &result.errors.as_ref().unwrap()[0];
    assert_eq!(error.statement_id, 0);
    assert!(error.text_span.is_some());
    // The offending statement is dropped, the terminal one is kept
    assert_eq!(result.terminal_statement_id, 1);
    assert_eq!(result.statements.as_ref().unwrap().len(), 1);
}

#[test]
fn explain_produces_output() {
    let result = compile_text("explain select 1; select 2");
    assert_eq!(error_codes(&result), vec![ErrorCode::OUTPUT_STATEMENT_NOT_LAST]);
    let result = compile_text("explain select 1");
    assert!(result.errors.as_ref().unwrap().is_empty());
    assert!(result.cacheable);
}

#[test]
fn parser_errors_keep_the_original_text() {
    let result = compile_text("select 1 +;");
    assert_eq!(error_codes(&result), vec![ErrorCode::PARSER_ERROR]);
    assert!(result.errors.as_ref().unwrap()[0].text_span.is_some());
    assert_eq!(result.sql.as_deref(), Some("select 1 +;"));
    assert_eq!(result.terminal_statement_id, 0);
    let statements = result.statements.as_ref().unwrap();
    assert_eq!(statements.len(), 1);
    assert_eq!(statements[0].kind, CompiledKind::OUTPUT);
    assert!(!result.cacheable);
}

#[test]
fn scanner_errors_are_reported() {
    let result = compile_text("select 'unterminated");
    assert!(error_codes(&result).contains(&ErrorCode::SCANNER_ERROR));
    assert_eq!(result.sql.as_deref(), Some("select 'unterminated"));
}

#[test]
fn blank_text_with_errors_has_no_statement() {
    // Whitespace-only text has no error, an unterminated comment has one but nothing to execute
    let result = compile_text("   ");
    assert_eq!(error_codes(&result), vec![ErrorCode::EMPTY_SCRIPT]);
}

#[test]
fn extensions_can_be_disabled() {
    let text = "select 1 visualize using table ()";
    let result = compile_with(text, CompilationOptions { allow_extensions: false, parse_if_outdated: true });
    assert_eq!(error_codes(&result), vec![ErrorCode::EXTENSIONS_DISABLED]);
    assert!(result.statements.as_ref().unwrap().is_empty());
    let result = compile_text(text);
    assert!(result.errors.as_ref().unwrap().is_empty());
}

#[test]
fn visualize_table() {
    let result = compile_text("select 1 as a visualize using table (dashboard => (row => 2, column => 3, width => 4, height => 5))");
    assert!(result.errors.as_ref().unwrap().is_empty(), "{:?}", result.errors);
    assert_eq!(result.kind, StatementKind::VISUALIZE);
    // The SQL excludes the VISUALIZE clause
    assert_eq!(result.sql.as_deref(), Some("select 1 as a"));
    assert!(result.cacheable);
    let visualization = result.visualization.as_ref().unwrap();
    assert_eq!(visualization.renderer.as_deref(), Some("table"));
    assert!(visualization.table_spec.is_some());
    let dashboard = visualization.dashboard.as_ref().unwrap();
    assert_eq!((dashboard.row, dashboard.column, dashboard.width, dashboard.height), (Some(2), Some(3), 4, 5));
    let terminal = result.statements.as_ref().unwrap().last().unwrap();
    assert_eq!(terminal.kind, CompiledKind::VISUALIZE);
    assert_eq!(terminal.sql.as_deref(), Some("select 1 as a"));
    assert!(terminal.visualization.is_some());
}

#[test]
fn visualize_vegalite() {
    let result = compile_text("select 1 as a, 2 as b visualize using vegalite (mark => bar)");
    assert!(result.errors.as_ref().unwrap().is_empty(), "{:?}", result.errors);
    let visualization = result.visualization.as_ref().unwrap();
    assert_eq!(visualization.renderer.as_deref(), Some("vegalite"));
    let spec: serde_json::Value = serde_json::from_str(visualization.vegalite_spec.as_deref().unwrap()).unwrap();
    assert_eq!(spec["mark"], "bar");
}

#[test]
fn visualize_markdown() {
    let result = compile_text("select 'Ada' as author visualize using markdown (template => 'by {{author}}')");
    assert!(result.errors.as_ref().unwrap().is_empty(), "{:?}", result.errors);
    let visualization = result.visualization.as_ref().unwrap();
    assert_eq!(visualization.renderer.as_deref(), Some("markdown"));
    assert!(visualization.markdown_spec.is_some());
}

#[test]
fn visualize_umap() {
    let result = compile_text("create table e (v float[]); select v from e visualize using umap (vector => v)");
    assert!(result.errors.as_ref().unwrap().is_empty(), "{:?}", result.errors);
    let visualization = result.visualization.as_ref().unwrap();
    assert_eq!(visualization.renderer.as_deref(), Some("umap"));
    assert!(visualization.umap_spec.is_some());
}

#[test]
fn visualize_umap_requires_a_vector() {
    let result = compile_text("select 1 as v visualize using umap ()");
    assert_eq!(error_codes(&result), vec![ErrorCode::VISUALIZATION_METADATA_UNAVAILABLE]);
    assert_eq!(result.sql.as_deref(), Some(""));
    assert!(result.visualization.is_none());
}

#[test]
fn executable_text_replaces_obfuscated_literals() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select /*String(C5FA)*/, /*Integer(FCD0)*/");
    script.scan();
    let scanned = script.scanned.as_ref().unwrap();
    let text = read_executable_text(scanned, TextSpan::new(0, scanned.text.len() as u32));
    assert!(!text.contains("/*"), "{text}");
    assert!(text.starts_with("select "));
    // A span that ends within a marker leaves it untouched
    let partial = read_executable_text(scanned, TextSpan::new(0, 10));
    assert_eq!(partial, "select /*S");
}
