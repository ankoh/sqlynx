//! A script: the text of an editor or a catalog entry and its latest scanned, parsed and analyzed
//! versions (`Script` in `src/script.cc`).
//!
//! The text is a rope indexed by Unicode code points, like the C++ rope, so that edits in the middle
//! of large scripts stay logarithmic.
//!
//! Unlike the C++ script, a script does not hold a reference to its catalog. Operations that read
//! the catalog take it as an argument, and dropping a script does not modify the catalog: the owner
//! drops the script from the catalog explicitly (`Catalog::drop_script`).

use crate::analyzer::{analyze, AnalyzedScript};
use crate::catalog::{Catalog, CatalogEntryId};
use crate::completion::Completion;
use crate::cursor::{ScriptCursor, ScriptView};
use crate::error::{Error, Result};
use crate::formatter::Formatter;
use dashql_buffers::formatting::FormattingConfigT;
use dashql_buffers::parser::{AttributeKey, Node, NodeType, StatementType};
use dashql_buffers::statistics::{ScriptMemoryStatisticsT, ScriptProcessingTimingsT, ScriptStatisticsT};
use dashql_buffers::status::StatusCode;
use dashql_grammar::attrs;
use dashql_grammar::parser::context::resolve_text_span;
use dashql_grammar::parser::{parse, ParsedScript};
use dashql_grammar::scanner::{scan, ScannedScript};
use dashql_grammar::span::TextSpan;
use ropey::Rope;
use std::sync::Arc;

/// The version of the script text, bumped by every edit
pub type TextVersion = u64;

pub struct Script {
    /// The catalog entry id
    catalog_entry_id: CatalogEntryId,
    /// The text
    text: Rope,
    /// The text version
    text_version: TextVersion,
    /// The latest scanned script
    pub scanned: Option<Arc<ScannedScript>>,
    /// The latest parsed script
    pub parsed: Option<Arc<ParsedScript>>,
    /// The latest analyzed script
    pub analyzed: Option<Arc<AnalyzedScript>>,
    /// The text offset of the cursor, reset by every analysis
    cursor_offset: Option<usize>,
    /// The durations of the last scan, parse and analysis
    timings: ScriptProcessingTimingsT,
}

/// A stopwatch for the processing timings. `std::time::Instant` panics on wasm32-unknown-unknown,
/// where the timings stay 0 until the host provides a clock.
struct Stopwatch {
    #[cfg(not(target_arch = "wasm32"))]
    start: std::time::Instant,
}

impl Stopwatch {
    fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            start: std::time::Instant::now(),
        }
    }

    /// The elapsed nanoseconds
    fn elapsed_ns(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed().as_nanos() as f64
        }
        #[cfg(target_arch = "wasm32")]
        {
            0.0
        }
    }
}

impl Script {
    /// Create a script with a new entry id of the catalog
    pub fn new(catalog: &Catalog) -> Self {
        Self::with_entry_id(catalog.allocate_entry_id())
    }

    pub fn with_entry_id(catalog_entry_id: CatalogEntryId) -> Self {
        Self {
            catalog_entry_id,
            text: Rope::new(),
            text_version: 0,
            scanned: None,
            parsed: None,
            analyzed: None,
            cursor_offset: None,
            timings: ScriptProcessingTimingsT::default(),
        }
    }

    pub fn catalog_entry_id(&self) -> CatalogEntryId {
        self.catalog_entry_id
    }

    pub fn text_version(&self) -> TextVersion {
        self.text_version
    }

    pub fn text(&self) -> &Rope {
        &self.text
    }

    /// Overwrite the text version. Only for tests that need versions beyond 32 bits, like the C++
    /// tests that write the public `text_version`.
    #[doc(hidden)]
    pub fn set_text_version(&mut self, text_version: TextVersion) {
        self.text_version = text_version;
    }

    /// Replace the text with an edited rope and bump the version. Unlike `replace_text`, the texts
    /// are not compared: the caller knows that the text changed.
    pub fn set_text(&mut self, text: Rope) {
        self.text = text;
        self.text_version += 1;
    }

    /// Insert a code point at a code point offset (`InsertCharAt`)
    pub fn insert_char_at(&mut self, char_idx: usize, unicode: u32) {
        let c = char::from_u32(unicode).unwrap_or(char::REPLACEMENT_CHARACTER);
        let mut buffer = [0u8; 4];
        self.insert_text_at(char_idx, c.encode_utf8(&mut buffer));
    }

    /// Insert text at a code point offset (`InsertTextAt`). Offsets past the end append.
    pub fn insert_text_at(&mut self, char_idx: usize, text: &str) {
        if text.is_empty() {
            return;
        }
        let char_idx = char_idx.min(self.text.len_chars());
        self.text.insert(char_idx, text);
        self.text_version += 1;
    }

    /// Erase a code point range (`EraseTextRange`)
    pub fn erase_text_range(&mut self, char_idx: usize, count: usize) {
        let len = self.text.len_chars();
        if count == 0 || char_idx >= len {
            return;
        }
        let end = (char_idx + count).min(len);
        self.text.remove(char_idx..end);
        self.text_version += 1;
    }

    /// Replace the text (`ReplaceText`), a no-op if the text is unchanged
    pub fn replace_text(&mut self, text: &str) {
        if text.len() == self.text.len_bytes() && self.text == text {
            return;
        }
        self.text = Rope::from_str(text);
        self.text_version += 1;
    }

    /// The text as a string
    pub fn to_text(&self) -> String {
        self.text.to_string()
    }

    /// The text of a byte span (`ToString(TextSpan)`), empty if the span begins past the end. The span
    /// is clamped to the text; characters cut by the span bounds become replacement characters.
    pub fn to_text_span(&self, span: TextSpan) -> String {
        let len = self.text.len_bytes();
        let begin = span.offset as usize;
        if begin >= len {
            return String::new();
        }
        let end = (begin + span.length as usize).min(len);
        let bytes: Vec<u8> = self.text.bytes_at(begin).take(end - begin).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Scan the script unconditionally
    pub fn scan(&mut self) {
        let watch = Stopwatch::start();
        let text = self.text.to_string();
        self.scanned = Some(Arc::new(scan(&text, self.text_version, self.catalog_entry_id)));
        self.timings.scanner_last_elapsed = watch.elapsed_ns();
    }

    /// Parse the script unconditionally, scanning first if the scan is missing or outdated
    pub fn parse(&mut self) {
        if self.scanned.as_ref().is_none_or(|s| s.text_version != self.text_version) {
            self.scan();
        }
        // The parser registers keyword names and the replacements of obfuscated literals in a copy
        // of the scanned script (in place if it is not shared), which becomes the scanned script
        let watch = Stopwatch::start();
        let scanned = self.scanned.take().unwrap();
        let parsed = parse(scanned);
        self.scanned = Some(parsed.scanned.clone());
        self.parsed = Some(Arc::new(parsed));
        self.timings.parser_last_elapsed = watch.elapsed_ns();
    }

    /// Scan and parse if the text changed
    fn parse_if_outdated(&mut self) {
        if self.scanned.as_ref().is_none_or(|s| s.text_version != self.text_version) {
            self.scan();
        }
        let current = match (&self.parsed, &self.scanned) {
            (Some(p), Some(s)) => Arc::ptr_eq(&p.scanned, s),
            _ => false,
        };
        if !current {
            self.parse();
        }
    }

    /// Parse if the parsed script is missing or was parsed from another text version (the check of
    /// `GetStatementText`, `RewriteDashboard`, `ComputeSignature` and the compiler)
    fn parse_if_text_outdated(&mut self) {
        if self.parsed.as_ref().is_none_or(|p| p.scanned.text_version != self.text_version) {
            self.parse();
        }
    }

    /// Analyze the script (`Catalog::AnalyzeScript`)
    pub fn analyze(&mut self, catalog: &Catalog, parse_if_outdated: bool) -> Result<()> {
        if parse_if_outdated {
            self.parse_if_outdated();
        }
        let Some(parsed) = self.parsed.clone() else {
            return Err(Error::status(StatusCode::SCRIPT_NOT_PARSED));
        };
        self.cursor_offset = None;
        let watch = Stopwatch::start();
        self.analyzed = Some(Arc::new(analyze(parsed, catalog)?));
        self.timings.analyzer_last_elapsed = watch.elapsed_ns();
        Ok(())
    }

    /// The parts of the script that a cursor reads
    pub fn view<'a>(&'a self, catalog: &'a Catalog) -> ScriptView<'a> {
        ScriptView {
            scanned: self.scanned.as_ref(),
            parsed: self.parsed.as_ref(),
            analyzed: self.analyzed.as_ref(),
            catalog,
        }
    }

    /// Move the cursor to a text offset (`MoveCursor`)
    pub fn move_cursor<'a>(&'a mut self, catalog: &'a Catalog, text_offset: usize) -> ScriptCursor<'a> {
        self.cursor_offset = Some(text_offset);
        ScriptCursor::place(self.view(catalog), text_offset)
    }

    /// The text offset of the cursor, if it was moved since the last analysis
    pub fn cursor_offset(&self) -> Option<usize> {
        self.cursor_offset
    }

    /// Move or reset the cursor without placing it (`MoveCursor`, `cursor.reset()`). The cursor is
    /// placed when it is read with `cursor`.
    pub fn set_cursor_offset(&mut self, text_offset: Option<usize>) {
        self.cursor_offset = text_offset;
    }

    /// The cursor, if it was moved since the last analysis
    pub fn cursor<'a>(&'a self, catalog: &'a Catalog) -> Option<ScriptCursor<'a>> {
        self.cursor_offset.map(|offset| ScriptCursor::place(self.view(catalog), offset))
    }

    /// Complete at the cursor (`CompleteAtCursor`)
    pub fn complete_at_cursor<'c, 'a>(cursor: &'c ScriptCursor<'a>, limit: usize) -> Result<Completion<'c, 'a>> {
        if cursor.scanner_location.is_none() {
            return Err(Error::status(StatusCode::COMPLETION_MISSES_SCANNER_TOKEN));
        }
        Ok(Completion::compute(cursor, limit))
    }

    /// Compute the signature (`ComputeSignature`)
    pub fn compute_signature(&mut self, parse_if_outdated: bool) -> Result<String> {
        if parse_if_outdated {
            self.parse_if_text_outdated();
        }
        let parsed = self.parsed.as_ref().ok_or_else(|| Error::status(StatusCode::SCRIPT_NOT_PARSED))?;
        crate::signature::compute_signature(parsed)
    }

    /// The text of the first statement without its separator or surrounding trivia
    /// (`GetStatementText`)
    pub fn statement_text(&mut self, parse_if_outdated: bool) -> Result<String> {
        if parse_if_outdated {
            self.parse_if_text_outdated();
        }
        let parsed = self.parsed.as_ref().ok_or_else(|| Error::status(StatusCode::SCRIPT_NOT_PARSED))?;
        if parsed.statements.is_empty() {
            return Ok(String::new());
        }
        let span = parsed.associate_descriptions()[0].statement_span;
        Ok(self.to_text_span(span))
    }

    /// Rewrite the dashboard clause of the terminal VISUALIZE statement (`RewriteDashboard`).
    ///
    /// Like C++, the spans of the parsed script are applied to the current text, which differs from
    /// the parsed text if the script was edited and `parse_if_outdated` is false. Bytes are spliced,
    /// so a span that cuts a character leaves replacement characters.
    pub fn rewrite_dashboard(
        &mut self,
        mut row: Option<i32>,
        mut column: Option<i32>,
        width: i32,
        height: i32,
        parse_if_outdated: bool,
    ) -> Result<String> {
        if parse_if_outdated {
            self.parse_if_text_outdated();
        }
        let not_parsed = || Error::status(StatusCode::SCRIPT_NOT_PARSED);
        let parsed = self.parsed.as_ref().ok_or_else(not_parsed)?;
        if !parsed.errors.is_empty() {
            return Err(not_parsed());
        }
        let statement = parsed.statements.last().ok_or_else(not_parsed)?;
        if statement.statement_type != StatementType::VIS_VISUALISE {
            return Err(not_parsed());
        }
        let children = |node: &Node| {
            let begin = node.children_begin_or_value() as usize;
            &parsed.nodes[begin..begin + node.children_count() as usize]
        };
        let root = &parsed.nodes[statement.root as usize];
        let [spec] = attrs!(children(root), [AttributeKey::VIS_VISUALISE_SPEC]);
        let spec = spec.ok_or_else(not_parsed)?;

        let width = width.clamp(1, 12);
        let height = height.max(1);
        if row.is_some_and(|r| r < 0) {
            row = None;
        }
        if let Some(c) = column.as_mut() {
            *c = (*c).clamp(0, 12 - width);
        }
        let mut fields = Vec::with_capacity(4);
        if let Some(row) = row {
            fields.push(format!("row => {row}"));
        }
        if let Some(column) = column {
            fields.push(format!("column => {column}"));
        }
        fields.push(format!("width => {width}"));
        fields.push(format!("height => {height}"));
        let replacement = format!("dashboard => ({})", fields.join(", "));

        let scanned = &parsed.scanned;
        let resolve = |node: &Node| resolve_text_span(&scanned.text, &scanned.symbols, *node.symbol_span());
        let mut source = self.text.to_string().into_bytes();
        let spec_children = children(spec);
        let [dashboard] = attrs!(spec_children, [AttributeKey::VIS_SPEC_DASHBOARD]);
        if let Some(dashboard) = dashboard {
            let span = resolve(dashboard);
            let begin = span.offset as usize;
            if begin > source.len() {
                // std::string::replace throws std::out_of_range
                return Err(Error::invalid_argument("basic_string::replace: position out of range"));
            }
            let end = (begin + span.length as usize).min(source.len());
            source.splice(begin..end, replacement.bytes());
            return Ok(String::from_utf8_lossy(&source).into_owned());
        }
        let insert_at = resolve(root).end() as usize;
        if insert_at == 0 || source.get(insert_at - 1) != Some(&b')') {
            return Err(not_parsed());
        }
        let insert_at = insert_at - 1;
        let has_spec_fields = spec_children.iter().any(|child| child.node_type() != NodeType::NONE);
        let insert = if has_spec_fields { format!(", {replacement}") } else { replacement };
        source.splice(insert_at..insert_at, insert.bytes());
        Ok(String::from_utf8_lossy(&source).into_owned())
    }

    /// Scan and parse like `Format` and `GetUnformattableNodes`, then return the parsed script
    fn parsed_for_formatting(&mut self, parse_if_outdated: bool) -> Result<&Arc<ParsedScript>> {
        if parse_if_outdated {
            self.parse_if_outdated();
        }
        self.parsed.as_ref().ok_or_else(|| Error::status(StatusCode::SCRIPT_NOT_PARSED))
    }

    /// Format the script (`Format`)
    pub fn format(&mut self, config: &FormattingConfigT, parse_if_outdated: bool) -> Result<String> {
        let parsed = self.parsed_for_formatting(parse_if_outdated)?;
        Ok(Formatter::new(parsed).format(config))
    }

    /// Format the script and return the raw bytes, which may contain partial UTF-8 sequences where
    /// comments were wrapped (see `Formatter::format_bytes`)
    pub fn format_bytes(&mut self, config: &FormattingConfigT, parse_if_outdated: bool) -> Result<Vec<u8>> {
        let parsed = self.parsed_for_formatting(parse_if_outdated)?;
        Ok(Formatter::new(parsed).format_bytes(config))
    }

    /// The nodes that formatting could not represent (`GetUnformattableNodes`)
    pub fn unformattable_nodes(&mut self, config: &FormattingConfigT, parse_if_outdated: bool) -> Result<Vec<u32>> {
        let parsed = self.parsed_for_formatting(parse_if_outdated)?;
        let mut formatter = Formatter::new(parsed);
        formatter.format_bytes(config);
        Ok(formatter.unformattable_nodes())
    }

    /// Can formatting represent every node? (`IsFullyFormattable`)
    pub fn is_fully_formattable(&mut self, config: &FormattingConfigT, parse_if_outdated: bool) -> Result<bool> {
        Ok(self.unformattable_nodes(config, parse_if_outdated)?.is_empty())
    }

    /// The durations of the last scan, parse and analysis in nanoseconds
    pub fn timings(&self) -> &ScriptProcessingTimingsT {
        &self.timings
    }

    /// The memory statistics (`GetMemoryStatistics`).
    ///
    /// They describe the latest analyzed script and the parsed and scanned script it was analyzed
    /// from, and are 0 except for the rope size before the first analysis. The rope, input, AST and
    /// name index sizes follow the C++ definitions exactly. The others measure the Rust data
    /// structures:
    /// - `scanner_symbol_bytes` is the size of the symbol vector. C++ adds the size of one bison
    ///   symbol to the symbol count, which is not a byte size.
    /// - `scanner_name_dictionary_bytes` counts the registered names and their texts (C++: the name
    ///   pool and the chunked registry).
    /// - `analyzer_description_bytes` multiplies the same element counts with the sizes of the Rust
    ///   types.
    /// - `analyzer_name_index_bytes` is the size of the suffix vector (C++: the entry count times the
    ///   average btree bytes per value).
    pub fn memory_statistics(&self) -> ScriptMemoryStatisticsT {
        use std::mem::size_of;
        let mut memory = ScriptMemoryStatisticsT::default();
        memory.rope_bytes = self.text.len_bytes() as u32;
        let Some(analyzed) = self.analyzed.as_ref() else {
            return memory;
        };
        let entry = &analyzed.entry;
        let table_column_bytes: usize = entry
            .table_declarations
            .iter()
            .map(|t| t.table_columns.len() * size_of::<crate::catalog::TableColumn>())
            .sum();
        let description_bytes = entry.database_references.len() * size_of::<crate::catalog::DatabaseReference>()
            + entry.schema_references.len() * size_of::<crate::catalog::SchemaReference>()
            + entry.table_declarations.len() * size_of::<crate::catalog::TableDeclaration>()
            + table_column_bytes
            + analyzed.table_references.len() * size_of::<crate::analyzer::TableReference>()
            + analyzed.expressions.len() * size_of::<crate::analyzer::Expression>()
            + analyzed.function_arguments.len() * size_of::<crate::analyzer::FunctionArgument>()
            + analyzed.name_scopes.len() * size_of::<crate::analyzer::NameScope>();
        let latest = &mut memory.latest_script;
        latest.analyzer_description_bytes = description_bytes as u32;
        if let Some(index) = analyzed.name_search_index.get() {
            latest.analyzer_name_index_size = index.len() as u32;
            latest.analyzer_name_index_bytes = index.byte_size() as u32;
        }
        let parsed = &analyzed.parsed;
        latest.parser_ast_bytes = (parsed.nodes.len() * size_of::<Node>()) as u32;
        let scanned = &parsed.scanned;
        latest.scanner_input_bytes = scanned.text.len() as u32;
        latest.scanner_symbol_bytes = (scanned.symbols.len() * size_of::<dashql_grammar::scanner::Symbol>()) as u32;
        let name_bytes: usize = scanned
            .names
            .iter()
            .map(|n| n.text.len() + size_of::<dashql_grammar::names::RegisteredName>())
            .sum();
        latest.scanner_name_dictionary_bytes = name_bytes as u32;
        memory
    }

    /// The processing statistics (`GetStatistics`)
    pub fn statistics(&self) -> ScriptStatisticsT {
        let mut statistics = ScriptStatisticsT::default();
        statistics.timings = Some(self.timings.clone());
        statistics.memory = Some(self.memory_statistics());
        statistics
    }
}
