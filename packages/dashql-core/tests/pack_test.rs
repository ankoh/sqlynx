//! Tests of the FlatBuffer packing of scripts, cursors and completions: the object API values that
//! the JS bindings read.

use dashql_buffers::algebra::ExpressionSubTypeT;
use dashql_buffers::completion::CompletionCandidateObjectType;
use dashql_buffers::cursor::{RelativeSymbolPosition, ScriptCursorContextT};
use dashql_buffers::parser::{
    ParsedScriptT, ScannerTokenType, StatementTargetType, StatementT, StatementType,
};
use dashql_core::analyzer::AnalyzedScript;
use dashql_core::catalog::Catalog;
use dashql_core::pack::{
    has_visualize, pack_analyzed_script, pack_completion, pack_cursor, pack_parsed_script, pack_parsed_statement,
    pack_scanned_script, pack_tokens, pack_visualization,
};
use dashql_core::script::Script;
use std::sync::Arc;

fn parsed(text: &str) -> (Script, ParsedScriptT) {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text(text);
    script.parse();
    let packed = pack_parsed_script(script.parsed.as_ref().unwrap());
    (script, packed)
}

fn statements(text: &str) -> Vec<StatementT> {
    parsed(text).1.statements.unwrap()
}

fn target_names(statement: &StatementT) -> (Option<&str>, Option<&str>, Option<&str>) {
    let target = statement.target.as_ref().expect("target");
    (target.database_name.as_deref(), target.schema_name.as_deref(), target.relation_name.as_deref())
}

fn analyzed(catalog: &Catalog, text: &str) -> Arc<AnalyzedScript> {
    let mut script = Script::new(catalog);
    script.replace_text(text);
    script.analyze(catalog, true).unwrap();
    script.analyzed.clone().unwrap()
}

#[test]
fn statement_targets_of_ddl() {
    let ddl = statements(
        "create table db.s.t (a int); create view s.v as select 1; create table c as select 1; \
         drop table x.y; drop view z;",
    );
    assert_eq!(ddl.len(), 5);
    assert_eq!(ddl[0].statement_type, StatementType::CREATE_TABLE);
    assert_eq!(ddl[0].target_type, StatementTargetType::TABLE);
    assert_eq!(target_names(&ddl[0]), (Some("db"), Some("s"), Some("t")));
    assert_eq!(ddl[1].target_type, StatementTargetType::VIEW);
    assert_eq!(target_names(&ddl[1]), (None, Some("s"), Some("v")));
    assert_eq!(ddl[2].statement_type, StatementType::CREATE_TABLE_AS);
    assert_eq!(target_names(&ddl[2]), (None, None, Some("c")));
    assert_eq!(ddl[3].statement_type, StatementType::DROP_TABLE);
    assert_eq!(target_names(&ddl[3]), (None, Some("x"), Some("y")));
    assert_eq!(ddl[4].target_type, StatementTargetType::VIEW);
    assert_eq!(target_names(&ddl[4]), (None, None, Some("z")));
}

#[test]
fn statement_targets_of_dml() {
    let dml = statements("insert into db.s.t values (1); delete from s.t where a = 1; select 1 into analytics.r; select 1");
    assert_eq!(dml[0].target_type, StatementTargetType::TABLE);
    assert_eq!(target_names(&dml[0]), (Some("db"), Some("s"), Some("t")));
    assert_eq!(dml[1].target_type, StatementTargetType::TABLE);
    assert_eq!(target_names(&dml[1]), (None, Some("s"), Some("t")));
    assert_eq!(dml[2].statement_type, StatementType::SELECT_INTO);
    assert_eq!(target_names(&dml[2]), (None, Some("analytics"), Some("r")));
    // Plain queries have no target
    assert_eq!(dml[3].target_type, StatementTargetType::NONE);
    assert!(dml[3].target.is_none());
}

#[test]
fn select_into_is_found_through_set_operations() {
    let statements = statements("select 1 into a union select 2");
    assert_eq!(statements[0].statement_type, StatementType::SELECT_INTO);
    assert_eq!(target_names(&statements[0]), (None, None, Some("a")));
}

#[test]
fn attach_statements_carry_their_arguments() {
    let statements = statements(
        "attach database \"path/to/source.hyper\" as source; attach local database local_source as attached; attach database \"x\" as y",
    );
    let attach = statements[0].attach_database.as_ref().unwrap();
    assert_eq!(attach.path.as_deref(), Some("path/to/source.hyper"));
    assert_eq!(attach.alias.as_deref(), Some("source"));
    assert!(!attach.local);
    let attach = statements[1].attach_database.as_ref().unwrap();
    assert_eq!(attach.path.as_deref(), Some("local_source"));
    assert!(attach.local);
    assert_eq!(statements[2].attach_database.as_ref().unwrap().alias.as_deref(), Some("y"));
}

#[test]
fn parsed_scripts_carry_statements_descriptions_and_errors() {
    let (script, packed) = parsed("-- first\nselect 1;\n\n-- second\nselect 2 +;");
    let statements = packed.statements.as_ref().unwrap();
    assert_eq!(statements.len(), 2);
    let span = statements[0].statement_span.as_ref().unwrap();
    assert_eq!(&script.to_text()[span.offset as usize..(span.offset + span.length) as usize], "select 1");
    assert_eq!(statements[0].description_count, 1);
    assert_eq!(packed.parser_errors.as_ref().unwrap().len(), 1);
    let error = &packed.parser_errors.as_ref().unwrap()[0];
    assert!(error.message.as_deref().unwrap().contains("syntax error"));
    assert!(error.symbol_span.is_some() && error.text_span.is_some());
    assert_eq!(packed.comments.as_ref().unwrap().len(), 2);
    assert_eq!(packed.line_breaks.as_ref().unwrap().len(), 4);
    assert!(packed.scanner_errors.is_none());
    assert_eq!(
        pack_parsed_statement(script.parsed.as_ref().unwrap(), 0).statement_type,
        StatementType::SELECT
    );
    assert!(!has_visualize(script.parsed.as_ref().unwrap()));
}

#[test]
fn comment_blocks_are_packed() {
    let (_, packed) = parsed("-- @dashql:metadata\n-- {\"a\": 1}\n-- @dashql:end\nselect 1");
    assert_eq!(packed.comment_blocks.as_ref().unwrap().len(), 1);
    assert_eq!(packed.comment_lines.as_ref().unwrap().len(), 1);
    assert_eq!(packed.metadata_block, 0);
    let (_, without) = parsed("select 1");
    assert_eq!(without.metadata_block, u32::MAX);
    assert!(without.comment_blocks.is_none());
}

#[test]
fn scanner_errors_are_packed_in_scanned_and_parsed_scripts() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select 'open");
    script.scan();
    let scanned = pack_scanned_script(script.scanned.as_ref().unwrap());
    assert_eq!(scanned.errors.as_ref().unwrap().len(), 1);
    assert!(scanned.errors.as_ref().unwrap()[0].message.is_some());
    script.parse();
    let packed = pack_parsed_script(script.parsed.as_ref().unwrap());
    assert_eq!(packed.scanner_errors.as_ref().unwrap().len(), 1);
}

#[test]
fn tokens_are_typed() {
    let (script, _) = parsed("select 1, 1.5, 'x', x'ff', b'01', a + b <> c from t -- end");
    let tokens = pack_tokens(script.parsed.as_ref().unwrap());
    let types = tokens.token_types.unwrap();
    assert_eq!(types.len(), tokens.token_offsets.as_ref().unwrap().len());
    assert_eq!(types.len(), tokens.token_lengths.as_ref().unwrap().len());
    for expected in [
        ScannerTokenType::KEYWORD,
        ScannerTokenType::LITERAL_INTEGER,
        ScannerTokenType::LITERAL_FLOAT,
        ScannerTokenType::LITERAL_STRING,
        ScannerTokenType::LITERAL_HEX,
        ScannerTokenType::LITERAL_BINARY,
        ScannerTokenType::IDENTIFIER,
        ScannerTokenType::OPERATOR,
    ] {
        assert!(types.contains(&expected), "missing {expected:?}");
    }
}

#[test]
fn visualization_keywords_are_typed_inside_of_vis_specs() {
    let (script, packed) = parsed("select 1 as a visualize using vegalite (mark => bar)");
    assert!(has_visualize(script.parsed.as_ref().unwrap()));
    let tokens = packed.tokens.unwrap();
    assert!(tokens.token_types.unwrap().contains(&ScannerTokenType::KEYWORD_VIS));
}

#[test]
fn analyzed_scripts_pack_expressions() {
    let catalog = Catalog::new();
    let script = analyzed(
        &catalog,
        "create table t (a int, b int); \
         select a + 1, 1 + 2, 1 < 2, upper('x'), interval '2' day, a from t where a = 1 and b > 2 or sum(a) < 3",
    );
    let packed = pack_analyzed_script(&script, &pack_visualization);
    let expressions = packed.expressions.unwrap();
    let has = |f: &dyn Fn(&ExpressionSubTypeT) -> bool| expressions.iter().any(|e| f(&e.inner));
    assert!(has(&|e| matches!(e, ExpressionSubTypeT::ColumnRefExpression(_))));
    assert!(has(&|e| matches!(e, ExpressionSubTypeT::Literal(_))));
    assert!(has(&|e| matches!(e, ExpressionSubTypeT::BinaryExpression(_))));
    assert!(has(&|e| matches!(e, ExpressionSubTypeT::Comparison(_))));
    assert!(has(&|e| matches!(e, ExpressionSubTypeT::FunctionCallExpression(_))));
    assert!(has(&|e| matches!(e, ExpressionSubTypeT::ConstIntervalCast(_))));
    assert_eq!(packed.table_references.unwrap().len(), 1);
    assert_eq!(packed.tables.unwrap().len(), 1);
    assert!(packed.errors.is_none());
}

#[test]
fn analyzed_scripts_pack_inferred_schemas() {
    let catalog = Catalog::new();
    let script = analyzed(&catalog, "select a, b from unknown_table where c = 1");
    let packed = pack_analyzed_script(&script, &pack_visualization);
    let inferred = packed.inferred_table_schemas.expect("inferred schemas");
    assert_eq!(inferred.len(), 1);
    let columns = inferred[0].columns.as_ref().unwrap();
    let mut names: Vec<_> = columns.iter().map(|c| c.column_name.clone().unwrap()).collect();
    names.sort();
    assert_eq!(names, vec!["a", "b", "c"]);
}

#[test]
fn cursor_inside_of_a_name_reports_its_context() {
    let mut catalog = Catalog::new();
    let schema = analyzed(&catalog, "create table items (id int, name text)");
    catalog.load_script(schema, 0).unwrap();
    let mut script = Script::new(&catalog);
    script.replace_text("select name from items where id = 1");
    script.analyze(&catalog, true).unwrap();

    let name_offset = "select na".len();
    let cursor = script.move_cursor(&catalog, name_offset);
    let packed = pack_cursor(&cursor);
    assert_eq!(packed.text_offset as usize, name_offset);
    assert_eq!(packed.statement_id, 0);
    assert!(packed.scanner_symbol_completable);
    assert_eq!(packed.scanner_relative_position, RelativeSymbolPosition::MID_OF_SYMBOL);
    assert!(!packed.ast_path_to_root.as_ref().unwrap().is_empty());
    assert!(matches!(packed.context, ScriptCursorContextT::ScriptCursorColumnRefContext(_)));

    let table_offset = "select name from it".len();
    let cursor = script.move_cursor(&catalog, table_offset);
    let packed = pack_cursor(&cursor);
    assert!(matches!(packed.context, ScriptCursorContextT::ScriptCursorTableRefContext(_)));

    let cursor = script.move_cursor(&catalog, 0);
    let packed = pack_cursor(&cursor);
    assert_eq!(packed.scanner_relative_position, RelativeSymbolPosition::BEGIN_OF_SYMBOL);
    assert!(matches!(packed.context, ScriptCursorContextT::NONE));
}

#[test]
fn completions_are_packed_with_catalog_objects() {
    let mut catalog = Catalog::new();
    let schema = analyzed(&catalog, "create table dbname.schemaname.foo (barcol int); create function dbname.schemaname.fn_sum(x int) returns int;");
    catalog.load_script(schema, 0).unwrap();

    let complete = |text: &str, upper: bool| {
        let mut script = Script::new(&catalog);
        script.replace_text(text);
        script.analyze(&catalog, true).unwrap();
        let cursor = script.move_cursor(&catalog, text.len());
        let completion = Script::complete_at_cursor(&cursor, 20).unwrap();
        pack_completion(&completion, upper)
    };
    let object_types = |text: &str| -> Vec<CompletionCandidateObjectType> {
        complete(text, false)
            .candidates
            .unwrap()
            .iter()
            .flat_map(|c| c.catalog_objects.iter().flatten().map(|o| o.object_type))
            .collect()
    };
    assert!(object_types("select * from db").contains(&CompletionCandidateObjectType::DATABASE));
    assert!(object_types("select * from dbname.sch").contains(&CompletionCandidateObjectType::SCHEMA));
    assert!(object_types("select * from fo").contains(&CompletionCandidateObjectType::TABLE));
    assert!(object_types("select fn_s").contains(&CompletionCandidateObjectType::FUNCTION));

    // Keywords are upper cased on request
    let lower = complete("sel", false);
    let upper = complete("sel", true);
    let texts = |c: &dashql_buffers::completion::CompletionT| -> Vec<String> {
        c.candidates.iter().flatten().filter_map(|c| c.display_text.clone()).collect()
    };
    assert!(texts(&lower).contains(&"select".to_string()), "{:?}", texts(&lower));
    assert!(texts(&upper).contains(&"SELECT".to_string()), "{:?}", texts(&upper));
}

#[test]
fn quoting_applies_to_completion_text_of_names() {
    let mut catalog = Catalog::new();
    let schema = analyzed(&catalog, "create table \"Mixed Case\" (a int)");
    catalog.load_script(schema, 0).unwrap();
    let mut script = Script::new(&catalog);
    script.replace_text("select * from mix");
    script.analyze(&catalog, true).unwrap();
    let cursor = script.move_cursor(&catalog, "select * from mix".len());
    let completion = Script::complete_at_cursor(&cursor, 10).unwrap();
    let packed = pack_completion(&completion, false);
    let candidate = packed
        .candidates
        .unwrap()
        .into_iter()
        .find(|c| c.display_text.as_deref() == Some("Mixed Case"))
        .expect("candidate");
    assert_eq!(candidate.completion_text.as_deref(), Some("\"Mixed Case\""));
}
