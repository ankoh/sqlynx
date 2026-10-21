//! A port of the C++ `test/script_session_test.cc` and the session tests of
//! `api_test.cc`.
//!
//! The C ABI tests (`CAbi...`, `Compatibility...`, `CatalogLoadAndDrop...`) call the Rust session
//! API directly; buffers go through `apply_buffer`.

use dashql_buffers::cursor::RelativeSymbolPosition;
use dashql_buffers::diff::ScriptDiffOpCode;
use dashql_buffers::editor::{
    EditorCursorSemanticKind, EditorDiagnosticSource, EditorEventAction, EditorEventIntent, EditorEventOrigin,
    EditorEventT, EditorOffsetUnit, EditorSelectionT, EditorSemanticReferenceKind, EditorSemanticResolution,
    EditorSemanticSpanT, EditorTextChangeT, EditorTextSpanT, EditorUpdateStatus, EditorUpdateT,
};
use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode, KeywordCase};
use dashql_buffers::parser::{ScannerTokenType, StatementType};
use dashql_core::catalog::Catalog;
use dashql_core::pack::pack_completion;
use dashql_core::planner::{plan, PlannerInput};
use dashql_core::script::Script;
use dashql_core::script_session::{CatalogHandle, ScriptSession};
use std::cell::RefCell;
use std::rc::Rc;

const UTF8: EditorOffsetUnit = EditorOffsetUnit::UTF8_BYTES;
const UTF16: EditorOffsetUnit = EditorOffsetUnit::UTF16_CODE_UNITS;

fn new_catalog() -> CatalogHandle {
    Rc::new(RefCell::new(Catalog::new()))
}

fn session(catalog: &CatalogHandle, unit: EditorOffsetUnit) -> ScriptSession {
    ScriptSession::new(catalog.clone(), unit).unwrap()
}

fn change(from: u64, to: u64, insert: &str) -> EditorTextChangeT {
    let mut change = EditorTextChangeT::default();
    change.from = from;
    change.to = to;
    change.insert = Some(insert.to_string());
    change
}

fn selection(anchor: u64, head: u64) -> Option<Box<EditorSelectionT>> {
    let mut selection = EditorSelectionT::default();
    selection.anchor = anchor;
    selection.head = head;
    Some(Box::new(selection))
}

fn event(expected_text_version: u64, changes: Vec<EditorTextChangeT>) -> EditorEventT {
    let mut event = EditorEventT::default();
    event.expected_text_version = expected_text_version;
    event.changes = Some(changes);
    event
}

/// Replace the text and analyze in one event
fn analyze(session: &mut ScriptSession, text: &str) -> EditorUpdateT {
    let mut e = event(session.text_version(), vec![change(0, session.text().len() as u64, text)]);
    e.analyze = true;
    session.apply(&e)
}

/// The text of a span, clamped like `std::string_view::substr` (scanner errors at EOF end one byte
/// past the text)
fn read_span<'t>(text: &'t str, span: Option<&EditorTextSpanT>) -> &'t str {
    match span {
        Some(span) => {
            let begin = (span.offset as usize).min(text.len());
            let end = ((span.offset + span.length) as usize).min(text.len());
            &text[begin..end]
        }
        None => "",
    }
}

fn find_semantic_span<'u>(
    update: &'u EditorUpdateT,
    text: &str,
    kind: EditorSemanticReferenceKind,
    source: &str,
) -> Option<&'u EditorSemanticSpanT> {
    update.semantic_spans.iter().flatten().find(|s| s.kind == kind && read_span(text, s.text_span.as_ref()) == source)
}

fn load_schema(catalog: &CatalogHandle, text: &str) -> Script {
    let mut catalog = catalog.borrow_mut();
    let mut schema = Script::new(&catalog);
    schema.replace_text(text);
    schema.analyze(&catalog, true).unwrap();
    catalog.load_script(schema.analyzed.clone().unwrap(), 0).unwrap();
    schema
}

fn config() -> FormattingConfigT {
    let mut config = FormattingConfigT::default();
    config.dialect = FormattingDialect::HYPER;
    config.mode = FormattingMode::INLINE;
    config.max_width = 80;
    config.indentation_width = 4;
    config
}

#[test]
fn applies_atomic_batch_in_pre_change_offsets() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "abcdef").status, EditorUpdateStatus::OK);

    let mut e = event(1, vec![change(1, 2, "X"), change(4, 6, "YZ")]);
    e.origin = EditorEventOrigin::USER;
    e.intent = EditorEventIntent::EDIT;
    e.action = EditorEventAction::TYPE;
    e.primary_selection = selection(6, 6);

    let update = session.apply(&e);
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert_eq!(session.text(), "aXcdYZ");
    assert_eq!(update.text_version, 2);
    assert_eq!(session.script().text_version(), 2);
    assert_eq!(update.state_revision, 2);
    assert_eq!(update.primary_selection.as_ref().unwrap().head, 6);
}

#[test]
fn preserves_input_order_for_insertions_at_same_offset() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "ab").status, EditorUpdateStatus::OK);
    assert_eq!(session.apply(&event(1, vec![change(1, 1, "X"), change(1, 1, "Y")])).status, EditorUpdateStatus::OK);
    assert_eq!(session.text(), "aXYb");
}

#[test]
fn no_op_and_rejected_edits_preserve_text_version() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "abc").status, EditorUpdateStatus::OK);
    let unchanged = session.replace_text(1, "abc");
    assert!(!unchanged.text_changed);
    assert_eq!(unchanged.text_version, 1);

    let mut e = event(1, vec![change(0, 1, "a"), change(100, 100, "")]);
    let update = session.apply(&e);
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(!update.text_changed);
    assert_eq!(update.text_version, 1);
    assert_eq!(update.state_revision, 1);

    // Rust strings are valid UTF-8, an invalid insert can only arrive in a buffer, which fails
    // verification (C++: INVALID_UTF8)
    e.changes.as_mut().unwrap().push(change(2, 2, "\u{FFFF}"));
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = e.pack(&mut builder);
    builder.finish(packed, None);
    let mut bytes = builder.finished_data().to_vec();
    let marker = "\u{FFFF}".as_bytes();
    let at = bytes.windows(marker.len()).position(|w| w == marker).unwrap();
    bytes[at] = 0xFF;
    let rejected = session.apply_buffer(&bytes);
    assert_eq!(rejected.status, EditorUpdateStatus::INVALID_EVENT);
    assert_eq!(session.text_version(), 1);
    assert_eq!(session.script().text_version(), 1);
    assert_eq!(session.text(), "abc");
}

#[test]
fn direct_script_edits_share_version_and_refresh_analysis() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert!(analyze(&mut session, "select 1").analysis_available);
    assert_eq!(session.set_primary_cursor(1, 7).status, EditorUpdateStatus::OK);
    let first_analysis = session.script().analyzed.clone().unwrap();
    session.script_mut().insert_text_at(0, "-- comment\n");
    assert_eq!(session.text_version(), 2);

    let stale = session.replace_text(1, "select 2");
    assert_eq!(stale.status, EditorUpdateStatus::STALE_TEXT_VERSION);
    assert_eq!(stale.text_version, 2);
    assert!(!stale.analysis_available);
    assert!(stale.syntax_spans.is_none());

    let update = session.analyze();
    assert_eq!(update.text_version, 2);
    assert!(update.analysis_updated);
    assert!(update.analysis_available);
    let analyzed = session.script().analyzed.clone().unwrap();
    assert!(!std::sync::Arc::ptr_eq(&analyzed, &first_analysis));
    assert_eq!(analyzed.parsed.scanned.text_version, 2);

    // A direct parse can invalidate snapshot identity without changing the text version
    session.script_mut().parse();
    let reparsed = session.analyze();
    assert!(reparsed.analysis_updated);
    assert!(reparsed.analysis_available);
    assert_eq!(reparsed.primary_cursor_state.as_ref().unwrap().text_offset, 7);
    assert_eq!(session.text_version(), 2);

    // Restoring an older snapshot must not fool the captured version of the session
    let script = session.script_mut();
    script.parsed = Some(first_analysis.parsed.clone());
    script.scanned = Some(first_analysis.parsed.scanned.clone());
    script.analyzed = Some(first_analysis);
    let restored = session.analyze();
    assert!(restored.analysis_updated);
    assert!(restored.analysis_available);
    assert_eq!(session.script().analyzed.as_ref().unwrap().parsed.scanned.text_version, 2);
    assert_eq!(session.text_version(), 2);
}

#[test]
fn clamps_insertion_past_document_end() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);
    assert_eq!(session.replace_text(0, "a\u{1F600}").status, EditorUpdateStatus::OK);
    assert_eq!(session.apply(&event(1, vec![change(100, 100, "!")])).status, EditorUpdateStatus::OK);
    assert_eq!(session.text(), "a\u{1F600}!");
}

#[test]
fn rejects_whole_overlapping_or_stale_batch() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "abcdef").status, EditorUpdateStatus::OK);

    let overlap = session.apply(&event(1, vec![change(1, 4, "x"), change(3, 5, "y")]));
    assert_eq!(overlap.status, EditorUpdateStatus::OVERLAPPING_CHANGES);
    assert_eq!(session.text(), "abcdef");
    assert_eq!(session.text_version(), 1);
    assert_eq!(session.script().text_version(), 1);

    let stale = session.apply(&event(0, vec![change(0, 1, "z")]));
    assert_eq!(stale.status, EditorUpdateStatus::STALE_TEXT_VERSION);
    assert_eq!(session.text_version(), 1);
    assert_eq!(session.text(), "abcdef");
    assert_eq!(session.state_revision(), 1);
}

#[test]
fn converts_utf8_byte_offsets_and_rejects_split_codepoints() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "a\u{e9}z").status, EditorUpdateStatus::OK);

    let valid = session.apply(&event(1, vec![change(1, 3, "\u{2603}")]));
    assert_eq!(valid.status, EditorUpdateStatus::OK);
    assert_eq!(session.text(), "a\u{2603}z");

    let split = session.apply(&event(2, vec![change(2, 3, "x")]));
    assert_eq!(split.status, EditorUpdateStatus::INVALID_RANGE);
    assert_eq!(session.text(), "a\u{2603}z");
    assert_eq!(session.text_version(), 2);
}

#[test]
fn uses_utf16_offsets_for_events_selections_and_projections() {
    let text = "select '\u{1F600}' from missing";
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);

    let update = analyze(&mut session, text);
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert_eq!(update.offset_unit, UTF16);
    let missing = update
        .semantic_spans
        .iter()
        .flatten()
        .find(|s| s.kind == EditorSemanticReferenceKind::TABLE && s.resolution == EditorSemanticResolution::UNRESOLVED)
        .unwrap();
    assert_eq!(missing.text_span.as_ref().unwrap().offset, 17);

    let mut e = event(1, vec![change(8, 10, "x")]);
    e.primary_selection = selection(9, 9);
    let update = session.apply(&e);
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert_eq!(session.text(), "select 'x' from missing");
    assert_eq!(update.primary_selection.as_ref().unwrap().head, 9);

    let mut split_surrogate = event(2, vec![change(0, 0, "\u{1F600}")]);
    split_surrogate.primary_selection = selection(1, 1);
    assert_eq!(session.apply(&split_surrogate).status, EditorUpdateStatus::INVALID_RANGE);
}

#[test]
fn projects_completion_and_diff_as_utf16() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);
    assert_eq!(session.replace_text(0, "-- \u{1F600}\ns").status, EditorUpdateStatus::OK);
    assert_eq!(session.set_primary_cursor(1, 7).status, EditorUpdateStatus::OK);
    assert_eq!(session.analyze().status, EditorUpdateStatus::OK);

    let completion = session.complete(10, KeywordCase::LOWER).unwrap();
    let candidates = completion.candidates.as_ref().unwrap();
    assert!(!candidates.is_empty());
    assert_eq!(completion.cursor_offset, 7);
    assert_eq!(candidates[0].target_location.as_ref().unwrap().offset, 6);

    let mut target = Script::new(&catalog.borrow());
    target.replace_text("-- \u{1F600}\nselect 2");
    target.parse();
    let diff = session.diff(&target).unwrap();
    let ops = diff.ops.as_ref().unwrap();
    assert!(!ops.is_empty());
    assert_eq!(ops[0].target_span.as_ref().unwrap().offset, 6);
}

#[test]
fn analyzes_at_catalog_revision() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(
        session.replace_text(0, "create table items (id int); select * from items;").status,
        EditorUpdateStatus::OK
    );
    assert!(!catalog.borrow().contains(session.catalog_entry_id()));

    let update = session.analyze();
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(update.analysis_updated);
    assert!(update.analysis_available);
    assert!(session.script().analyzed.is_some());
    assert!(!catalog.borrow().contains(session.catalog_entry_id()));
    assert_eq!(update.catalog_revision, catalog.borrow().version() as u64);
    assert_eq!(update.state_revision, 2);

    let no_op = session.analyze();
    assert!(!no_op.analysis_updated);
    assert_eq!(no_op.state_revision, 2);

    catalog.borrow_mut().clear();
    let catalog_refresh = session.analyze();
    assert!(catalog_refresh.analysis_updated);
    assert!(catalog_refresh.analysis_available);
    assert_eq!(catalog_refresh.catalog_revision, catalog.borrow().version() as u64);
    assert_eq!(catalog_refresh.state_revision, 3);

    let edit = session.replace_text(1, "select 1");
    assert_eq!(edit.status, EditorUpdateStatus::OK);
    assert!(!edit.analysis_available);
    assert!(session.script().analyzed.is_some());
}

#[test]
fn cursor_move_refreshes_analysis_after_catalog_revision() {
    let catalog = new_catalog();
    let mut source = session(&catalog, UTF16);
    let initial = analyze(&mut source, "select value from items");
    assert!(initial.analysis_available);
    assert!(initial.syntax_spans.is_some());

    let mut schema = session(&catalog, UTF16);
    assert!(analyze(&mut schema, "create table items (value int)").analysis_available);
    schema.load_into_catalog(0).unwrap();

    let moved = source.set_primary_cursor(source.text_version(), 7);
    assert_eq!(moved.status, EditorUpdateStatus::OK);
    assert!(moved.analysis_available);
    assert!(moved.analysis_updated);
    assert!(moved.syntax_spans.is_some());
}

#[test]
fn editing_published_script_drops_stale_catalog_entry() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert!(analyze(&mut session, "create table items (id int)").analysis_available);
    session.load_into_catalog(0).unwrap();
    assert!(catalog.borrow().contains(session.catalog_entry_id()));

    let published_revision = catalog.borrow().version();
    let published_analysis = session.script().analyzed.clone().unwrap();
    assert_ne!(published_analysis.entry.catalog_version, published_revision);
    let no_op = session.replace_text(session.text_version(), "create table items (id int)");
    assert!(!no_op.text_changed);
    assert!(!no_op.analysis_available);
    assert!(catalog.borrow().contains(session.catalog_entry_id()));

    let refreshed = session.analyze();
    assert_eq!(refreshed.status, EditorUpdateStatus::OK);
    assert!(refreshed.analysis_updated);
    assert!(refreshed.analysis_available);
    let analyzed = session.script().analyzed.clone().unwrap();
    assert!(!std::sync::Arc::ptr_eq(&analyzed, &published_analysis));
    assert_eq!(analyzed.entry.catalog_version, published_revision);
    assert_eq!(refreshed.catalog_revision, published_revision as u64);
    assert_eq!(catalog.borrow().version(), published_revision);
    assert!(!session.analyze().analysis_updated);

    let update = session.replace_text(session.text_version(), "create table updated (id int)");
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(!catalog.borrow().contains(session.catalog_entry_id()));
}

#[test]
fn published_sessions_refresh_at_final_catalog_revision_before_planning() {
    let catalog = new_catalog();
    let mut schema = session(&catalog, UTF8);
    let mut query = session(&catalog, UTF8);
    assert!(analyze(&mut schema, "create table items (id int)").analysis_available);
    schema.load_into_catalog(0).unwrap();
    assert!(analyze(&mut query, "select id from items").analysis_available);
    query.load_into_catalog(1).unwrap();

    let final_revision = catalog.borrow().version();
    assert_ne!(query.script().analyzed.as_ref().unwrap().entry.catalog_version, final_revision);
    for session in [&mut schema, &mut query] {
        let update = session.analyze();
        assert_eq!(update.status, EditorUpdateStatus::OK);
        assert!(update.analysis_updated);
        assert!(update.analysis_available);
        assert_eq!(update.catalog_revision, final_revision as u64);
        assert_eq!(session.script().analyzed.as_ref().unwrap().entry.catalog_version, final_revision);
        assert_eq!(catalog.borrow().version(), final_revision);
    }
    for session in [&mut schema, &mut query] {
        let update = session.analyze();
        assert!(!update.analysis_updated);
        assert!(update.analysis_available);
    }

    let catalog_ref = catalog.borrow();
    let graph = plan(&[
        PlannerInput { script: schema.script(), catalog: &catalog_ref },
        PlannerInput { script: query.script(), catalog: &catalog_ref },
    ]);
    assert!(graph.valid);
    assert!(graph.diagnostics.as_ref().is_none_or(|d| d.is_empty()));
    assert!(graph.unresolved_references.as_ref().is_none_or(|r| r.is_empty()));
    assert_eq!(graph.nodes.as_ref().map_or(0, |n| n.len()), 2);
    let scripts = graph.scripts.as_ref().unwrap();
    assert_eq!(scripts.len(), 2);
    for script in scripts {
        assert_eq!(script.analyzed_catalog_revision, final_revision as u64);
    }
    assert_eq!(catalog_ref.version(), final_revision);
}

#[test]
fn edit_can_synchronously_analyze_and_place_cursor() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    let mut e = event(0, vec![change(0, 0, "select 1")]);
    e.analyze = true;
    e.primary_selection = selection(8, 8);

    let update = session.apply(&e);
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(update.analysis_updated);
    assert!(update.analysis_available);
    assert_eq!(session.script().cursor_offset(), Some(8));
    let state = update.primary_cursor_state.as_ref().unwrap();
    assert_eq!(state.text_offset, 8);
    assert_eq!(state.scanner_relative_position, RelativeSymbolPosition::END_OF_SYMBOL);
    assert!(!state.scanner_symbol_completable);
    assert_eq!(update.text_version, 1);
    assert_eq!(update.state_revision, 1);
}

#[test]
fn projects_unicode_syntax_comments_and_diagnostics_as_utf8_bytes() {
    let text = "-- caf\u{e9}\nselect '\u{e9}' from missing";
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    let update = analyze(&mut session, text);

    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(update.analysis_available);
    let mut saw_comment = false;
    let mut saw_literal = false;
    for span in update.syntax_spans.iter().flatten() {
        if span.token_type == ScannerTokenType::COMMENT {
            assert_eq!(read_span(text, span.text_span.as_ref()), "-- caf\u{e9}");
            assert_eq!(span.text_span.as_ref().unwrap().length, 8);
            saw_comment = true;
        }
        if span.token_type == ScannerTokenType::LITERAL_STRING {
            assert_eq!(read_span(text, span.text_span.as_ref()), "'\u{e9}'");
            assert_eq!(span.text_span.as_ref().unwrap().length, 4);
            saw_literal = true;
        }
    }
    assert!(saw_comment);
    assert!(saw_literal);
    let missing = find_semantic_span(&update, text, EditorSemanticReferenceKind::TABLE, "missing").unwrap();
    assert_eq!(missing.resolution, EditorSemanticResolution::UNRESOLVED);
    assert_eq!(missing.text_span.as_ref().unwrap().offset, text.find("missing").unwrap() as u64);

    let mut scanner_session = ScriptSession::new(catalog.clone(), UTF8).unwrap();
    let scanner_text = "select '\u{e9}";
    let scanner_update = analyze(&mut scanner_session, scanner_text);
    let diagnostics = scanner_update.diagnostics.as_ref().unwrap();
    let scanner = diagnostics.iter().find(|d| d.source == EditorDiagnosticSource::SCANNER).unwrap();
    assert_eq!(scanner.message.as_deref(), Some("unterminated quoted string"));
    assert_eq!(read_span(scanner_text, scanner.text_span.as_ref()), "'\u{e9}");

    let mut parser_session = ScriptSession::new(catalog.clone(), UTF8).unwrap();
    let parser_text = "select 1 'alias'";
    let parser_update = analyze(&mut parser_session, parser_text);
    let parser =
        parser_update.diagnostics.iter().flatten().find(|d| d.source == EditorDiagnosticSource::PARSER).unwrap();
    assert!(!parser.message.as_deref().unwrap_or("").is_empty());
    assert!(!read_span(parser_text, parser.text_span.as_ref()).is_empty());
}

#[test]
fn projects_analyzer_errors_and_resolved_and_unresolved_references() {
    let catalog = new_catalog();
    let _schema = load_schema(&catalog, "create table items (id int); create table other (id int)");

    let mut ambiguous_session = session(&catalog, UTF8);
    let ambiguous_text = "select id from items, other";
    let ambiguous_update = analyze(&mut ambiguous_session, ambiguous_text);
    let analyzer =
        ambiguous_update.diagnostics.iter().flatten().find(|d| d.source == EditorDiagnosticSource::ANALYZER).unwrap();
    assert!(analyzer.message.as_deref().unwrap().contains("ambiguous"));
    assert_eq!(read_span(ambiguous_text, analyzer.text_span.as_ref()), "id");

    let mut session = session(&catalog, UTF8);
    let text = "select id, missing from items, absent";
    let update = analyze(&mut session, text);
    let items = find_semantic_span(&update, text, EditorSemanticReferenceKind::TABLE, "items").unwrap();
    let absent = find_semantic_span(&update, text, EditorSemanticReferenceKind::TABLE, "absent").unwrap();
    let id = find_semantic_span(&update, text, EditorSemanticReferenceKind::COLUMN, "id").unwrap();
    let missing = find_semantic_span(&update, text, EditorSemanticReferenceKind::COLUMN, "missing").unwrap();
    assert_eq!(items.resolution, EditorSemanticResolution::RESOLVED);
    assert_ne!(items.catalog_table_id, 0);
    assert_eq!(absent.resolution, EditorSemanticResolution::UNRESOLVED);
    assert_eq!(id.resolution, EditorSemanticResolution::RESOLVED);
    assert_eq!(id.catalog_table_id, items.catalog_table_id);
    assert_eq!(missing.resolution, EditorSemanticResolution::UNRESOLVED);
}

#[test]
fn projects_function_reference_spans() {
    let catalog = new_catalog();
    let _schema = load_schema(&catalog, "create table items (id int)");
    let mut session = session(&catalog, UTF8);
    let text = "select count(id) from items";
    let update = analyze(&mut session, text);
    assert!(find_semantic_span(&update, text, EditorSemanticReferenceKind::FUNCTION, "count").is_some());
    assert!(find_semantic_span(&update, text, EditorSemanticReferenceKind::TABLE, "items").is_some());
}

#[test]
fn projects_primary_cursor_semantic_context_and_related_references() {
    let catalog = new_catalog();
    let _schema = load_schema(&catalog, "create table items (id int)");
    let mut session = session(&catalog, UTF8);
    let text = "select id from items where id = 1 and items.id > 0";
    let update = analyze(&mut session, text);
    assert_eq!(update.status, EditorUpdateStatus::OK);

    let column_update = session.set_primary_cursor(session.text_version(), 8);
    let context = column_update.primary_cursor_context.as_ref().unwrap();
    assert_eq!(context.kind, EditorCursorSemanticKind::COLUMN_REFERENCE);
    assert!(context.resolved);
    assert_eq!(context.related_table_reference_ids.as_ref().unwrap().len(), 1);
    assert_eq!(context.related_column_reference_ids.as_ref().unwrap().len(), 3);
    assert_eq!(context.catalog_column_id, 0);

    let table_offset = text.find("items").unwrap() as u64 + 2;
    let table_update = session.set_primary_cursor(session.text_version(), table_offset);
    let context = table_update.primary_cursor_context.as_ref().unwrap();
    assert_eq!(context.kind, EditorCursorSemanticKind::TABLE_REFERENCE);
    assert!(context.resolved);
    assert_eq!(context.related_table_reference_ids.as_ref().unwrap().len(), 1);
    assert_eq!(context.related_column_reference_ids.as_ref().unwrap().len(), 3);
}

#[test]
fn projects_script_annotations_and_plain_processing_statistics() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    let text = "create table result (id int); select id from result";
    let update = analyze(&mut session, text);

    let annotations = update.script_annotations.as_ref().unwrap();
    let definitions = annotations.table_definitions.as_ref().unwrap();
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].name.as_deref(), Some("result"));
    assert_eq!(definitions[0].statement_id, 0);
    assert_eq!(annotations.referenced_table_names.as_deref(), Some(&["result".to_string()][..]));
    assert!(!annotations.has_visualization_compilation);
    let statements = annotations.statements.as_ref().unwrap();
    assert_eq!(statements.len(), 2);
    assert_eq!(statements[0].statement_id, 0);
    assert_eq!(statements[0].statement_type, StatementType::CREATE_TABLE);
    assert_eq!(statements[1].statement_id, 1);
    assert_eq!(statements[1].statement_type, StatementType::SELECT);
    let statistics = update.processing_statistics.as_ref().unwrap();
    assert!(statistics.rope_bytes > 0);
    assert_eq!(statistics.scanner_input_bytes, text.len() as u64);
    assert!(statistics.scanner_symbol_bytes > 0);
    assert!(statistics.parser_ast_bytes > 0);
    assert!(statistics.analyzer_description_bytes > 0);
    assert!(statistics.scanner_last_elapsed_ns >= 0.0);
    assert!(statistics.parser_last_elapsed_ns >= 0.0);
    assert!(statistics.analyzer_last_elapsed_ns >= 0.0);
}

#[test]
fn projects_statement_descriptions_as_utf16() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);
    let update = analyze(&mut session, "-- \u{1F600} summary\nselect 1;");

    let annotations = update.script_annotations.as_ref().unwrap();
    let statements = annotations.statements.as_ref().unwrap();
    assert_eq!(statements.len(), 1);
    let span = statements[0].text_span.as_ref().unwrap();
    assert_eq!((span.offset, span.length), (14, 8));
    let descriptions = annotations.statement_descriptions.as_ref().unwrap();
    assert_eq!(descriptions.len(), 1);
    assert_eq!(descriptions[0].statement_id, 0);
    assert_eq!(descriptions[0].statement_type, StatementType::SELECT);
    let span = descriptions[0].text_span.as_ref().unwrap();
    assert_eq!((span.offset, span.length), (14, 8));
}

#[test]
fn projects_incomplete_with_prefix_as_utf16() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);
    let update = analyze(&mut session, "wit");
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(update.analysis_available);
}

#[test]
fn projects_incrementally_typed_with_prefix_as_utf16() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);
    for character in ["w", "i", "t"] {
        let offset = session.text().len() as u64;
        let mut e = event(session.text_version(), vec![change(offset, offset, character)]);
        e.analyze = true;
        e.primary_selection = selection(offset + 1, offset + 1);
        let update = session.apply(&e);
        assert_eq!(update.status, EditorUpdateStatus::OK);
        assert!(update.analysis_available);
    }
    assert_eq!(session.text(), "wit");
}

#[test]
fn projects_incomplete_with_prefix_after_utf8_as_utf16() {
    for text in ["\u{e9} wit", "'\u{e9}' wit", "-- \u{1F600}\nwit", "select '\u{e9}'; wit", "select caf\u{e9}\nwit"] {
        let catalog = new_catalog();
        let mut session = session(&catalog, UTF16);
        let update = analyze(&mut session, text);
        assert_eq!(update.status, EditorUpdateStatus::OK, "{text}");
        assert!(update.analysis_available, "{text}");
    }
}

#[test]
fn session_owns_script_and_update_buffers() {
    let catalog = new_catalog();
    let initial_catalog_revision = catalog.borrow().version();
    let entry_id;
    {
        let mut session = session(&catalog, UTF8);
        entry_id = session.catalog_entry_id();

        let update = session.replace_text(0, "select 42");
        assert_eq!(update.status, EditorUpdateStatus::OK);
        assert_eq!(update.offset_unit, UTF8);
        assert_eq!(update.text_version, 1);

        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = event(1, vec![change(9, 9, "!")]).pack(&mut builder);
        builder.finish(packed, None);
        let update = session.apply_buffer(builder.finished_data());
        assert_eq!(update.status, EditorUpdateStatus::OK);
        assert_eq!(update.text_version, 2);
        assert_eq!(session.text(), "select 42!");

        let update = session.set_primary_cursor(2, 10);
        assert_eq!(update.status, EditorUpdateStatus::OK);
        assert_eq!(update.primary_selection.as_ref().unwrap().head, 10);

        let update = session.analyze();
        assert_eq!(update.status, EditorUpdateStatus::OK);
        assert!(update.analysis_available);
        assert!(update.syntax_spans.as_ref().is_some_and(|s| !s.is_empty()));
        assert!(update.processing_statistics.as_ref().unwrap().scanner_input_bytes > 0);
        assert!(!catalog.borrow().contains(entry_id));

        assert_eq!(session.apply_buffer(&[]).status, EditorUpdateStatus::INVALID_EVENT);
    }
    assert!(!catalog.borrow().contains(entry_id));
    assert_eq!(catalog.borrow().version(), initial_catalog_revision);
}

#[test]
fn completion_api_matches_normal_script() {
    let text = "select caf\u{e9} from items";
    let cursor_offset = text.len();

    let script_catalog = Catalog::new();
    let mut script = Script::new(&script_catalog);
    script.replace_text(text);
    script.analyze(&script_catalog, true).unwrap();
    let cursor = script.move_cursor(&script_catalog, cursor_offset);
    let expected = pack_completion(&Script::complete_at_cursor(&cursor, 10).unwrap(), false);

    let session_catalog = new_catalog();
    let mut session = session(&session_catalog, UTF8);
    session.replace_text(0, text);
    session.set_primary_cursor(1, cursor_offset as u64);
    session.analyze();
    assert_eq!(session.complete(10, KeywordCase::LOWER).unwrap(), expected);
}

#[test]
fn compatibility_query_formatting_and_diff_apis() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    let source_text = "select 1 as value";
    session.replace_text(0, source_text);
    session.analyze();

    let compiled = session.compile_query(&config(), true, true);
    assert_eq!(compiled.sql.as_deref(), Some(source_text));
    assert!(compiled.errors.as_ref().is_none_or(|e| e.is_empty()));

    assert!(session.is_fully_formattable(&config(), true).unwrap());
    let formatted = session.format(&config(), true, None).unwrap();
    assert_eq!(formatted.to_text(), "select 1 as value;");

    let mut target = Script::new(&catalog.borrow());
    target.replace_text("select 2 as value");
    target.parse();
    let diff = session.diff(&target).unwrap();
    let ops = diff.ops.as_ref().unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].code, ScriptDiffOpCode::UPDATE);
}

#[test]
fn rewrites_dashboard_through_parsed_ast() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);
    let source = "select '\u{1F4CA} dashboard => (ignored)' as label visualize using table (dashboard => (row => 1, width => 4))";
    assert_eq!(session.replace_text(0, source).status, EditorUpdateStatus::OK);

    assert_eq!(
        session.rewrite_dashboard(Some(2), Some(5), 6, 4, true).unwrap(),
        "select '\u{1F4CA} dashboard => (ignored)' as label visualize using table (dashboard => (row => 2, column => 5, width => 6, height => 4))"
    );
    assert_eq!(
        session.rewrite_dashboard(None, None, 6, 3, true).unwrap(),
        "select '\u{1F4CA} dashboard => (ignored)' as label visualize using table (dashboard => (width => 6, height => 3))"
    );
}

#[test]
fn inserts_dashboard_into_terminal_visualization() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "select 1 visualize using table ()").status, EditorUpdateStatus::OK);
    assert_eq!(
        session.rewrite_dashboard(Some(0), Some(0), 6, 3, true).unwrap(),
        "select 1 visualize using table (dashboard => (row => 0, column => 0, width => 6, height => 3))"
    );
}

#[test]
fn catalog_load_and_drop_use_session_owned_script_and_rank() {
    let catalog = new_catalog();
    let entry_id;
    {
        let mut session = session(&catalog, UTF8);
        entry_id = session.catalog_entry_id();
        session.replace_text(0, "create table items (id int)");
        session.analyze();

        session.load_into_catalog(17).unwrap();
        assert!(catalog.borrow().contains(entry_id));
        let entries: Vec<_> =
            catalog.borrow().entries_ranked().map(|(rank, e)| (e.data().catalog_entry_id, rank)).collect();
        assert_eq!(entries, vec![(entry_id, 17)]);

        session.drop_from_catalog();
        assert!(!catalog.borrow().contains(entry_id));

        session.load_into_catalog(23).unwrap();
        assert!(catalog.borrow().contains(entry_id));
    }
    assert!(!catalog.borrow().contains(entry_id));
}

// api_test.cc

#[test]
fn get_statement_text_excludes_separator_and_trivia() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, "  SELECT ';' AS value ; -- trailing comment\n");
    assert_eq!(script.statement_text(true).unwrap(), "SELECT ';' AS value");
}

#[test]
fn failed_catalog_analysis_does_not_block_script_sessions() {
    let catalog = new_catalog();
    let mut invalid = Script::new(&catalog.borrow());
    assert!(invalid.analyze(&catalog.borrow(), false).is_err());

    let mut session = session(&catalog, UTF16);
    assert_eq!(session.replace_text(0, "select 1").status, EditorUpdateStatus::OK);
    let analyzed = session.analyze();
    assert_eq!(analyzed.status, EditorUpdateStatus::OK);
    assert!(analyzed.analysis_available);
}

#[test]
fn session_exposes_64bit_text_versions() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    let version = (1u64 << 32) + 42;
    session.script_mut().set_text_version(version - 1);
    let update = session.replace_text(version - 1, "select 1");
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert_eq!(update.text_version, version);
    assert_eq!(session.text_version(), version);

    let update = session.set_primary_cursor(version - 1, 0);
    assert_eq!(update.status, EditorUpdateStatus::STALE_TEXT_VERSION);
    assert_eq!(update.text_version, version);

    let update = session.apply_buffer(&[]);
    assert_eq!(update.status, EditorUpdateStatus::INVALID_EVENT);
    assert_eq!(update.text_version, version);
}

// Script facade methods without a C++ unit test

#[test]
fn reports_memory_statistics_of_the_latest_analysis() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select a from b");
    let statistics = script.statistics();
    let memory = statistics.memory.as_ref().unwrap();
    assert_eq!(memory.rope_bytes, 15);
    assert_eq!(memory.latest_script.scanner_input_bytes, 0);
    script.analyze(&catalog, true).unwrap();
    let memory = script.memory_statistics();
    assert_eq!(memory.latest_script.scanner_input_bytes, 15);
    assert_eq!(
        memory.latest_script.parser_ast_bytes as usize,
        script.parsed.as_ref().unwrap().nodes.len() * std::mem::size_of::<dashql_buffers::parser::Node>()
    );
    assert_eq!(memory.latest_script.analyzer_name_index_size, 0);
    let _ = script.analyzed.as_ref().unwrap().name_search_index();
    // "a" and "b" have one suffix each
    assert_eq!(script.memory_statistics().latest_script.analyzer_name_index_size, 2);
}

#[test]
fn rejects_dashboard_rewrites_without_terminal_visualization() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select 1");
    assert!(script.rewrite_dashboard(None, None, 4, 4, true).is_err());
    script.replace_text("select 1 visualize using vegalite (mark => bar)");
    assert_eq!(
        script.rewrite_dashboard(Some(-1), Some(20), 20, 0, true).unwrap(),
        "select 1 visualize using vegalite (mark => bar, dashboard => (column => 0, width => 12, height => 1))"
    );
}

#[test]
fn rejects_unknown_offset_units() {
    let error = ScriptSession::new(new_catalog(), EditorOffsetUnit(99)).err().expect("invalid unit");
    assert_eq!(error.message, "invalid editor offset unit");
    assert_eq!(session(&new_catalog(), UTF8).offset_unit(), UTF8);
    assert_eq!(session(&new_catalog(), UTF16).offset_unit(), UTF16);
}

#[test]
fn rejects_reversed_change_ranges() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "abcdef").status, EditorUpdateStatus::OK);
    let update = session.apply(&event(1, vec![change(4, 2, "X")]));
    assert_eq!(update.status, EditorUpdateStatus::INVALID_RANGE);
    assert_eq!(session.text(), "abcdef");
    assert_eq!(session.text_version(), 1);
}

#[test]
fn keeps_the_selection_while_it_resolves_in_the_new_text() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "abcdef").status, EditorUpdateStatus::OK);
    assert!(session.primary_selection().is_none());

    let mut e = event(1, vec![]);
    e.primary_selection = selection(2, 4);
    let update = session.apply(&e);
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(update.selection_changed);
    let kept = session.primary_selection().unwrap();
    assert_eq!((kept.anchor, kept.head), (2, 4));

    // An edit after the selection keeps it
    let update = session.apply(&event(1, vec![change(6, 6, "gh")]));
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(!update.selection_changed);
    assert!(session.primary_selection().is_some());

    // An edit that removes the text the selection points into drops it
    let update = session.apply(&event(2, vec![change(2, 8, "")]));
    assert_eq!(update.status, EditorUpdateStatus::OK);
    assert!(update.selection_changed);
    assert!(session.primary_selection().is_none());
}

#[test]
fn rejects_selections_inside_of_code_points() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "é").status, EditorUpdateStatus::OK);
    let mut e = event(1, vec![]);
    e.primary_selection = selection(1, 1);
    let update = session.apply(&e);
    assert_eq!(update.status, EditorUpdateStatus::INVALID_RANGE);
    assert!(session.primary_selection().is_none());
}

#[test]
fn diff_needs_parsed_scripts() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF8);
    assert_eq!(session.replace_text(0, "select 1").status, EditorUpdateStatus::OK);
    let mut target = Script::new(&catalog.borrow());
    target.replace_text("select 2");
    // Neither side is parsed yet
    let error = session.diff(&target).unwrap_err();
    assert_eq!(error.status, Some(dashql_buffers::status::StatusCode::SCRIPT_NOT_PARSED));
    session.script_mut().parse();
    assert!(session.diff(&target).is_err());
    target.parse();
    assert!(session.diff(&target).is_ok());
}

#[test]
fn diff_projects_spans_into_utf16() {
    let catalog = new_catalog();
    let mut session = session(&catalog, UTF16);
    assert_eq!(session.replace_text(0, "select '🙂'; select 1").status, EditorUpdateStatus::OK);
    session.script_mut().parse();
    let mut target = Script::new(&catalog.borrow());
    target.replace_text("select '🙂'; select 2");
    target.parse();
    let diff = session.diff(&target).unwrap();
    let ops = diff.ops.unwrap();
    assert!(!ops.is_empty());
    // The emoji takes 2 UTF-16 units but 4 UTF-8 bytes
    let spans: Vec<_> = ops.iter().filter_map(|op| op.source_span.as_ref()).collect();
    assert!(spans.iter().all(|s| s.offset + s.length <= 21), "{spans:?}");
}
