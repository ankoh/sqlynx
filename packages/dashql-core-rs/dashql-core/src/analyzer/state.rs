//! The state shared between the analysis passes (`analysis_state.h`).

use super::types::*;
use super::{AnalyzedScript, NameObject};
use crate::catalog::*;
use dashql_buffers::analyzer::{AnalyzerErrorSeverity, AnalyzerErrorType, NameTag, SemanticNodeMarkerType};
use dashql_buffers::parser::{Node, NodeType, SymbolSpan};
use dashql_grammar::names::NameId;
use dashql_grammar::parser::context::resolve_text_span;
use dashql_grammar::parser::ParsedScript;
use dashql_grammar::scanner::ScannedScript;
use dashql_grammar::span::TextSpan;
use std::sync::Arc;

pub(super) struct AnalysisState<'a> {
    /// The parsed script
    pub parsed: &'a ParsedScript,
    /// The AST
    pub ast: &'a [Node],
    /// The catalog
    pub catalog: &'a Catalog,
    /// The catalog entry id of the script
    pub entry_id: CatalogEntryId,
    /// The texts of the names
    pub name_texts: Vec<Arc<str>>,
    /// The output
    pub out: AnalyzedScript,
    /// The expression of every AST node, if it was translated
    pub expression_index: Vec<Option<ExprId>>,
}

impl<'a> AnalysisState<'a> {
    pub fn new(parsed: &'a Arc<ParsedScript>, catalog: &'a Catalog) -> Self {
        let scanned = parsed.scanned.clone();
        let entry_id = scanned.external_id;
        let mut names = scanned.names.clone();
        let empty_name = names.register("", TextSpan::default());
        let mut name_tags = vec![NameTag::NONE; names.len()];
        name_tags[empty_name as usize] = NameTag(NameTag::DATABASE_NAME.0 | NameTag::SCHEMA_NAME.0);
        let name_texts = names.iter().map(|n| Arc::<str>::from(n.text.as_str())).collect();
        let node_count = parsed.nodes.len();
        let out = AnalyzedScript {
            parsed: parsed.clone(),
            entry: CatalogEntryData::new(entry_id, catalog.version()),
            names,
            name_tags,
            name_objects: Vec::new(),
            empty_name,
            errors: Vec::new(),
            node_markers: vec![SemanticNodeMarkerType::NONE; node_count],
            table_references: Vec::new(),
            insert_statements: Vec::new(),
            expressions: Vec::new(),
            function_arguments: Vec::new(),
            name_scopes: Vec::new(),
            name_scopes_by_root_node: Default::default(),
            constant_expressions: Vec::new(),
            visualization_specs: Vec::new(),
            inference_constraints: Vec::new(),
            inferred_table_schemas: Vec::new(),
            inferred_table_schemas_by_name: Default::default(),
            dependencies: catalog.entries_ranked().map(|(_, e)| e.clone()).collect(),
        };
        Self {
            parsed,
            ast: &parsed.nodes,
            catalog,
            entry_id,
            name_texts,
            out,
            expression_index: vec![None; node_count],
        }
    }

    pub fn into_script(self) -> AnalyzedScript {
        self.out
    }

    pub fn scanned(&self) -> &ScannedScript {
        &self.parsed.scanned
    }

    /// The children of a node
    pub fn children(&self, node: &Node) -> &'a [Node] {
        let count = node.children_count() as usize;
        if count == 0 {
            return &[];
        }
        let begin = node.children_begin_or_value() as usize;
        &self.ast[begin..begin + count]
    }

    /// The id of a node of the AST
    pub fn node_id(&self, node: &Node) -> u32 {
        ((node as *const Node as usize - self.ast.as_ptr() as usize) / std::mem::size_of::<Node>()) as u32
    }

    /// A name of the script
    pub fn name(&self, id: NameId) -> Name {
        Name {
            entry: self.entry_id,
            id,
            text: self.name_texts[id as usize].clone(),
        }
    }

    /// The empty name
    pub fn empty_name(&self) -> Name {
        self.name(self.out.empty_name)
    }

    /// The name of a NAME node
    pub fn node_name(&self, node: &Node) -> Name {
        self.name(node.children_begin_or_value())
    }

    /// Add analyzer tags to a name of the script
    pub fn tag(&mut self, name: &Name, tag: NameTag) {
        if name.entry == self.entry_id {
            let tags = &mut self.out.name_tags[name.id as usize];
            *tags = NameTag(tags.0 | tag.0);
        }
    }

    /// Remember an object a name resolves to
    pub fn resolve_name(&mut self, name: &Name, object: NameObject) {
        self.out.name_objects.push((name.entry, name.id, object));
    }

    /// Resolve a symbol span to a text span
    pub fn text_span(&self, span: SymbolSpan) -> TextSpan {
        let scanned = self.scanned();
        resolve_text_span(&scanned.text, &scanned.symbols, span)
    }

    /// The text at a symbol span (`ReadTextAtSymbolSpan`)
    pub fn text_at(&self, span: SymbolSpan) -> &str {
        let text = &self.parsed.scanned.text;
        let ts = self.text_span(span);
        let begin = (ts.offset as usize).min(text.len());
        let end = (begin + ts.length as usize).min(text.len());
        &text[begin..end]
    }

    /// Mark a node
    pub fn mark(&mut self, node_id: u32, marker: SemanticNodeMarkerType) {
        self.out.node_markers[node_id as usize] = marker;
    }

    /// Add an expression (`AnalyzedScript::AddExpression`)
    pub fn add_expression(&mut self, node_id: u32, location: SymbolSpan, inner: ExpressionInner) -> ExprId {
        let id = self.out.expressions.len() as ExprId;
        self.out.expressions.push(Expression {
            expression_id: id,
            ast_node_id: node_id,
            location: Some(location),
            ast_statement_id: None,
            inner,
            is_constant_expression: false,
        });
        id
    }

    /// The expression of a node
    pub fn expression_of(&self, node_id: u32) -> Option<ExprId> {
        self.expression_index.get(node_id as usize).copied().flatten()
    }

    /// Add an error at an AST node
    pub fn add_error(&mut self, error_type: AnalyzerErrorType, severity: AnalyzerErrorSeverity, node_id: u32, message: String) {
        let span = *self.ast[node_id as usize].symbol_span();
        let text_span = self.text_span(span);
        self.out.errors.push(AnalyzerError {
            error_type,
            severity,
            ast_node_id: node_id,
            symbol_span: Some(span),
            text_span: Some(text_span),
            message,
        });
    }

    /// Read a name path (`ReadNamePath`)
    pub fn read_name_path(&self, node: &Node) -> Vec<NameId> {
        let mut path = Vec::new();
        if node.node_type() != NodeType::ARRAY {
            return path;
        }
        for child in self.children(node) {
            match child.node_type() {
                // Skip over trailing dots
                NodeType::OBJECT_EXT_TRAILING_DOT => continue,
                NodeType::NAME => path.push(child.children_begin_or_value()),
                // Not a plain name path
                _ => {
                    path.clear();
                    break;
                }
            }
        }
        path
    }

    /// Read a qualified table name (`ReadQualifiedTableName`)
    pub fn read_qualified_table_name(&mut self, node: Option<&Node>) -> Option<QualifiedTableName> {
        let node = node?;
        let path = self.read_name_path(node);
        let ast_node_id = Some(self.node_id(node));
        let (db, schema, table) = match path.len() {
            3 => (self.name(path[0]), self.name(path[1]), self.name(path[2])),
            2 => (self.empty_name(), self.name(path[0]), self.name(path[1])),
            1 => (self.empty_name(), self.empty_name(), self.name(path[0])),
            _ => return None,
        };
        if path.len() == 3 {
            self.tag(&db, NameTag::DATABASE_NAME);
        }
        if path.len() >= 2 {
            self.tag(&schema, NameTag::SCHEMA_NAME);
        }
        self.tag(&table, NameTag::TABLE_NAME);
        Some(QualifiedTableName {
            ast_node_id,
            database_name: db,
            schema_name: schema,
            table_name: table,
        })
    }

    /// Read a qualified column name (`ReadQualifiedColumnName`).
    /// Paths with more than two names access fields of a row-typed column.
    pub fn read_qualified_column_name(&mut self, node: Option<&Node>) -> Option<QualifiedColumnName> {
        let node = node?;
        let path = self.read_name_path(node);
        let ast_node_id = Some(self.node_id(node));
        match path.len() {
            0 => None,
            1 => {
                let column = self.name(path[0]);
                self.tag(&column, NameTag::COLUMN_NAME);
                Some(QualifiedColumnName {
                    ast_node_id,
                    table_alias: None,
                    column_name: column,
                })
            }
            _ => {
                let alias = self.name(path[0]);
                let column = self.name(path[1]);
                self.tag(&alias, NameTag::TABLE_ALIAS);
                self.tag(&column, NameTag::COLUMN_NAME);
                Some(QualifiedColumnName {
                    ast_node_id,
                    table_alias: Some(alias),
                    column_name: column,
                })
            }
        }
    }

    /// Read a qualified function name (`ReadQualifiedFunctionName`)
    pub fn read_qualified_function_name(&mut self, node: Option<&Node>) -> Option<QualifiedFunctionName> {
        let node = node?;
        let path = self.read_name_path(node);
        let ast_node_id = Some(self.node_id(node));
        let (db, schema, function) = match path.len() {
            3 => (self.name(path[0]), self.name(path[1]), self.name(path[2])),
            2 => (self.empty_name(), self.name(path[0]), self.name(path[1])),
            1 => (self.empty_name(), self.empty_name(), self.name(path[0])),
            _ => return None,
        };
        if path.len() == 3 {
            self.tag(&db, NameTag::DATABASE_NAME);
        }
        if path.len() >= 2 {
            self.tag(&schema, NameTag::SCHEMA_NAME);
        }
        self.tag(&function, NameTag::FUNCTION_NAME);
        Some(QualifiedFunctionName {
            ast_node_id,
            database_name: db,
            schema_name: schema,
            function_name: function,
        })
    }

    /// A table of this script or of the catalog
    pub fn table(&self, loc: TableLoc) -> Option<&TableDeclaration> {
        if loc.entry == self.entry_id {
            self.out.entry.table_declarations.get(loc.index as usize)
        } else {
            self.catalog.table(loc)
        }
    }

    /// The statement that contains an AST node (`FindStatementId`)
    pub fn find_statement_id(&self, ast_node_id: u32) -> u32 {
        let mut root = ast_node_id;
        for _ in 0..self.ast.len() {
            let parent = self.ast[root as usize].parent();
            if parent as usize >= self.ast.len() {
                break;
            }
            root = parent;
        }
        let statements = &self.parsed.statements;
        if let Some(i) = statements.iter().position(|s| s.root == root) {
            return i as u32;
        }
        statements
            .iter()
            .position(|s| ast_node_id >= s.nodes_begin && ast_node_id < s.nodes_begin + s.node_count)
            .map(|i| i as u32)
            .unwrap_or(PROTO_NULL_U32)
    }
}

/// The literal type of a literal node type
pub(super) fn literal_type(node_type: NodeType) -> dashql_buffers::algebra::LiteralType {
    dashql_buffers::algebra::LiteralType((node_type.0 - 5) as u8)
}

/// Quote an identifier if it would not round-trip unquoted (`quote_anyupper_fuzzy`)
pub(super) fn quote_identifier(text: &str) -> String {
    let is_start = |c: u8| c.is_ascii_alphabetic() || c == b'_' || c >= 0x80;
    let is_cont = |c: u8| is_start(c) || c.is_ascii_digit() || c == b'$';
    let bytes = text.as_bytes();
    let requires_quotes = bytes.is_empty()
        || bytes.iter().any(|c| c.is_ascii_uppercase())
        || !is_start(bytes[0])
        || !bytes.iter().all(|&c| is_cont(c));
    if !requires_quotes {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        if c == '"' {
            out.push('"');
        }
        out.push(c);
    }
    out.push('"');
    out
}
