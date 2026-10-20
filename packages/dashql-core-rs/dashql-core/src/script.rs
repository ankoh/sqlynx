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
use dashql_buffers::status::StatusCode;
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
        let text = self.text.to_string();
        self.scanned = Some(Arc::new(scan(&text, self.text_version, self.catalog_entry_id)));
    }

    /// Parse the script unconditionally, scanning first if the scan is missing or outdated
    pub fn parse(&mut self) {
        if self.scanned.as_ref().is_none_or(|s| s.text_version != self.text_version) {
            self.scan();
        }
        // The parser registers keyword names and the replacements of obfuscated literals in a copy
        // of the scanned script (in place if it is not shared), which becomes the scanned script
        let scanned = self.scanned.take().unwrap();
        let parsed = parse(scanned);
        self.scanned = Some(parsed.scanned.clone());
        self.parsed = Some(Arc::new(parsed));
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

    /// Analyze the script (`Catalog::AnalyzeScript`)
    pub fn analyze(&mut self, catalog: &Catalog, parse_if_outdated: bool) -> Result<()> {
        if parse_if_outdated {
            self.parse_if_outdated();
        }
        let Some(parsed) = self.parsed.clone() else {
            return Err(Error::status(StatusCode::SCRIPT_NOT_PARSED));
        };
        self.cursor_offset = None;
        self.analyzed = Some(Arc::new(analyze(parsed, catalog)?));
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
        if parse_if_outdated && self.parsed.as_ref().is_none_or(|p| p.scanned.text_version != self.text_version) {
            self.parse();
        }
        let parsed = self.parsed.as_ref().ok_or_else(|| Error::status(StatusCode::SCRIPT_NOT_PARSED))?;
        crate::signature::compute_signature(parsed)
    }
}
