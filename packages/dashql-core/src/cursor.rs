//! The script cursor, a port of `src/script_cursor.cc` and the location lookups of `src/script.cc`
//! (`ScannedScript::FindSymbol`, `IsInsideComment`, `ParsedScript::FindNodeAtOffset`,
//! `AnalyzedScript::FollowPathUpwards`).

use crate::analyzer::{AnalyzedScript, ExprId, ScopeId, TableRefId};
use crate::catalog::Catalog;
use dashql_buffers::cursor::RelativeSymbolPosition;
use dashql_buffers::parser::{NodeType, SymbolSpan};
use dashql_parser::names::NameId;
use dashql_parser::parser::context::resolve_text_span;
use dashql_parser::parser::ParsedScript;
use dashql_parser::scanner::{ScannedScript, Symbol};
use dashql_parser::symbol_kind::*;
use std::sync::Arc;

/// The state of a script that a cursor points into (the parts of `Script` the cursor reads)
#[derive(Clone, Copy)]
pub struct ScriptView<'a> {
    pub scanned: Option<&'a Arc<ScannedScript>>,
    pub parsed: Option<&'a Arc<ParsedScript>>,
    pub analyzed: Option<&'a Arc<AnalyzedScript>>,
    pub catalog: &'a Catalog,
}

impl<'a> ScriptView<'a> {
    /// The analyzed script if it was analyzed from the current parsed script
    pub fn current_analysis(&self) -> Option<&'a Arc<AnalyzedScript>> {
        match (self.parsed, self.analyzed) {
            (Some(p), Some(a)) if Arc::ptr_eq(p, &a.parsed) => Some(a),
            _ => None,
        }
    }
}

/// A scanner symbol and the position of a text offset relative to it (`SymbolLocationInfo`)
#[derive(Clone, Copy, Debug)]
pub struct SymbolLocation {
    /// The symbol index
    pub symbol_id: u32,
    pub symbol: Symbol,
    /// The text offset
    pub text_offset: u32,
    pub relative_pos: RelativeSymbolPosition,
}

impl SymbolLocation {
    pub fn is_dot(&self) -> bool {
        self.symbol.kind == S_DOT || self.symbol.kind == S_DOT_STAR_LA
    }
    pub fn is_trailing_dot(&self) -> bool {
        self.symbol.kind == S_DOT_TRAILING
    }
}

/// The symbol at a text offset and its predecessor (`LocationInfo`)
#[derive(Clone, Copy, Debug)]
pub struct LocationInfo {
    /// The last symbol that does not begin after the text offset
    pub current: SymbolLocation,
    /// The previous symbol, which might end at the text offset
    pub previous: Option<SymbolLocation>,
}

/// The position of a text offset relative to a symbol
fn relative_position(symbols: &[Symbol], text_offset: u32, symbol_id: u32) -> RelativeSymbolPosition {
    let Some(symbol) = symbols.get(symbol_id as usize) else {
        return RelativeSymbolPosition::AFTER_SYMBOL;
    };
    let begin = symbol.location.offset;
    let end = symbol.location.offset + symbol.location.length;
    if text_offset < begin {
        RelativeSymbolPosition::BEFORE_SYMBOL
    } else if text_offset == begin {
        RelativeSymbolPosition::BEGIN_OF_SYMBOL
    } else if text_offset == end {
        RelativeSymbolPosition::END_OF_SYMBOL
    } else if text_offset < end {
        RelativeSymbolPosition::MID_OF_SYMBOL
    } else {
        RelativeSymbolPosition::AFTER_SYMBOL
    }
}

/// Find the symbol at a text offset (`ScannedScript::FindSymbol`)
pub fn find_symbol(scanned: &ScannedScript, text_offset: usize) -> LocationInfo {
    let symbols = &scanned.symbols;
    let text_offset = text_offset.min(scanned.text.len()) as u32;
    let location = |id: u32| SymbolLocation {
        symbol_id: id,
        symbol: symbols[id as usize],
        text_offset,
        relative_pos: relative_position(symbols, text_offset, id),
    };
    // The last symbol that does not begin after the offset
    let mut id = symbols.partition_point(|s| s.location.offset <= text_offset).saturating_sub(1) as u32;
    // Hit EOF? Use the last symbol before it
    if symbols[id as usize].kind == S_YYEOF {
        if id == 0 {
            // The very first symbol is EOF, the script is empty
            let current = SymbolLocation {
                symbol_id: 0,
                symbol: symbols[0],
                text_offset,
                relative_pos: RelativeSymbolPosition::BEFORE_SYMBOL,
            };
            return LocationInfo { current, previous: None };
        }
        id -= 1;
    }
    let current = location(id);
    let previous = location(id.saturating_sub(1));
    LocationInfo {
        current,
        previous: Some(previous),
    }
}

/// Is a text offset strictly inside a comment? (`ScannedScript::IsInsideComment`)
///
/// The begin of a comment is never inside. A line comment ends at its newline, which is not part of
/// its span, a block comment ends with its closing `*/`.
pub fn is_inside_comment(scanned: &ScannedScript, text_offset: usize) -> bool {
    let text_offset = text_offset as u32;
    let i = scanned.comments.partition_point(|c| c.offset <= text_offset);
    if i == 0 {
        return false;
    }
    let comment = scanned.comments[i - 1];
    let begin = comment.offset;
    let end = begin + comment.length;
    if text_offset <= begin {
        return false;
    }
    let text = scanned.text.as_bytes();
    let is_line_comment = comment.length >= 2 && text.get(begin as usize) == Some(&b'-') && text.get(begin as usize + 1) == Some(&b'-');
    if is_line_comment {
        text_offset <= end
    } else {
        text_offset < end
    }
}

/// Find the statement and the innermost AST node at a text offset (`ParsedScript::FindNodeAtOffset`)
pub fn find_node_at_offset(parsed: &ParsedScript, text_offset: usize) -> Option<(u32, u32)> {
    if parsed.statements.is_empty() {
        return None;
    }
    let scanned = &parsed.scanned;
    let resolve = |span: SymbolSpan| resolve_text_span(&scanned.text, &scanned.symbols, span);
    let text_offset = text_offset as u64;
    // The predecessor of the first statement that begins after the offset
    let mut statement_id = 0;
    while statement_id < parsed.statements.len() {
        let root = parsed.statements[statement_id].root;
        let ts = resolve(*parsed.nodes[root as usize].symbol_span());
        if ts.offset as u64 > text_offset {
            break;
        }
        statement_id += 1;
    }
    if statement_id == 0 {
        return None;
    }
    statement_id -= 1;
    // Traverse down the AST
    let mut iter = parsed.statements[statement_id].root;
    loop {
        let node = &parsed.nodes[iter as usize];
        if node.children_count() == 0 {
            break;
        }
        // Prefer a child that contains the offset over a child that ends at it.
        // AST nodes have holes, e.g. a select clause has no node for the FROM keyword.
        let mut child_exact = None;
        let mut child_end = None;
        for i in 0..node.children_count() {
            let ci = node.children_begin_or_value() + i;
            let ts = resolve(*parsed.nodes[ci as usize].symbol_span());
            let begin = ts.offset as u64;
            let end = begin + ts.length as u64;
            if begin <= text_offset {
                if end > text_offset {
                    child_exact = Some(ci);
                } else if end == text_offset {
                    child_end = Some(ci);
                }
            }
        }
        match child_exact.or(child_end) {
            Some(child) => iter = child,
            None => break,
        }
    }
    Some((statement_id as u32, iter))
}

/// Collect the path from a node to its statement root and the name scopes on that path
/// (`AnalyzedScript::FollowPathUpwards`)
pub fn follow_path_upwards(analyzed: &AnalyzedScript, ast_node_id: u32, path: &mut Vec<u32>, scopes: &mut Vec<ScopeId>) {
    path.clear();
    scopes.clear();
    let nodes = &analyzed.parsed.nodes;
    let mut node = ast_node_id;
    loop {
        path.push(node);
        if let Some(&scope) = analyzed.name_scopes_by_root_node.get(&node) {
            scopes.push(scope);
        }
        let parent = nodes[node as usize].parent();
        // Statement roots are their own parents
        if parent == node {
            break;
        }
        node = parent;
    }
}

/// The kind of a name path component
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameComponentType {
    Name,
    Star,
    TrailingDot,
    Index,
}

/// A component of a name path
#[derive(Clone, Copy, Debug)]
pub struct NameComponent {
    pub loc: SymbolSpan,
    pub component_type: NameComponentType,
    pub name: Option<NameId>,
}

/// What the cursor points at
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorContext {
    #[default]
    None,
    /// A table reference
    TableRef { table_reference_id: TableRefId, at_alias: bool },
    /// A column reference. `u32::MAX` marks an `alias.` without a column ref node.
    ColumnRef { expression_id: ExprId },
}

/// A cursor in a script (`ScriptCursor`)
pub struct ScriptCursor<'a> {
    pub script: ScriptView<'a>,
    pub text_offset: usize,
    pub scanner_location: Option<LocationInfo>,
    pub statement_id: Option<u32>,
    pub ast_node_id: Option<u32>,
    /// The AST nodes from the cursor node to the statement root
    pub ast_path_to_root: Vec<u32>,
    /// The name scopes that contain the cursor, innermost first
    pub name_scopes: Vec<ScopeId>,
    pub context: CursorContext,
}

impl<'a> ScriptCursor<'a> {
    /// Place a cursor in a script (`ScriptCursor::Place`)
    pub fn place(script: ScriptView<'a>, text_offset: usize) -> Self {
        let mut cursor = ScriptCursor {
            script,
            text_offset,
            scanner_location: None,
            statement_id: None,
            ast_node_id: None,
            ast_path_to_root: Vec::new(),
            name_scopes: Vec::new(),
            context: CursorContext::None,
        };
        if let Some(scanned) = script.scanned {
            cursor.scanner_location = Some(find_symbol(scanned, text_offset));
        }
        let Some(parsed) = script.parsed else { return cursor };

        let mut ast_node = find_node_at_offset(parsed, text_offset);
        // A trailing dot may span into following whitespace. Anchor the lookup at the dot so that the
        // cursor stays associated with the qualifier.
        if let Some(location) = &cursor.scanner_location {
            if location.current.is_trailing_dot() {
                if let Some(qualifier) = find_node_at_offset(parsed, location.current.symbol.location.offset as usize) {
                    ast_node = Some(qualifier);
                }
            }
        }
        if let Some((statement_id, node_id)) = ast_node {
            cursor.statement_id = Some(statement_id);
            cursor.ast_node_id = Some(node_id);
            if let Some(analyzed) = script.current_analysis() {
                follow_path_upwards(analyzed, node_id, &mut cursor.ast_path_to_root, &mut cursor.name_scopes);
                cursor.find_context(analyzed, parsed);
            }
        }
        cursor.recover_dot_context();
        cursor
    }

    /// Find a table or column ref in the innermost scope
    fn find_context(&mut self, analyzed: &AnalyzedScript, parsed: &ParsedScript) {
        let Some(&innermost) = self.name_scopes.first() else { return };
        let scope = &analyzed.name_scopes[innermost as usize];
        for &node_id in &self.ast_path_to_root {
            let mut matched = false;
            match parsed.nodes[node_id as usize].node_type() {
                NodeType::OBJECT_SQL_COLUMN_REF => {
                    matched = true;
                    for &expr in &scope.expressions {
                        let expression = &analyzed.expressions[expr as usize];
                        if expression.ast_node_id == node_id && expression.column_ref().is_some() {
                            self.context = CursorContext::ColumnRef {
                                expression_id: expression.expression_id,
                            };
                        }
                    }
                }
                NodeType::OBJECT_SQL_TABLEREF => {
                    matched = true;
                    for &table_ref_id in &scope.table_references {
                        let table_ref = &analyzed.table_references[table_ref_id as usize];
                        if table_ref.ast_node_id != node_id {
                            continue;
                        }
                        let mut at_alias = false;
                        if let Some((_, alias_loc)) = &table_ref.alias {
                            let scanned = &parsed.scanned;
                            let alias_ts = resolve_text_span(&scanned.text, &scanned.symbols, *alias_loc);
                            at_alias = self.text_offset >= alias_ts.offset as usize;
                        }
                        self.context = CursorContext::TableRef {
                            table_reference_id: table_ref.table_reference_id.object,
                            at_alias,
                        };
                    }
                }
                _ => {}
            }
            // Stop at the root of the innermost scope
            if matched || node_id == scope.ast_node_id {
                break;
            }
        }
    }

    /// The dot symbol at or before the cursor
    pub fn dot_symbol(location: &LocationInfo, current: &SymbolLocation) -> Option<SymbolLocation> {
        if current.is_dot() || current.is_trailing_dot() {
            return Some(*current);
        }
        location.previous.filter(|p| p.is_dot() || p.is_trailing_dot())
    }

    /// In incomplete SQL, the parser can omit the column ref node of `alias.` although name
    /// resolution registered the alias in a scope. Recover a synthetic column ref context.
    fn recover_dot_context(&mut self) {
        if self.context != CursorContext::None {
            return;
        }
        let (Some(location), Some(analyzed), Some(scanned)) = (self.scanner_location, self.script.analyzed, self.script.scanned) else {
            return;
        };
        let Some(dot) = Self::dot_symbol(&location, &location.current) else { return };
        let qualifier = qualifier_before(&scanned.text, dot.symbol.location.offset as usize);
        let qualifier_text = &scanned.text[qualifier.0..qualifier.1];

        let mut best_scope = None;
        for &scope in &self.name_scopes {
            if analyzed.name_scopes[scope as usize].source(qualifier_text).is_some() {
                best_scope = Some(scope);
                break;
            }
        }
        // Prefer the narrowest scope containing the cursor, the same alias can occur in nested queries
        if best_scope.is_none() && self.name_scopes.is_empty() {
            let mut best_length = usize::MAX;
            let parsed = &analyzed.parsed;
            for scope in &analyzed.name_scopes {
                if scope.source(qualifier_text).is_none() {
                    continue;
                }
                let span = resolve_text_span(&scanned.text, &scanned.symbols, *parsed.nodes[scope.ast_node_id as usize].symbol_span());
                let scope_end = span.offset as usize + span.length as usize;
                let contains_cursor = span.offset as usize <= self.text_offset && self.text_offset <= scope_end;
                if contains_cursor && (span.length as usize) < best_length {
                    best_scope = Some(scope.name_scope_id);
                    best_length = span.length as usize;
                } else if best_scope.is_none() && self.statement_id.is_none_or(|s| scope.ast_statement_id == s) {
                    best_scope = Some(scope.name_scope_id);
                }
            }
        }
        if let Some(scope) = best_scope {
            if self.name_scopes.is_empty() {
                self.name_scopes.push(scope);
            }
            self.context = CursorContext::ColumnRef { expression_id: u32::MAX };
        }
    }

    /// Read the name path at the cursor (`ScriptCursor::ReadCursorNamePath`)
    pub fn read_cursor_name_path(&self, name_path_loc: &mut SymbolSpan) -> Vec<NameComponent> {
        let (Some(analyzed), Some(parsed)) = (self.script.analyzed, self.script.parsed) else {
            return Vec::new();
        };
        let name_node = match self.context {
            CursorContext::TableRef { table_reference_id, .. } => analyzed.table_references[table_reference_id as usize]
                .inner
                .as_ref()
                .and_then(|r| r.table_name.ast_node_id),
            CursorContext::ColumnRef { expression_id } if expression_id != u32::MAX => {
                analyzed.expressions[expression_id as usize].column_ref().and_then(|c| c.column_name.ast_node_id)
            }
            _ => None,
        };
        let Some(name_node) = name_node else { return Vec::new() };
        let nodes = &parsed.nodes;
        let node = &nodes[name_node as usize];
        if node.node_type() != NodeType::ARRAY {
            return Vec::new();
        }
        *name_path_loc = *node.symbol_span();
        let begin = node.children_begin_or_value() as usize;
        let mut components = Vec::new();
        for child in &nodes[begin..begin + node.children_count() as usize] {
            let component_type = match child.node_type() {
                NodeType::NAME => NameComponentType::Name,
                NodeType::OBJECT_SQL_INDIRECTION_STAR => NameComponentType::Star,
                NodeType::OBJECT_SQL_INDIRECTION_INDEX => NameComponentType::Index,
                NodeType::OBJECT_EXT_TRAILING_DOT => NameComponentType::TrailingDot,
                _ => return Vec::new(),
            };
            components.push(NameComponent {
                loc: *child.symbol_span(),
                component_type,
                name: (component_type == NameComponentType::Name).then(|| child.children_begin_or_value()),
            });
            if component_type == NameComponentType::TrailingDot {
                return components;
            }
        }
        components
    }
}

/// The identifier before a dot at a byte offset: skips dots, then takes `[A-Za-z0-9_]*`.
/// Returns the byte range.
pub fn qualifier_before(text: &str, dot_offset: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    let mut end = dot_offset.min(bytes.len());
    while end > 0 && bytes[end - 1] == b'.' {
        end -= 1;
    }
    let mut begin = end;
    while begin > 0 && (bytes[begin - 1].is_ascii_alphanumeric() || bytes[begin - 1] == b'_') {
        begin -= 1;
    }
    (begin, end)
}
