//! Tests of the batch processing: the scripts of a `BatchRequest` are scanned, parsed and analyzed
//! against shared catalog descriptors, and report diagnostics and packed stage buffers.

use dashql_buffers::analyzer::AnalyzedScript;
use dashql_buffers::batch::{
    BatchRequestT, BatchResult, BatchResultT, BatchScriptInputT, BatchScriptResultT, DescriptorBufferT, DiagnosticSeverity,
    ProcessingStage,
};
use dashql_buffers::catalog::CatalogDescriptor;
use dashql_buffers::parser::{ParsedScript, ScannedScript, ScannerTokenType};
use dashql_core::batch::{check_script, process_batch};
use dashql_core::catalog::Catalog;

const SCANNED: u32 = 1;
const PARSED: u32 = 2;
const ANALYZED: u32 = 4;
const DESCRIPTOR: u32 = 8;

fn input(id: &str, text: &str, outputs: u32) -> BatchScriptInputT {
    let mut input = BatchScriptInputT::default();
    input.id = Some(id.to_string());
    input.text = Some(text.to_string());
    input.outputs = outputs;
    input
}

fn request(scripts: Vec<BatchScriptInputT>, descriptors: Vec<Vec<u8>>) -> Vec<u8> {
    let mut request = BatchRequestT::default();
    request.scripts = Some(scripts);
    request.catalog_descriptors = Some(
        descriptors
            .into_iter()
            .map(|data| {
                let mut buffer = DescriptorBufferT::default();
                buffer.data = Some(data);
                buffer
            })
            .collect(),
    );
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = request.pack(&mut builder);
    builder.finish(packed, None);
    builder.finished_data().to_vec()
}

fn run(scripts: Vec<BatchScriptInputT>, descriptors: Vec<Vec<u8>>) -> BatchResultT {
    let response = process_batch(&request(scripts, descriptors)).unwrap();
    flatbuffers::root::<BatchResult>(&response).unwrap().unpack()
}

fn run_one(text: &str, outputs: u32, descriptors: Vec<Vec<u8>>) -> BatchScriptResultT {
    run(vec![input("s", text, outputs)], descriptors).scripts.unwrap().remove(0)
}

/// The number of table references of the analyzed output that resolved to catalog tables
fn resolved_table_references(result: &BatchScriptResultT) -> usize {
    let analyzed = flatbuffers::root::<AnalyzedScript>(result.analyzed.as_ref().unwrap()).unwrap().unpack();
    analyzed.resolved_table_references_by_id.map_or(0, |r| r.len())
}

/// A script that fails in the analyzer
const DUPLICATE_ALIAS: &str = "select * from (select 1) s, (select 2) s";

fn diagnostics(result: &BatchScriptResultT) -> Vec<(ProcessingStage, DiagnosticSeverity, String)> {
    result
        .diagnostics
        .iter()
        .flatten()
        .map(|d| (d.stage, d.severity, d.message.clone().unwrap_or_default()))
        .collect()
}

#[test]
fn rejects_invalid_requests() {
    assert!(process_batch(&[]).is_err());
    assert!(process_batch(&[1, 2, 3, 4, 5]).is_err());
    let error = process_batch(&[]).unwrap_err();
    assert_eq!(error.what(), "invalid BatchRequest FlatBuffer");
}

#[test]
fn empty_request_has_no_scripts() {
    let result = run(vec![], vec![]);
    assert!(result.scripts.is_none());
}

#[test]
fn zero_outputs_skip_processing() {
    let result = run_one("select 1 +", 0, vec![]);
    assert_eq!(result.id.as_deref(), Some("s"));
    assert!(result.scanned.is_none() && result.parsed.is_none() && result.analyzed.is_none());
    assert!(result.catalog_descriptor.is_none());
    assert!(result.diagnostics.is_none());
    assert!(result.failure.is_none());
}

#[test]
fn empty_ids_are_left_out() {
    let result = run(vec![input("", "select 1", SCANNED), input("b", "select 1", SCANNED)], vec![]);
    let scripts = result.scripts.unwrap();
    assert_eq!(scripts[0].id, None);
    assert_eq!(scripts[1].id.as_deref(), Some("b"));
}

#[test]
fn unknown_output_bits_fail_the_script() {
    let results = run(vec![input("bad", "select 1", 16), input("ok", "select 1", SCANNED)], vec![]).scripts.unwrap();
    assert_eq!(results[0].failure.as_deref(), Some("invalid batch output mask"));
    assert!(results[0].scanned.is_none());
    // The other scripts are not affected
    assert!(results[1].failure.is_none());
    assert!(results[1].scanned.is_some());
}

#[test]
fn scanned_output() {
    let result = run_one("select 1; -- trailing\nselect 2", SCANNED, vec![]);
    assert!(result.parsed.is_none() && result.analyzed.is_none());
    let scanned = flatbuffers::root::<ScannedScript>(result.scanned.as_ref().unwrap()).unwrap().unpack();
    assert_eq!(scanned.line_breaks.unwrap().len(), 1);
    assert_eq!(scanned.comments.unwrap().len(), 1);
    assert!(scanned.errors.is_none());
    assert!(diagnostics(&result).is_empty());
}

#[test]
fn scanner_errors_are_diagnostics() {
    let result = run_one("select 'unterminated", SCANNED, vec![]);
    let scanned = flatbuffers::root::<ScannedScript>(result.scanned.as_ref().unwrap()).unwrap().unpack();
    assert_eq!(scanned.errors.as_ref().unwrap().len(), 1);
    let diagnostics = diagnostics(&result);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].0, ProcessingStage::SCAN);
    assert_eq!(diagnostics[0].1, DiagnosticSeverity::ERROR);
    let positions = result.diagnostics.as_ref().unwrap()[0].offset;
    assert_eq!(positions, 7);
}

#[test]
fn parsed_output() {
    let text = "/* head */ select 1, 1.5, 'x', x'ff', b'01', a from t where a = 2; -- tail";
    let result = run_one(text, PARSED, vec![]);
    assert!(result.scanned.is_none() && result.analyzed.is_none());
    let parsed = flatbuffers::root::<ParsedScript>(result.parsed.as_ref().unwrap()).unwrap().unpack();
    assert_eq!(parsed.statements.as_ref().unwrap().len(), 1);
    assert!(parsed.parser_errors.is_none());
    assert!(!parsed.nodes.as_ref().unwrap().is_empty());
    assert_eq!(parsed.comments.as_ref().unwrap().len(), 2);
    let tokens = parsed.tokens.unwrap();
    let types: Vec<_> = tokens.token_types.unwrap();
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
        assert!(types.contains(&expected), "missing token type {expected:?}");
    }
    assert!(diagnostics(&result).is_empty());
}

#[test]
fn parser_errors_are_diagnostics() {
    let result = run_one("select 1 +;", PARSED, vec![]);
    let parsed = flatbuffers::root::<ParsedScript>(result.parsed.as_ref().unwrap()).unwrap().unpack();
    assert_eq!(parsed.parser_errors.as_ref().unwrap().len(), 1);
    let diagnostics = diagnostics(&result);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!((diagnostics[0].0, diagnostics[0].1), (ProcessingStage::PARSE, DiagnosticSeverity::ERROR));
    assert!(diagnostics[0].2.contains("syntax error"));
    // The parser stops processing after the parse stage was requested
    assert!(result.analyzed.is_none());
}

#[test]
fn analyzed_output() {
    let result = run_one("create table t (a int, b int); select a from t where b = 1;", ANALYZED, vec![]);
    assert!(result.failure.is_none());
    assert!(result.scanned.is_none() && result.parsed.is_none());
    let analyzed = flatbuffers::root::<AnalyzedScript>(result.analyzed.as_ref().unwrap()).unwrap().unpack();
    let tables = analyzed.tables.unwrap();
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].table_name.as_ref().unwrap().table_name.as_ref().unwrap().as_str(), "t");
    assert_eq!(tables[0].table_columns.as_ref().unwrap().len(), 2);
    assert_eq!(analyzed.table_references.unwrap().len(), 1);
    assert!(!analyzed.expressions.unwrap().is_empty());
    assert!(diagnostics(&result).is_empty());
}

#[test]
fn analyzed_output_packs_functions_and_visualizations() {
    let text = "create function f(x int) returns int; select f(1) as v, count(*) as n from (select 1) x \
                visualize using table (dashboard => (row => 1))";
    let result = run_one(text, ANALYZED, vec![]);
    assert!(result.failure.is_none());
    let analyzed = flatbuffers::root::<AnalyzedScript>(result.analyzed.as_ref().unwrap()).unwrap().unpack();
    assert_eq!(analyzed.function_declarations.as_ref().map(Vec::len), Some(1));
    let specs = analyzed.visualization_specs.unwrap();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].renderer.as_deref(), Some("table"));
    assert!(specs[0].table_spec.is_some());
    assert_eq!(specs[0].dashboard.as_ref().unwrap().row, Some(1), "{:?}", specs[0].dashboard);
}

#[test]
fn analyzer_errors_are_diagnostics() {
    let result = run_one(DUPLICATE_ALIAS, ANALYZED, vec![]);
    let diagnostics = diagnostics(&result);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!((diagnostics[0].0, diagnostics[0].1), (ProcessingStage::ANALYZE, DiagnosticSeverity::ERROR));
    let packed = &result.diagnostics.as_ref().unwrap()[0];
    assert!(packed.length > 0);
    // Requested stage buffers stay available
    assert!(result.analyzed.is_some());
    assert!(result.failure.is_none());
}

#[test]
fn analyzer_warnings_are_diagnostics() {
    let result = run_one("-- @dashql:bogus\nselect 1", ANALYZED, vec![]);
    let diagnostics = diagnostics(&result);
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!((diagnostics[0].0, diagnostics[0].1), (ProcessingStage::ANALYZE, DiagnosticSeverity::WARNING));
    assert!(diagnostics[0].2.contains("bogus"));
    // Warnings don't block the catalog descriptor
    let result = run_one("-- @dashql:bogus\ncreate table t (a int)", ANALYZED | DESCRIPTOR, vec![]);
    assert!(result.catalog_descriptor.is_some());
}

#[test]
fn analyzer_stage_includes_earlier_diagnostics() {
    let result = run_one("select 'x", ANALYZED, vec![]);
    let stages: Vec<_> = diagnostics(&result).iter().map(|d| d.0).collect();
    assert_eq!(stages[0], ProcessingStage::SCAN);
    assert!(stages.contains(&ProcessingStage::PARSE) || stages.len() == 1);
}

#[test]
fn catalog_descriptor_roundtrip() {
    let result = run_one("create table t (a int, b text); create table s.u (c int);", DESCRIPTOR, vec![]);
    assert!(result.failure.is_none());
    // Only requested outputs are packed
    assert!(result.analyzed.is_none());
    let bytes = result.catalog_descriptor.clone().unwrap();
    let descriptor = flatbuffers::root::<CatalogDescriptor>(&bytes).unwrap().unpack();
    let names: Vec<_> = descriptor
        .tables
        .unwrap()
        .iter()
        .map(|t| t.table_name.as_ref().unwrap().table_name.as_ref().unwrap().clone())
        .collect();
    assert_eq!(names, vec!["t", "u"]);

    // A later script resolves against the descriptor
    let query = "select a, b from t; select c from s.u";
    assert_eq!(resolved_table_references(&run_one(query, ANALYZED, vec![])), 0);
    let resolved = run_one(query, ANALYZED, vec![bytes]);
    assert!(diagnostics(&resolved).is_empty(), "{:?}", diagnostics(&resolved));
    assert_eq!(resolved_table_references(&resolved), 2);
}

#[test]
fn scripts_do_not_publish_to_each_other() {
    let results = run(
        vec![
            input("a", "create table t (a int)", ANALYZED | DESCRIPTOR),
            input("b", "select a from t", ANALYZED),
        ],
        vec![],
    )
    .scripts
    .unwrap();
    assert!(diagnostics(&results[0]).is_empty());
    assert!(results[0].catalog_descriptor.is_some());
    assert_eq!(resolved_table_references(&results[1]), 0);
}

#[test]
fn erroneous_scripts_emit_no_descriptor() {
    let result = run_one(&format!("create table t (a int); {DUPLICATE_ALIAS}"), ANALYZED | DESCRIPTOR, vec![]);
    assert!(result.analyzed.is_some());
    assert!(result.catalog_descriptor.is_none());
    let result = run_one("create table t (a int", PARSED | DESCRIPTOR, vec![]);
    assert!(result.catalog_descriptor.is_none());
}

#[test]
fn descriptors_are_ranked_by_position() {
    let first = run_one("create table t (a int)", DESCRIPTOR, vec![]).catalog_descriptor.unwrap();
    let second = run_one("create table t (z int)", DESCRIPTOR, vec![]).catalog_descriptor.unwrap();
    // The descriptor with the lower rank wins on name conflicts
    let column_references = |text: &str| {
        let result = run_one(text, ANALYZED, vec![first.clone(), second.clone()]);
        let analyzed = flatbuffers::root::<AnalyzedScript>(result.analyzed.as_ref().unwrap()).unwrap().unpack();
        analyzed.resolved_column_references_by_id.map_or(0, |r| r.len())
    };
    assert_eq!(column_references("select a from t"), 1);
    assert_eq!(column_references("select z from t"), 0);
}

#[test]
fn invalid_descriptor_bytes_fail_the_request() {
    let error = process_batch(&request(vec![input("s", "select 1", SCANNED)], vec![vec![1, 2, 3]])).unwrap_err();
    assert_eq!(error.what(), "invalid CatalogDescriptor FlatBuffer");
    let error = process_batch(&request(vec![input("s", "select 1", SCANNED)], vec![vec![]])).unwrap_err();
    assert_eq!(error.what(), "invalid CatalogDescriptor FlatBuffer");
}

#[test]
fn check_script_reports_diagnostics_per_stage() {
    let catalog = Catalog::new();
    let checked = check_script(&catalog, "select 1", ProcessingStage::ANALYZE);
    assert!(!checked.has_errors());
    assert!(checked.script.analyzed.is_some());

    let checked = check_script(&catalog, "select 1 +;", ProcessingStage::SCAN);
    assert!(!checked.has_errors());
    assert!(checked.script.parsed.is_none());

    let checked = check_script(&catalog, "select 1 +;", ProcessingStage::PARSE);
    assert!(checked.has_errors());
    assert!(checked.script.analyzed.is_none());
    assert_eq!(checked.diagnostics[0].stage, ProcessingStage::PARSE);
    assert!(checked.diagnostics[0].span.length > 0);

    let checked = check_script(&catalog, DUPLICATE_ALIAS, ProcessingStage::ANALYZE);
    assert!(checked.has_errors());
    assert!(checked.diagnostics.iter().all(|d| d.span.length > 0));
}
