//! Editor sessions, a port of `src/script_session.cc`.
//!
//! A session owns the script of one editor document. Editor events are validated and applied
//! atomically, offsets at the API boundary use the unit chosen when the session is created (UTF-8
//! bytes or UTF-16 code units), and every operation answers with an `EditorUpdate` that projects
//! the current analysis (diagnostics, syntax and semantic spans, cursor, annotations, statistics).
//!
//! **Catalog ownership.** A session shares its catalog through a [`CatalogHandle`]
//! (`Rc<RefCell<Catalog>>`) instead of borrowing it like the C++ session (`Catalog&`). The wasm API
//! hands JS one catalog object and any number of session objects with independent lifetimes, which
//! a borrow cannot express, and explicit catalog arguments per call would let a caller pass another
//! catalog than the one the script was analyzed against. The catalog is borrowed only for the
//! duration of a call. Dropping a session drops its script from the catalog, like the destructor of
//! the C++ script.
//!
//! The C++ session leaves the projection of offsets to the rope for every span. Projections here
//! convert the mostly ascending offsets of a script in one pass (`Utf16Projector`).

use crate::analyzer::{AnalyzedScript, ExpressionInner, TableReference};
use crate::catalog::{Catalog, CatalogEntryId, QualifiedTableName, Rank};
use crate::compiler::{compile, CompilationOptions};
use crate::completion::is_symbol_kind_completable;
use crate::cursor::CursorContext;
use crate::error::{Error, Result};
use crate::pack::{pack_completion, pack_tokens};
use crate::script::{Script, TextVersion};
use crate::script_diff::ScriptDiff;
use crate::utils::rope::{resolve_byte_boundary, resolve_utf16_boundary, TextPosition, Utf16Projector};
use dashql_buffers::analyzer::AnalyzerErrorSeverity;
use dashql_buffers::completion::CompletionT;
use dashql_buffers::cursor::RelativeSymbolPosition;
use dashql_buffers::diff::ScriptDiffT;
use dashql_buffers::editor::{
    EditorCursorSemanticContextT, EditorCursorSemanticKind, EditorCursorStateT, EditorDiagnosticSeverity,
    EditorDiagnosticSource, EditorDiagnosticT, EditorEvent, EditorEventAction, EditorEventIntent, EditorEventOrigin,
    EditorEventT, EditorOffsetUnit, EditorProcessingStatisticsT, EditorScriptAnnotationsT, EditorSelectionT,
    EditorSemanticReferenceKind, EditorSemanticResolution, EditorSemanticSpanT, EditorStatementDescriptionT,
    EditorStatementT, EditorSyntaxSpanT, EditorTableDefinitionT, EditorTextChangeT, EditorTextSpanT,
    EditorUpdateStatus, EditorUpdateT,
};
use dashql_buffers::execution::ScriptCompilationResultT;
use dashql_buffers::formatting::{FormattingConfigT, KeywordCase};
use dashql_buffers::parser::{AttributeKey, ScannerTokenType, SymbolSpan, SymbolSpanT, TextSpanT};
use dashql_buffers::status::StatusCode;
use dashql_parser::attrs;
use dashql_parser::parser::context::resolve_text_span;
use dashql_parser::span::TextSpan;
use ropey::Rope;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

/// The catalog shared by the sessions and scripts of an editor
pub type CatalogHandle = Rc<RefCell<Catalog>>;

/// A version that never matches (`std::numeric_limits<...>::max()`)
const NO_VERSION: u64 = u64::MAX;

/// A vector the C++ object API leaves out when empty
fn non_empty<T>(v: Vec<T>) -> Option<Vec<T>> {
    (!v.is_empty()).then_some(v)
}

/// A string the C++ object API leaves out when empty
fn non_empty_string(s: impl Into<String>) -> Option<String> {
    let s = s.into();
    (!s.is_empty()).then_some(s)
}

/// A text change, validated and resolved to byte and code point offsets (`PreparedChange`)
struct PreparedChange<'e> {
    /// The UTF-8 byte offset where the replaced range begins
    from_byte: usize,
    /// The UTF-8 byte offset where the replaced range ends
    to_byte: usize,
    /// The code point offset where the replaced range begins
    from_codepoint: usize,
    /// The code point offset where the replaced range ends
    to_codepoint: usize,
    /// The inserted text
    insert: &'e str,
    /// The index of the change in the event, orders changes at the same range
    input_order: usize,
}

/// The catalog ids of a resolved table (`ResolvedTableIDs`)
#[derive(Clone, Copy)]
struct ResolvedTableIds {
    /// The database id
    database_id: u32,
    /// The schema id
    schema_id: u32,
    /// The packed table id
    table_id: u64,
    /// The catalog version the reference was resolved against
    catalog_version: u32,
}

impl ResolvedTableIds {
    fn same_table(&self, other: &ResolvedTableIds) -> bool {
        self.database_id == other.database_id && self.schema_id == other.schema_id && self.table_id == other.table_id
    }
}

/// The ids of the table a reference resolved to (`GetResolvedTableIDs`)
fn resolved_table_ids(reference: &TableReference) -> Option<ResolvedTableIds> {
    let resolved = reference.inner.as_ref()?.resolved_table.as_ref()?;
    let (database_id, schema_id) = resolved.catalog_schema_id.unpack_schema_id();
    Some(ResolvedTableIds {
        database_id,
        schema_id,
        table_id: resolved.catalog_table_id.unpack_table_id().pack(),
        catalog_version: resolved.referenced_catalog_version,
    })
}

/// The ids of the table and column of a resolved column reference
fn resolved_column_ids(expression: &crate::analyzer::Expression) -> Option<(ResolvedTableIds, u32)> {
    let ExpressionInner::ColumnRef(column) = &expression.inner else {
        return None;
    };
    let resolved = column.resolved_ids?;
    let (database_id, schema_id) = resolved.catalog_schema_id.unpack_schema_id();
    let (table_id, column_id) = resolved.catalog_table_column_id.unpack_table_column_id();
    Some((
        ResolvedTableIds {
            database_id,
            schema_id,
            table_id: table_id.pack(),
            catalog_version: resolved.referenced_catalog_version,
        },
        column_id,
    ))
}

/// `FormatTableName`
fn format_table_name(name: &QualifiedTableName) -> String {
    let mut out = String::new();
    if !name.schema_name.text.is_empty() {
        out.push_str(&name.schema_name.text);
        out.push('.');
    }
    out.push_str(&name.table_name.text);
    out
}

/// Converts internal UTF-8 byte offsets to the offset unit of a session
/// (`TryProjectByteOffset`, `ProjectTextSpan`)
enum Projector<'a> {
    Bytes,
    Utf16(Utf16Projector<'a>),
}

impl Projector<'_> {
    /// Project a byte offset, None if it does not lie on a code point boundary of the text. UTF-8
    /// offsets are passed through unchecked, like in C++.
    fn offset(&mut self, offset: u64) -> Option<u64> {
        match self {
            Projector::Bytes => Some(offset),
            Projector::Utf16(projector) => {
                let offset = usize::try_from(offset).ok()?;
                projector.project(offset).map(|o| o as u64)
            }
        }
    }

    /// Project a byte span (`ProjectTextSpan`)
    fn span(&mut self, span: TextSpan) -> Option<EditorTextSpanT> {
        let begin = self.offset(span.offset as u64)?;
        let end = self.offset(span.offset as u64 + span.length as u64)?;
        if end < begin {
            return None;
        }
        let mut out = EditorTextSpanT::default();
        out.offset = begin;
        out.length = end - begin;
        Some(out)
    }
}

/// The state of one editor document (`ScriptSession`)
pub struct ScriptSession {
    /// The catalog the script is analyzed against
    catalog: CatalogHandle,
    /// The script of the document
    script: Script,
    /// The unit of the text offsets exchanged with the editor
    offset_unit: EditorOffsetUnit,
    /// Bumped by every committed change of the text, selection or analysis
    state_revision: u64,
    /// The text version the analysis is current with, `NO_VERSION` if none
    analyzed_text_version: TextVersion,
    /// The catalog version the analysis is current with, `NO_VERSION` if none
    analyzed_catalog_revision: u64,
    /// The text version the cursor is current with, `NO_VERSION` if not placed
    cursor_text_version: TextVersion,
    /// The catalog version the cursor is current with, `NO_VERSION` if not placed
    cursor_catalog_revision: u64,
    /// The primary editor selection, in the offset unit of the session
    primary_selection: Option<EditorSelectionT>,
}

impl Drop for ScriptSession {
    /// Drop the script from the catalog, like the destructor of the C++ script
    fn drop(&mut self) {
        if let Ok(mut catalog) = self.catalog.try_borrow_mut() {
            catalog.drop_script(self.script.catalog_entry_id());
        }
    }
}

impl ScriptSession {
    /// Create an empty session whose script gets a new entry id of the catalog
    pub fn new(catalog: CatalogHandle, offset_unit: EditorOffsetUnit) -> Result<Self> {
        if offset_unit != EditorOffsetUnit::UTF8_BYTES && offset_unit != EditorOffsetUnit::UTF16_CODE_UNITS {
            return Err(Error::invalid_argument("invalid editor offset unit"));
        }
        let script = Script::new(&catalog.borrow());
        Ok(Self {
            catalog,
            script,
            offset_unit,
            state_revision: 0,
            analyzed_text_version: NO_VERSION,
            analyzed_catalog_revision: NO_VERSION,
            cursor_text_version: NO_VERSION,
            cursor_catalog_revision: NO_VERSION,
            primary_selection: None,
        })
    }

    /// The catalog of the session
    pub fn catalog(&self) -> &CatalogHandle {
        &self.catalog
    }

    pub fn catalog_entry_id(&self) -> CatalogEntryId {
        self.script.catalog_entry_id()
    }

    /// The text
    pub fn text(&self) -> String {
        self.script.to_text()
    }

    /// The text version, bumped by every committed text change
    pub fn text_version(&self) -> TextVersion {
        self.script.text_version()
    }

    /// The revision bumped by every committed change of the text, selection or analysis
    pub fn state_revision(&self) -> u64 {
        self.state_revision
    }

    /// The version of the catalog
    pub fn catalog_revision(&self) -> u64 {
        self.catalog.borrow().version() as u64
    }

    pub fn offset_unit(&self) -> EditorOffsetUnit {
        self.offset_unit
    }

    /// The primary selection, if the host supplied one
    pub fn primary_selection(&self) -> Option<&EditorSelectionT> {
        self.primary_selection.as_ref()
    }

    pub fn script(&self) -> &Script {
        &self.script
    }

    /// The script, for workflows such as compilation and execution. Direct edits share the text
    /// version of the session.
    pub fn script_mut(&mut self) -> &mut Script {
        &mut self.script
    }

    /// The end of the document in the offset unit
    fn document_end(&self) -> u64 {
        match self.offset_unit {
            EditorOffsetUnit::UTF16_CODE_UNITS => self.script.text().len_utf16_cu() as u64,
            _ => self.script.text().len_bytes() as u64,
        }
    }

    /// Resolve an offset of the session unit to a position in a text (`ResolveOffset`)
    fn resolve_offset(&self, text: &Rope, offset: u64) -> Option<TextPosition> {
        let offset = usize::try_from(offset).ok()?;
        match self.offset_unit {
            EditorOffsetUnit::UTF16_CODE_UNITS => resolve_utf16_boundary(text, offset),
            _ => resolve_byte_boundary(text, offset),
        }
    }

    /// A projector of byte offsets into the current text. `text` speeds up UTF-16 projections and
    /// must equal the current text.
    fn projector<'a>(&'a self, text: Option<&'a str>) -> Projector<'a> {
        match self.offset_unit {
            EditorOffsetUnit::UTF16_CODE_UNITS => {
                let rope = self.script.text();
                Projector::Utf16(Utf16Projector::new(text.filter(|t| t.len() == rope.len_bytes()), rope))
            }
            _ => Projector::Bytes,
        }
    }

    /// Project a byte offset into the current text or fail (`ProjectByteOffset`)
    fn project_byte_offset(projector: &mut Projector, offset: u64) -> Result<u64> {
        projector
            .offset(offset)
            .ok_or_else(|| Error::invalid_argument("internal text span is not on a UTF-8 codepoint boundary"))
    }

    /// Does the analysis match the text and the catalog? (`IsAnalysisCurrent`)
    fn is_analysis_current(&self, catalog: &Catalog) -> bool {
        let text_version = self.text_version();
        let catalog_version = catalog.version() as u64;
        let Some(analyzed) = self.script.analyzed.as_ref() else {
            return false;
        };
        self.analyzed_text_version == text_version
            && self.analyzed_catalog_revision == catalog_version
            && analyzed.entry.catalog_version as u64 == catalog_version
            && self.script.parsed.as_ref().is_some_and(|p| Arc::ptr_eq(p, &analyzed.parsed))
            && self.script.scanned.as_ref().is_some_and(|s| Arc::ptr_eq(s, &analyzed.parsed.scanned))
            && analyzed.parsed.scanned.text_version == text_version
    }

    /// The revision and selection part of an update (`MakeUpdate`)
    fn make_update(&self) -> EditorUpdateT {
        let catalog = self.catalog.borrow();
        let mut update = EditorUpdateT::default();
        update.status = EditorUpdateStatus::OK;
        update.offset_unit = self.offset_unit;
        update.catalog_entry_id = self.catalog_entry_id();
        update.text_version = self.text_version();
        update.state_revision = self.state_revision;
        update.catalog_revision = catalog.version() as u64;
        update.analysis_available = self.is_analysis_current(&catalog);
        update.primary_selection = self.primary_selection.clone().map(Box::new);
        update
    }

    /// The update of an event buffer that is not a valid EditorEvent (`packInvalidEditorEvent` of
    /// the C API)
    pub fn invalid_event_update(&self) -> EditorUpdateT {
        let mut update = EditorUpdateT::default();
        update.status = EditorUpdateStatus::INVALID_EVENT;
        update.status_message = Some("invalid EditorEvent FlatBuffer".to_string());
        update.offset_unit = self.offset_unit;
        update.catalog_entry_id = self.catalog_entry_id();
        update.text_version = self.text_version();
        update.state_revision = self.state_revision;
        update.catalog_revision = self.catalog_revision();
        update
    }

    /// Bring the analysis up to date with the text and the catalog (`Analyze(EditorUpdate&)`)
    fn analyze_into(&mut self, update: &mut EditorUpdateT) -> bool {
        let catalog = self.catalog.borrow();
        if self.is_analysis_current(&catalog) {
            update.analysis_available = true;
            return true;
        }
        match self.script.analyze(&catalog, true) {
            Ok(()) => {
                self.analyzed_text_version = self.script.text_version();
                self.analyzed_catalog_revision = catalog.version() as u64;
                update.analysis_updated = true;
                update.analysis_available = true;
                true
            }
            Err(error) => {
                update.status = EditorUpdateStatus::ANALYSIS_FAILED;
                update.status_message = non_empty_string(error.what());
                if let Some(status) = error.status {
                    update.core_status = status;
                }
                false
            }
        }
    }

    /// Place the cursor at the head of the primary selection, if it resolves
    fn place_cursor_at_selection(&mut self) -> bool {
        let Some(head) = self.primary_selection.as_ref().map(|s| s.head) else {
            return false;
        };
        match self.resolve_offset(self.script.text(), head) {
            Some(position) => {
                self.script.set_cursor_offset(Some(position.text_bytes));
                true
            }
            None => false,
        }
    }

    /// Replace the whole text if the expected version matches (`ReplaceText`)
    pub fn replace_text(&mut self, expected_text_version: TextVersion, text: &str) -> EditorUpdateT {
        let mut change = EditorTextChangeT::default();
        change.from = 0;
        change.to = self.document_end();
        change.insert = Some(text.to_string());
        let mut event = EditorEventT::default();
        event.expected_text_version = expected_text_version;
        event.origin = EditorEventOrigin::SYSTEM;
        event.intent = EditorEventIntent::REPLACE;
        event.action = EditorEventAction::APPLY;
        event.changes = Some(vec![change]);
        self.apply(&event)
    }

    /// Move the primary cursor without changing the text (`SetPrimaryCursor`)
    pub fn set_primary_cursor(&mut self, expected_text_version: TextVersion, offset: u64) -> EditorUpdateT {
        let mut selection = EditorSelectionT::default();
        selection.anchor = offset;
        selection.head = offset;
        let mut event = EditorEventT::default();
        event.expected_text_version = expected_text_version;
        event.origin = EditorEventOrigin::USER;
        event.intent = EditorEventIntent::SELECTION;
        event.primary_selection = Some(Box::new(selection));
        self.apply(&event)
    }

    /// Apply an EditorEvent FlatBuffer. Buffers that fail verification, including inserts that are
    /// not valid UTF-8, are rejected with INVALID_EVENT (the C++ session reports INVALID_UTF8 for
    /// invalid inserts, because the C++ verifier does not check strings).
    pub fn apply_buffer(&mut self, event: &[u8]) -> EditorUpdateT {
        match flatbuffers::root::<EditorEvent>(event) {
            Ok(event) => self.apply(&event.unpack()),
            Err(_) => self.invalid_event_update(),
        }
    }

    /// Validate and apply an editor event atomically (`Apply`)
    pub fn apply(&mut self, event: &EditorEventT) -> EditorUpdateT {
        let mut update = self.make_update();
        update.origin = event.origin;
        update.intent = event.intent;
        update.action = event.action;
        if event.expected_text_version != self.text_version() {
            update.status = EditorUpdateStatus::STALE_TEXT_VERSION;
            update.status_message = Some("editor event targets a stale text version".to_string());
            return self.finalize_update(update);
        }

        // Validate the changes in pre-change offsets
        let text = self.script.text();
        let document_end = self.document_end();
        let event_changes = event.changes.as_deref().unwrap_or(&[]);
        let mut changes = Vec::with_capacity(event_changes.len());
        for (i, change) in event_changes.iter().enumerate() {
            let insert = change.insert.as_deref().unwrap_or("");
            let insert_past_end = change.from == change.to && change.from > document_end;
            let (from_offset, to_offset) =
                if insert_past_end { (document_end, document_end) } else { (change.from, change.to) };
            let from = self.resolve_offset(text, from_offset);
            let to = self.resolve_offset(text, to_offset);
            let (Some(from), Some(to)) = (from, to) else {
                return self.reject(
                    update,
                    EditorUpdateStatus::INVALID_RANGE,
                    "text change range is not on codepoint boundaries in the session offset unit",
                );
            };
            if change.from > change.to {
                return self.reject(
                    update,
                    EditorUpdateStatus::INVALID_RANGE,
                    "text change range is not on codepoint boundaries in the session offset unit",
                );
            }
            changes.push(PreparedChange {
                from_byte: from.text_bytes,
                to_byte: to.text_bytes,
                from_codepoint: from.utf8_codepoints,
                to_codepoint: to.utf8_codepoints,
                insert,
                input_order: i,
            });
        }
        changes.sort_by_key(|c| (c.from_byte, c.to_byte, c.input_order));
        if changes.windows(2).any(|w| w[1].from_byte < w[0].to_byte) {
            return self.reject(
                update,
                EditorUpdateStatus::OVERLAPPING_CHANGES,
                "text changes overlap in the pre-change document",
            );
        }

        // Apply the changes back to front to a copy of the rope, which shares the unchanged nodes
        let mut text_changed = false;
        let mut edited = None;
        if let (Some(first), Some(last)) = (changes.first(), changes.last()) {
            let mut next = text.clone();
            for change in changes.iter().rev() {
                next.remove(change.from_codepoint..change.to_codepoint);
                next.insert(change.from_codepoint, change.insert);
            }
            // Text before the first and after the last change is unchanged, compare only the edited
            // range if the length stayed the same
            text_changed = next.len_bytes() != text.len_bytes()
                || next.get_byte_slice(first.from_byte..last.to_byte)
                    != Some(text.byte_slice(first.from_byte..last.to_byte));
            edited = Some(next);
        }
        let next_text = edited.as_ref().unwrap_or(text);

        let mut next_selection = self.primary_selection.clone();
        if let Some(selection) = event.primary_selection.as_deref() {
            if self.resolve_offset(next_text, selection.anchor).is_none()
                || self.resolve_offset(next_text, selection.head).is_none()
            {
                return self.reject(
                    update,
                    EditorUpdateStatus::INVALID_RANGE,
                    "primary selection is not on codepoint boundaries in the session offset unit",
                );
            }
            next_selection = Some(selection.clone());
        } else if text_changed {
            if let Some(selection) = &next_selection {
                if self.resolve_offset(next_text, selection.anchor).is_none()
                    || self.resolve_offset(next_text, selection.head).is_none()
                {
                    next_selection = None;
                }
            }
        }

        update.text_changed = text_changed;
        update.selection_changed = self.primary_selection != next_selection;
        if text_changed {
            // Never leave a catalog entry pointing at the previous analysis while the script is
            // replaced and reanalyzed
            self.catalog.borrow_mut().drop_script(self.catalog_entry_id());
            self.script.set_text(edited.unwrap());
            self.script.set_cursor_offset(None);
            self.cursor_text_version = NO_VERSION;
            self.cursor_catalog_revision = NO_VERSION;
        }
        self.primary_selection = next_selection;

        // Selection updates also publish a complete projection. Refresh a stale analysis first,
        // otherwise a catalog change would turn a cursor move into an empty projection.
        let analysis_stale = !self.is_analysis_current(&self.catalog.borrow());
        let analysis_succeeded =
            !(event.analyze || (event.primary_selection.is_some() && analysis_stale)) || self.analyze_into(&mut update);
        let catalog_version = self.catalog_revision();
        let analysis_current = self.is_analysis_current(&self.catalog.borrow());
        let cursor_outdated = event.primary_selection.is_some()
            || update.text_changed
            || update.analysis_updated
            || self.script.cursor_offset().is_none()
            || self.cursor_text_version != self.text_version()
            || self.cursor_catalog_revision != catalog_version;
        if analysis_succeeded && analysis_current && self.primary_selection.is_some() && cursor_outdated {
            if self.place_cursor_at_selection() {
                self.cursor_text_version = self.text_version();
                self.cursor_catalog_revision = catalog_version;
            }
        } else if analysis_succeeded && analysis_current && self.primary_selection.is_none() {
            self.script.set_cursor_offset(None);
            self.cursor_text_version = NO_VERSION;
            self.cursor_catalog_revision = NO_VERSION;
        }
        if update.text_changed || update.selection_changed || update.analysis_updated {
            self.state_revision += 1;
        }

        update.text_version = self.text_version();
        update.state_revision = self.state_revision;
        update.catalog_revision = catalog_version;
        update.analysis_available = analysis_current;
        update.primary_selection = self.primary_selection.clone().map(Box::new);
        self.finalize_update(update)
    }

    /// Reject an event with a status
    fn reject(&self, mut update: EditorUpdateT, status: EditorUpdateStatus, message: &str) -> EditorUpdateT {
        update.status = status;
        update.status_message = Some(message.to_string());
        self.finalize_update(update)
    }

    /// Bring the analysis up to date with the text and the catalog and project it (`Analyze()`)
    pub fn analyze(&mut self) -> EditorUpdateT {
        let mut update = self.make_update();
        if self.analyze_into(&mut update) {
            let catalog_version = self.catalog_revision();
            let cursor_outdated = update.analysis_updated
                || self.script.cursor_offset().is_none()
                || self.cursor_text_version != self.text_version()
                || self.cursor_catalog_revision != catalog_version;
            if self.primary_selection.is_some() && cursor_outdated {
                self.place_cursor_at_selection();
                self.cursor_text_version = self.text_version();
                self.cursor_catalog_revision = catalog_version;
            }
            if update.analysis_updated {
                self.state_revision += 1;
            }
        }
        update.text_version = self.text_version();
        update.state_revision = self.state_revision;
        update.catalog_revision = self.catalog_revision();
        self.finalize_update(update)
    }

    /// Add the projections of the analysis to an update (`FinalizeUpdate`)
    fn finalize_update(&self, mut update: EditorUpdateT) -> EditorUpdateT {
        self.project_editor_state(&mut update);
        update
    }

    /// Project the current analysis (`ProjectEditorState`)
    fn project_editor_state(&self, update: &mut EditorUpdateT) {
        if !update.analysis_available {
            return;
        }
        let (Some(parsed), Some(analyzed)) = (self.script.parsed.as_ref(), self.script.analyzed.as_ref()) else {
            return;
        };
        if !Arc::ptr_eq(&analyzed.parsed, parsed) {
            return;
        }
        let scanned = &parsed.scanned;
        let resolve = |span: SymbolSpan| resolve_text_span(&scanned.text, &scanned.symbols, span);
        let mut projector = self.projector(Some(&scanned.text));

        // Diagnostics
        let mut diagnostics = Vec::new();
        let mut add_diagnostic = |projector: &mut Projector,
                                  source: EditorDiagnosticSource,
                                  severity: EditorDiagnosticSeverity,
                                  message: &str,
                                  span: TextSpan| {
            let Some(text_span) = projector.span(span) else {
                return;
            };
            let mut diagnostic = EditorDiagnosticT::default();
            diagnostic.source = source;
            diagnostic.severity = severity;
            diagnostic.message = non_empty_string(message);
            diagnostic.text_span = Some(text_span);
            diagnostics.push(diagnostic);
        };
        for error in &scanned.errors {
            add_diagnostic(
                &mut projector,
                EditorDiagnosticSource::SCANNER,
                EditorDiagnosticSeverity::ERROR,
                &error.message,
                error.location,
            );
        }
        for error in &parsed.errors {
            add_diagnostic(
                &mut projector,
                EditorDiagnosticSource::PARSER,
                EditorDiagnosticSeverity::ERROR,
                &error.message,
                resolve(error.location),
            );
        }
        for error in &analyzed.errors {
            let Some(span) = error.text_span else {
                continue;
            };
            let severity = if error.severity == AnalyzerErrorSeverity::WARNING {
                EditorDiagnosticSeverity::WARNING
            } else {
                EditorDiagnosticSeverity::ERROR
            };
            add_diagnostic(&mut projector, EditorDiagnosticSource::ANALYZER, severity, &error.message, span);
        }
        diagnostics.sort_by_key(|d| d.text_span.as_ref().map_or(0, |s| s.offset));
        update.diagnostics = non_empty(diagnostics);

        // Syntax spans: the tokens and the comments
        let tokens = pack_tokens(parsed);
        let offsets = tokens.token_offsets.as_deref().unwrap_or(&[]);
        let lengths = tokens.token_lengths.as_deref().unwrap_or(&[]);
        let types = tokens.token_types.as_deref().unwrap_or(&[]);
        let mut syntax_spans = Vec::with_capacity(offsets.len() + scanned.comments.len());
        let mut add_syntax = |projector: &mut Projector, token_type: ScannerTokenType, span: TextSpan| {
            if let Some(text_span) = projector.span(span) {
                let mut s = EditorSyntaxSpanT::default();
                s.token_type = token_type;
                s.text_span = Some(text_span);
                syntax_spans.push(s);
            }
        };
        for ((&offset, &length), &token_type) in offsets.iter().zip(lengths).zip(types) {
            add_syntax(&mut projector, token_type, TextSpan::new(offset, length));
        }
        for &comment in &scanned.comments {
            add_syntax(&mut projector, ScannerTokenType::COMMENT, comment);
        }
        syntax_spans.sort_by_key(|s| s.text_span.as_ref().map_or(0, |s| s.offset));
        update.syntax_spans = non_empty(syntax_spans);

        // Semantic spans: table, column and function references
        let mut semantic_spans = Vec::new();
        for (reference_id, reference) in analyzed.table_references.iter().enumerate() {
            let Some(location) = reference.location else {
                continue;
            };
            let Some(text_span) = projector.span(resolve(location)) else {
                continue;
            };
            let mut span = EditorSemanticSpanT::default();
            span.kind = EditorSemanticReferenceKind::TABLE;
            span.reference_id = reference_id as u32;
            span.text_span = Some(text_span);
            if let Some(resolved) = resolved_table_ids(reference) {
                span.resolution = EditorSemanticResolution::RESOLVED;
                span.catalog_database_id = resolved.database_id;
                span.catalog_schema_id = resolved.schema_id;
                span.catalog_table_id = resolved.table_id;
                span.referenced_catalog_version = resolved.catalog_version;
            }
            semantic_spans.push(span);
        }
        for (expression_id, expression) in analyzed.expressions.iter().enumerate() {
            let is_function = match &expression.inner {
                ExpressionInner::ColumnRef(_) => false,
                ExpressionInner::FunctionCall(_) => true,
                _ => continue,
            };
            let Some(mut location) = expression.location else {
                continue;
            };
            if is_function && (expression.ast_node_id as usize) < parsed.nodes.len() {
                let node = &parsed.nodes[expression.ast_node_id as usize];
                if node.children_count() > 0 {
                    let begin = node.children_begin_or_value() as usize;
                    let children = &parsed.nodes[begin..begin + node.children_count() as usize];
                    let [name] = attrs!(children, [AttributeKey::SQL_FUNCTION_NAME]);
                    if let Some(name) = name {
                        location = *name.symbol_span();
                    }
                }
            }
            let Some(text_span) = projector.span(resolve(location)) else {
                continue;
            };
            let mut span = EditorSemanticSpanT::default();
            span.kind =
                if is_function { EditorSemanticReferenceKind::FUNCTION } else { EditorSemanticReferenceKind::COLUMN };
            span.reference_id = expression_id as u32;
            span.text_span = Some(text_span);
            if let Some((table, column_id)) = resolved_column_ids(expression) {
                span.resolution = EditorSemanticResolution::RESOLVED;
                span.catalog_database_id = table.database_id;
                span.catalog_schema_id = table.schema_id;
                span.catalog_table_id = table.table_id;
                span.catalog_column_id = column_id;
                span.referenced_catalog_version = table.catalog_version;
            }
            semantic_spans.push(span);
        }
        semantic_spans.sort_by_key(|s| s.text_span.as_ref().map_or(0, |s| s.offset));
        update.semantic_spans = non_empty(semantic_spans);

        // The collapsed primary cursor
        let collapsed = self.primary_selection.as_ref().is_some_and(|s| s.anchor == s.head);
        if collapsed && self.script.cursor_offset().is_some() {
            self.project_cursor(update, analyzed, &mut projector);
        }

        // Annotations
        let mut annotations = EditorScriptAnnotationsT::default();
        let mut table_definitions: Vec<EditorTableDefinitionT> = analyzed
            .entry
            .table_declarations
            .iter()
            .map(|table| {
                let mut definition = EditorTableDefinitionT::default();
                definition.name = non_empty_string(format_table_name(&table.table_name));
                definition.statement_id = table.ast_statement_id.unwrap_or(u32::MAX);
                definition
            })
            .collect();
        table_definitions.sort_by(|a, b| (a.name.as_deref(), a.statement_id).cmp(&(b.name.as_deref(), b.statement_id)));
        annotations.table_definitions = non_empty(table_definitions);
        let mut referenced: Vec<String> = analyzed
            .table_references
            .iter()
            .filter_map(|r| r.inner.as_ref().map(|rel| rel.table_name.table_name.text.to_string()))
            .collect();
        referenced.sort_unstable();
        referenced.dedup();
        annotations.referenced_table_names = non_empty(referenced);
        annotations.has_visualization_compilation = !analyzed.visualization_specs.is_empty();
        let mut statements = Vec::with_capacity(parsed.statements.len());
        let mut statement_descriptions = Vec::new();
        for (statement_id, (statement, metadata)) in
            parsed.statements.iter().zip(parsed.associate_descriptions()).enumerate()
        {
            let Some(text_span) = projector.span(metadata.statement_span) else {
                continue;
            };
            let mut s = EditorStatementT::default();
            s.statement_id = statement_id as u32;
            s.statement_type = statement.statement_type;
            s.text_span = Some(text_span.clone());
            statements.push(s);
            if metadata.description_count == 0 {
                continue;
            }
            let mut description = EditorStatementDescriptionT::default();
            description.statement_id = statement_id as u32;
            description.statement_type = statement.statement_type;
            description.text_span = Some(text_span);
            statement_descriptions.push(description);
        }
        annotations.statements = non_empty(statements);
        annotations.statement_descriptions = non_empty(statement_descriptions);
        update.script_annotations = Some(Box::new(annotations));

        // Statistics
        let timings = self.script.timings();
        let memory = self.script.memory_statistics();
        let latest = &memory.latest_script;
        let mut statistics = EditorProcessingStatisticsT::default();
        statistics.scanner_last_elapsed_ns = timings.scanner_last_elapsed;
        statistics.parser_last_elapsed_ns = timings.parser_last_elapsed;
        statistics.analyzer_last_elapsed_ns = timings.analyzer_last_elapsed;
        statistics.rope_bytes = memory.rope_bytes as u64;
        statistics.scanner_input_bytes = latest.scanner_input_bytes as u64;
        statistics.scanner_symbol_bytes = latest.scanner_symbol_bytes as u64;
        statistics.scanner_name_dictionary_bytes = latest.scanner_name_dictionary_bytes as u64;
        statistics.parser_ast_bytes = latest.parser_ast_bytes as u64;
        statistics.analyzer_description_bytes = latest.analyzer_description_bytes as u64;
        statistics.analyzer_name_index_size = latest.analyzer_name_index_size as u64;
        statistics.analyzer_name_index_bytes = latest.analyzer_name_index_bytes as u64;
        update.processing_statistics = Some(Box::new(statistics));
    }

    /// Project the state and the semantic context of the collapsed primary cursor
    fn project_cursor(&self, update: &mut EditorUpdateT, analyzed: &AnalyzedScript, projector: &mut Projector) {
        let catalog = self.catalog.borrow();
        let Some(cursor) = self.script.cursor(&catalog) else {
            return;
        };
        if let Some(text_offset) = projector.offset(cursor.text_offset as u64) {
            let mut state = EditorCursorStateT::default();
            state.text_offset = text_offset;
            match &cursor.scanner_location {
                Some(location) => {
                    state.scanner_relative_position = location.current.relative_pos;
                    state.scanner_symbol_completable = is_symbol_kind_completable(location.current.symbol.kind);
                }
                None => {
                    state.scanner_relative_position = RelativeSymbolPosition::AFTER_SYMBOL;
                    state.scanner_symbol_completable = false;
                }
            }
            update.primary_cursor_state = Some(Box::new(state));
        }

        let mut context = EditorCursorSemanticContextT::default();
        let mut target: Option<(ResolvedTableIds, Option<u32>)> = None;
        match cursor.context {
            CursorContext::TableRef { table_reference_id, .. } => {
                context.kind = EditorCursorSemanticKind::TABLE_REFERENCE;
                context.reference_id = table_reference_id;
                if let Some(reference) = analyzed.table_references.get(table_reference_id as usize) {
                    target = resolved_table_ids(reference).map(|t| (t, None));
                }
            }
            CursorContext::ColumnRef { expression_id } => {
                context.kind = EditorCursorSemanticKind::COLUMN_REFERENCE;
                context.reference_id = expression_id;
                if let Some(expression) = analyzed.expressions.get(expression_id as usize) {
                    target = resolved_column_ids(expression).map(|(t, c)| (t, Some(c)));
                }
            }
            CursorContext::None => {}
        }
        if let Some((table, column)) = target {
            context.resolved = true;
            context.catalog_database_id = table.database_id;
            context.catalog_schema_id = table.schema_id;
            context.catalog_table_id = table.table_id;
            context.catalog_column_id = column.unwrap_or(0);
            context.referenced_catalog_version = table.catalog_version;
            let related_tables: Vec<u32> = analyzed
                .table_references
                .iter()
                .enumerate()
                .filter(|(_, r)| resolved_table_ids(r).is_some_and(|t| t.same_table(&table)))
                .map(|(i, _)| i as u32)
                .collect();
            let related_columns: Vec<u32> = analyzed
                .expressions
                .iter()
                .enumerate()
                .filter(|(_, e)| resolved_column_ids(e).is_some_and(|(t, _)| t.same_table(&table)))
                .map(|(i, _)| i as u32)
                .collect();
            context.related_table_reference_ids = non_empty(related_tables);
            context.related_column_reference_ids = non_empty(related_columns);
        }
        if context.kind != EditorCursorSemanticKind::NONE {
            update.primary_cursor_context = Some(Box::new(context));
        }
    }

    /// Complete at the cursor (`PackCompletion`). With UTF-16 offsets, the completion goes through
    /// the object API like in C++, so empty strings and vectors are left out.
    pub fn complete(&self, limit: usize, keyword_case: KeywordCase) -> Result<CompletionT> {
        let catalog = self.catalog.borrow();
        let cursor = self.script.cursor(&catalog).ok_or_else(|| Error::status(StatusCode::COMPLETION_MISSES_CURSOR))?;
        let completion = Script::complete_at_cursor(&cursor, limit)?;
        let mut packed = pack_completion(&completion, keyword_case == KeywordCase::UPPER);
        if self.offset_unit == EditorOffsetUnit::UTF8_BYTES {
            return Ok(packed);
        }
        let mut projector = self.projector(None);
        packed.cursor_offset = Self::project_byte_offset(&mut projector, packed.cursor_offset as u64)? as u32;
        let project_symbol_span = |projector: &mut Projector, span: &mut Option<SymbolSpanT>| {
            if let Some(s) = span.as_ref() {
                *span = projector.span(TextSpan::new(s.offset, s.length)).map(|p| {
                    let mut out = SymbolSpanT::default();
                    out.offset = p.offset as u32;
                    out.length = p.length as u32;
                    out
                });
            }
        };
        let mut candidates = packed.candidates.take().unwrap_or_default();
        for candidate in &mut candidates {
            project_symbol_span(&mut projector, &mut candidate.target_location);
            project_symbol_span(&mut projector, &mut candidate.target_location_qualified);
            let completion_text = candidate.completion_text.as_deref().unwrap_or("");
            let cursor = candidate.completion_cursor_offset as usize;
            if cursor > completion_text.len() || !completion_text.is_char_boundary(cursor) {
                return Err(Error::invalid_argument("completion cursor is not on a UTF-8 codepoint boundary"));
            }
            candidate.completion_cursor_offset = completion_text[..cursor].encode_utf16().count() as u32;
            // The object API round trip
            candidate.display_text = candidate.display_text.take().filter(|s| !s.is_empty());
            candidate.completion_text = candidate.completion_text.take().filter(|s| !s.is_empty());
            candidate.keyword_continuation = candidate.keyword_continuation.take().filter(|s| !s.is_empty());
            let mut objects = candidate.catalog_objects.take().unwrap_or_default();
            for object in &mut objects {
                object.qualified_name = object.qualified_name.take().filter(|n| !n.is_empty());
            }
            candidate.catalog_objects = non_empty(objects);
        }
        packed.candidates = non_empty(candidates);
        Ok(packed)
    }

    /// Compile the current text into executable statements (`CompileQuery`)
    pub fn compile_query(
        &mut self,
        config: &FormattingConfigT,
        allow_extensions: bool,
        parse_if_outdated: bool,
    ) -> ScriptCompilationResultT {
        let catalog = self.catalog.borrow();
        compile(&mut self.script, &catalog, config, CompilationOptions { allow_extensions, parse_if_outdated })
    }

    /// Format the script into a new script with an entry id of `catalog`, or of the session catalog
    /// (`Format`). The formatter can cut a UTF-8 character when it wraps comments; the C++ rope then
    /// rejects the text after the entry id was allocated, and so does this.
    pub fn format(
        &mut self,
        config: &FormattingConfigT,
        parse_if_outdated: bool,
        catalog: Option<&Catalog>,
    ) -> Result<Script> {
        let text = self.script.format_bytes(config, parse_if_outdated)?;
        let mut result = match catalog {
            Some(catalog) => Script::new(catalog),
            None => Script::new(&self.catalog.borrow()),
        };
        let text = String::from_utf8(text)
            .map_err(|_| Error::invalid_argument("invalid UTF-8 while computing rope text statistics"))?;
        result.replace_text(&text);
        Ok(result)
    }

    /// Rewrite the dashboard clause of the terminal VISUALIZE statement (`RewriteDashboard`)
    pub fn rewrite_dashboard(
        &mut self,
        row: Option<i32>,
        column: Option<i32>,
        width: i32,
        height: i32,
        parse_if_outdated: bool,
    ) -> Result<String> {
        self.script.rewrite_dashboard(row, column, width, height, parse_if_outdated)
    }

    /// Can formatting represent every node? (`IsFullyFormattable`)
    pub fn is_fully_formattable(&mut self, config: &FormattingConfigT, parse_if_outdated: bool) -> Result<bool> {
        self.script.is_fully_formattable(config, parse_if_outdated)
    }

    /// The statement diff from the session script to a target script (`PackDiff`). Like C++, the
    /// source spans are projected into the current text even if the parsed script is outdated.
    pub fn diff(&self, target: &Script) -> Result<ScriptDiffT> {
        let (Some(source_parsed), Some(target_parsed)) = (self.script.parsed.as_ref(), target.parsed.as_ref()) else {
            return Err(Error::status(StatusCode::SCRIPT_NOT_PARSED));
        };
        let mut diff = ScriptDiff::new(source_parsed, target_parsed).pack();
        if self.offset_unit == EditorOffsetUnit::UTF8_BYTES {
            return Ok(diff);
        }
        let mut source = self.projector(None);
        let mut target_projector = Projector::Utf16(Utf16Projector::new(None, target.text()));
        let mut ops = diff.ops.take().unwrap_or_default();
        for op in &mut ops {
            if let Some(span) = op.source_span.as_mut() {
                let begin = Self::project_byte_offset(&mut source, span.offset as u64)?;
                let end = Self::project_byte_offset(&mut source, span.offset as u64 + span.length as u64)?;
                span.offset = begin as u32;
                span.length = end.wrapping_sub(begin) as u32;
            }
            let mut project_target = |span: &mut TextSpanT, message: &str| -> Result<()> {
                let begin = target_projector.offset(span.offset as u64);
                let end = target_projector.offset(span.offset as u64 + span.length as u64);
                let (Some(begin), Some(end)) = (begin, end) else {
                    return Err(Error::invalid_argument(message));
                };
                span.offset = begin as u32;
                span.length = end.wrapping_sub(begin) as u32;
                Ok(())
            };
            if let Some(span) = op.target_span.as_mut() {
                project_target(span, "diff span is not on a UTF-8 codepoint boundary")?;
            }
            for change in op.target_changes.iter_mut().flatten() {
                project_target(change, "diff change is not on a UTF-8 codepoint boundary")?;
            }
        }
        diff.ops = non_empty(ops);
        Ok(diff)
    }

    /// Publish the analyzed script into the catalog (`LoadIntoCatalog`)
    pub fn load_into_catalog(&mut self, rank: Rank) -> Result<()> {
        let analyzed =
            self.script.analyzed.clone().ok_or_else(|| Error::status(StatusCode::CATALOG_SCRIPT_NOT_ANALYZED))?;
        let mut catalog = self.catalog.borrow_mut();
        catalog.load_script(analyzed, rank)?;
        // Publishing bumps the catalog version, the analysis needs a refresh against that version
        // before the planner can use it
        self.analyzed_catalog_revision = catalog.version() as u64;
        self.cursor_catalog_revision = catalog.version() as u64;
        Ok(())
    }

    /// Remove the script from the catalog (`DropFromCatalog`)
    pub fn drop_from_catalog(&mut self) {
        self.catalog.borrow_mut().drop_script(self.catalog_entry_id());
    }
}
