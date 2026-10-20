//! FlatBuffer packing of scanned, parsed and analyzed scripts (`ScannedScript::Pack`,
//! `ParsedScript::Pack`, `AnalyzedScript::Pack` in `src/script.cc`, `PackTokens` in
//! `src/parser/grammar/tokens.cc`).
//!
//! The C++ core packs the parsed script through the object API, which leaves out empty vectors and
//! strings, but builds the analyzed script by hand, which always writes its vectors. The packing
//! here reproduces the presence of every field.

// Bison names some symbol kinds in mixed case (S_Op)
#![allow(non_upper_case_globals)]

use crate::analyzer::*;
use crate::catalog::*;
use crate::utils::sort::std_sort;
use dashql_buffers::algebra::{
    BinaryExpressionT, ColumnRefExpressionT, ComparisonT, ConstIntervalCastT, ExpressionSubTypeT, ExpressionT, FunctionCallExpressionT,
    LiteralT, ResolvedColumnT,
};
use dashql_buffers::analyzer::{
    AnalyzedScriptT, ConstantExpressionT, FunctionDeclarationT, FunctionParamT, IndexedColumnReferenceT, IndexedTableReferenceT,
    InferredColumnT, InferredTableSchemaT, InsertStatementT, InsertTargetColumnT, NameScopeT, QualifiedColumnNameT,
    QualifiedFunctionNameT, QualifiedTableNameT, ResolvedTableT, TableColumnT, TableReferenceRole, TableReferenceT, TableT,
    VisSourceKind as PackedVisSourceKind, VisualizationSpecT,
};
use dashql_buffers::parser::{
    AttachDatabaseStatementT, AttributeKey, CommentBlockT, ErrorT, Node, NodeT, NodeType, ParsedScriptFeature, ParsedScriptT, ScannedScriptT,
    ScannerTokenType, ScannerTokensT, StatementT, StatementTargetT, StatementTargetType, StatementType, SymbolSpan, SymbolSpanT,
    TextSpanT,
};
use dashql_buffers::visualization::{DashboardSpecT, TableSpecT};
use dashql_grammar::keywords::Keyword;
use dashql_grammar::parser::context::resolve_text_span;
use dashql_grammar::parser::ParsedScript;
use dashql_grammar::scanner::{ScannedScript, Symbol};
use dashql_grammar::span::TextSpan;
use dashql_grammar::symbol_kind::*;

/// Build a FlatBuffers object API value, which are non-exhaustive: start from the default and
/// assign the listed fields
macro_rules! build {
    ($ty:ident { $($field:ident $(: $value:expr)?),* $(,)? }) => {{
        let mut v = $ty::default();
        $( build!(@set v, $field $(, $value)?); )*
        v
    }};
    (@set $v:ident, $field:ident, $value:expr) => { $v.$field = $value; };
    (@set $v:ident, $field:ident) => { $v.$field = $field; };
}

/// A vector that the C++ object API leaves out when empty
fn non_empty<T>(v: Vec<T>) -> Option<Vec<T>> {
    (!v.is_empty()).then_some(v)
}

/// A string that the C++ object API leaves out when empty
fn non_empty_str(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

fn text_span(span: TextSpan) -> TextSpanT {
    build!(TextSpanT {
        offset: span.offset,
        length: span.length,
    })
}

fn symbol_span(span: SymbolSpan) -> SymbolSpanT {
    build!(SymbolSpanT {
        offset: span.offset(),
        length: span.length(),
    })
}

/// The index of a node in its AST
fn n_index(nodes: &[Node], n: &Node) -> usize {
    (n as *const Node as usize - nodes.as_ptr() as usize) / std::mem::size_of::<Node>()
}

fn comment_block(b: &dashql_grammar::comment_blocks::CommentBlock) -> CommentBlockT {
    build!(CommentBlockT {
        block_type: b.block_type,
        text_span: text_span(b.text_span),
        tag_span: text_span(b.tag_span),
        comments_begin: b.comments_begin,
        comments_count: b.comments_count,
        lines_begin: b.lines_begin,
        lines_count: b.lines_count,
    })
}

fn node(n: &Node) -> NodeT {
    n.unpack()
}

/// Pack a scanned script (`ScannedScript::Pack`)
pub fn pack_scanned_script(scanned: &ScannedScript) -> ScannedScriptT {
    build!(ScannedScriptT {
        external_id: scanned.external_id,
        line_breaks: non_empty(scanned.line_breaks.iter().map(|&s| text_span(s)).collect()),
        errors: non_empty(
            scanned
                .errors
                .iter()
                .map(|e| build!(ErrorT {
                    text_span: Some(text_span(e.location)),
                    symbol_span: None,
                    message: non_empty_str(&e.message),
                    hint: None,
                }))
                .collect(),
        ),
        comments: non_empty(scanned.comments.iter().map(|&s| text_span(s)).collect()),
    })
}

/// The token type of a scanner symbol (`MapToken`)
fn token_type(symbol: &Symbol, text: &str) -> ScannerTokenType {
    match symbol.kind {
        S_NULLS_LA | S_NOT_LA | S_WITH_LA | S_VISUALIZE_LA => ScannerTokenType::KEYWORD,
        kind if Keyword::name_of(kind).is_some() => ScannerTokenType::KEYWORD,
        S_SCONST => ScannerTokenType::LITERAL_STRING,
        S_ICONST => ScannerTokenType::LITERAL_INTEGER,
        S_FCONST => ScannerTokenType::LITERAL_FLOAT,
        S_BCONST => ScannerTokenType::LITERAL_BINARY,
        S_XCONST => ScannerTokenType::LITERAL_HEX,
        S_IDENT => ScannerTokenType::IDENTIFIER,
        S_Op | S_EQUALS_GREATER | S_GREATER_EQUALS | S_LESS_EQUALS | S_NOT_EQUALS => ScannerTokenType::OPERATOR,
        S_DOT | S_DOT_STAR_LA => ScannerTokenType::DOT,
        S_DOT_TRAILING => ScannerTokenType::DOT_TRAILING,
        _ => {
            if symbol.location.length == 1 && text.as_bytes().get(symbol.location.offset as usize) == Some(&b'=') {
                ScannerTokenType::OPERATOR
            } else {
                ScannerTokenType::NONE
            }
        }
    }
}

/// Pack the tokens for highlighting (`ParsedScript::PackTokens`)
pub fn pack_tokens(parsed: &ParsedScript) -> ScannerTokensT {
    let scanned = &parsed.scanned;
    let symbol_count = scanned.symbols.len();
    // Keywords that the parser used as names are identifiers
    let mut name_overrides = vec![false; symbol_count];
    for n in &parsed.nodes {
        if n.node_type() == NodeType::NAME && n.symbol_span().length() == 1 {
            if let Some(slot) = name_overrides.get_mut(n.symbol_span().offset() as usize) {
                *slot = true;
            }
        }
    }
    // Keywords in vis spec bodies are vis keywords
    let mut vis_spec_overrides = vec![false; symbol_count];
    for &(begin, end) in &parsed.vis_spec_spans {
        for slot in vis_spec_overrides.iter_mut().take(end as usize).skip(begin as usize) {
            *slot = true;
        }
    }
    let count = symbol_count.saturating_sub(1);
    let mut offsets = Vec::with_capacity(count);
    let mut lengths = Vec::with_capacity(count);
    let mut types = Vec::with_capacity(count);
    for (id, symbol) in scanned.symbols[..count].iter().enumerate() {
        offsets.push(symbol.location.offset);
        lengths.push(symbol.location.length);
        let mut t = token_type(symbol, &scanned.text);
        if t == ScannerTokenType::KEYWORD {
            if name_overrides[id] {
                t = ScannerTokenType::IDENTIFIER;
            } else if vis_spec_overrides[id] {
                t = ScannerTokenType::KEYWORD_VIS;
            }
        }
        types.push(t);
    }
    // The token index of every line break
    let mut breaks = Vec::with_capacity(scanned.line_breaks.len());
    let mut oi = 0;
    for lb in &scanned.line_breaks {
        while oi < offsets.len() && offsets[oi] < lb.offset {
            oi += 1;
        }
        breaks.push(oi as u32);
    }
    build!(ScannerTokensT {
        token_offsets: non_empty(offsets),
        token_lengths: non_empty(lengths),
        token_types: non_empty(types),
        token_breaks: non_empty(breaks),
    })
}

/// Pack a statement with its target (`ParsedScript::PackStatement`)
fn pack_statement(parsed: &ParsedScript, statement_id: usize) -> StatementT {
    let statement = &parsed.statements[statement_id];
    let nodes = &parsed.nodes;
    let mut out = build!(StatementT {
        statement_type: statement.statement_type,
        root_node: statement.root,
        nodes_begin: statement.nodes_begin,
        node_count: statement.node_count,
    });
    let root = &nodes[statement.root as usize];
    fn children<'a>(nodes: &'a [Node], n: &Node) -> &'a [Node] {
        let begin = n.children_begin_or_value() as usize;
        &nodes[begin..begin + n.children_count() as usize]
    }
    let find_attribute = |key: AttributeKey| children(nodes, root).iter().find(|c| c.attribute_key() == key);
    // Follow the left inputs of set operations
    let find_select_attribute = |key: AttributeKey| -> Option<&Node> {
        let mut current = root;
        while current.node_type() == NodeType::OBJECT_SQL_SELECT {
            let mut next = None;
            for child in children(nodes, current) {
                if child.attribute_key() == key {
                    return Some(child);
                }
                if child.attribute_key() == AttributeKey::SQL_COMBINE_INPUT && child.node_type() == NodeType::ARRAY && child.children_count() > 0 {
                    next = Some(&nodes[child.children_begin_or_value() as usize]);
                }
            }
            current = next?;
        }
        None
    };
    let read_name = |source: Option<&Node>| -> String {
        match source {
            Some(n) if n.node_type() == NodeType::NAME => parsed.scanned.names.get(n.children_begin_or_value()).text.clone(),
            _ => String::new(),
        }
    };
    let read_target = |out: &mut StatementT, source: Option<&Node>| {
        let mut source: Option<&Node> = source.map(|n| &nodes[n_index(nodes, n)]);
        if let Some(s) = source.filter(|s| s.node_type() == NodeType::OBJECT_SQL_TABLEREF) {
            if let Some(name) = children(nodes, s).iter().find(|c| c.attribute_key() == AttributeKey::SQL_TABLEREF_NAME) {
                source = Some(name);
            }
        }
        let Some(source) = source.filter(|s| s.node_type() == NodeType::ARRAY) else { return };
        let names = children(nodes, source);
        if names.is_empty() || names.len() > 3 {
            return;
        }
        let relation_name = read_name(names.last());
        let schema_name = if names.len() >= 2 { read_name(Some(&names[names.len() - 2])) } else { String::new() };
        let database_name = if names.len() == 3 { read_name(Some(&names[0])) } else { String::new() };
        if !relation_name.is_empty() {
            out.target = Some(Box::new(build!(StatementTargetT {
                database_name: non_empty_str(&database_name),
                schema_name: non_empty_str(&schema_name),
                relation_name: non_empty_str(&relation_name),
            })));
        }
    };
    let set_target = |out: &mut StatementT, target_type: StatementTargetType, key: AttributeKey| {
        out.target_type = target_type;
        read_target(out, find_attribute(key));
    };
    match statement.statement_type {
        StatementType::CREATE_TABLE => set_target(&mut out, StatementTargetType::TABLE, AttributeKey::SQL_CREATE_TABLE_NAME),
        StatementType::CREATE_TABLE_AS => set_target(&mut out, StatementTargetType::TABLE, AttributeKey::SQL_CREATE_AS_NAME),
        StatementType::CREATE_VIEW => set_target(&mut out, StatementTargetType::VIEW, AttributeKey::SQL_VIEW_NAME),
        StatementType::DROP_TABLE => set_target(&mut out, StatementTargetType::TABLE, AttributeKey::SQL_DROP_NAME),
        StatementType::DROP_VIEW => set_target(&mut out, StatementTargetType::VIEW, AttributeKey::SQL_DROP_NAME),
        StatementType::SELECT_INTO => {
            if let Some(into) = find_select_attribute(AttributeKey::SQL_SELECT_INTO).filter(|n| n.node_type() != NodeType::NONE) {
                out.target_type = StatementTargetType::TABLE;
                if let Some(name) = children(nodes, into).iter().find(|c| c.attribute_key() == AttributeKey::SQL_TEMP_NAME) {
                    read_target(&mut out, Some(name));
                }
            }
        }
        StatementType::ATTACH_DATABASE => {
            out.attach_database = Some(Box::new(build!(AttachDatabaseStatementT {
                path: non_empty_str(&read_name(find_attribute(AttributeKey::SQL_ATTACH_DATABASE_PATH))),
                alias: non_empty_str(&read_name(find_attribute(AttributeKey::SQL_ATTACH_DATABASE_ALIAS))),
                local: find_attribute(AttributeKey::SQL_ATTACH_DATABASE_LOCAL).is_some(),
            })));
        }
        StatementType::INSERT => set_target(&mut out, StatementTargetType::TABLE, AttributeKey::SQL_INSERT_TARGET),
        StatementType::DELETE => set_target(&mut out, StatementTargetType::TABLE, AttributeKey::SQL_DELETE_TARGET),
        _ => {}
    }
    out
}

/// The statement of a parsed script with its target (`ParsedScript::PackStatement`)
pub fn pack_parsed_statement(parsed: &ParsedScript, statement_id: usize) -> StatementT {
    pack_statement(parsed, statement_id)
}

/// Pack a parsed script (`ParsedScript::Pack`)
pub fn pack_parsed_script(parsed: &ParsedScript) -> ParsedScriptT {
    let scanned = &parsed.scanned;
    let descriptions = parsed.associate_descriptions();
    let statements = (0..parsed.statements.len())
        .map(|i| {
            let mut statement = pack_statement(parsed, i);
            let metadata = &descriptions[i];
            statement.statement_span = Some(text_span(metadata.statement_span));
            statement.description_begin = metadata.description_begin;
            statement.description_count = metadata.description_count;
            statement.description_block = metadata.description_block.unwrap_or(PROTO_NULL_U32);
            statement
        })
        .collect();
    let scanner_errors = scanned
        .errors
        .iter()
        .map(|e| build!(ErrorT {
            text_span: Some(text_span(e.location)),
            symbol_span: None,
            message: non_empty_str(&e.message),
            hint: None,
        }))
        .collect();
    let parser_errors = parsed
        .errors
        .iter()
        .map(|e| build!(ErrorT {
            symbol_span: Some(symbol_span(e.location)),
            text_span: Some(text_span(resolve_text_span(&scanned.text, &scanned.symbols, e.location))),
            message: non_empty_str(&e.message),
            hint: non_empty_str(&e.hint),
        }))
        .collect();
    let blocks = &parsed.comment_blocks;
    build!(ParsedScriptT {
        external_id: scanned.external_id,
        nodes: non_empty(parsed.nodes.iter().map(node).collect()),
        statements: non_empty(statements),
        scanner_errors: non_empty(scanner_errors),
        parser_errors: non_empty(parser_errors),
        tokens: Some(Box::new(pack_tokens(parsed))),
        line_breaks: non_empty(scanned.line_breaks.iter().map(|&s| text_span(s)).collect()),
        comments: non_empty(scanned.comments.iter().map(|&s| text_span(s)).collect()),
        comment_blocks: non_empty(blocks.blocks.iter().map(comment_block).collect()),
        comment_lines: non_empty(blocks.lines.iter().map(|&s| text_span(s)).collect()),
        metadata_block: blocks.metadata_block.unwrap_or(PROTO_NULL_U32),
        feature_flags: parsed.feature_flags,
    })
}

/// A packed name, absent if empty
fn name(n: &Name) -> Option<String> {
    non_empty_str(&n.text)
}

fn qualified_table_name(n: &QualifiedTableName) -> QualifiedTableNameT {
    build!(QualifiedTableNameT {
        ast_node_id: n.ast_node_id.unwrap_or(PROTO_NULL_U32),
        database_name: name(&n.database_name),
        schema_name: name(&n.schema_name),
        table_name: name(&n.table_name),
    })
}

fn qualified_column_name(n: &QualifiedColumnName) -> QualifiedColumnNameT {
    build!(QualifiedColumnNameT {
        ast_node_id: n.ast_node_id.unwrap_or(PROTO_NULL_U32),
        table_alias: n.table_alias.as_ref().and_then(name),
        column_name: name(&n.column_name),
    })
}

fn qualified_function_name(n: &QualifiedFunctionName) -> QualifiedFunctionNameT {
    build!(QualifiedFunctionNameT {
        ast_node_id: n.ast_node_id.unwrap_or(PROTO_NULL_U32),
        database_name: name(&n.database_name),
        schema_name: name(&n.schema_name),
        function_name: name(&n.function_name),
    })
}

/// Pack a table declaration (`TableDeclaration::Pack`)
pub fn pack_table(table: &TableDeclaration) -> TableT {
    let (db, schema) = table.catalog_schema_id.unpack_schema_id();
    build!(TableT {
        catalog_table_id: table.table_id().pack(),
        catalog_database_id: db,
        catalog_schema_id: schema,
        ast_node_id: table.ast_node_id.unwrap_or(PROTO_NULL_U32),
        ast_statement_id: table.ast_statement_id.unwrap_or(PROTO_NULL_U32),
        ast_scope_root: table.ast_scope_root.unwrap_or(PROTO_NULL_U32),
        table_name: Some(Box::new(qualified_table_name(&table.table_name))),
        // The column names are always written, the column AST nodes are not
        table_columns: Some(
            table
                .table_columns
                .iter()
                .map(|c| build!(TableColumnT {
                    column_name: Some(c.column_name.text.to_string()),
                }))
                .collect(),
        ),
    })
}

fn resolved_column(ids: &ResolvedColumnIds) -> ResolvedColumnT {
    let (db, schema) = ids.catalog_schema_id.unpack_schema_id();
    let (table_id, column) = ids.catalog_table_column_id.unpack_table_column_id();
    build!(ResolvedColumnT {
        catalog_database_id: db,
        catalog_schema_id: schema,
        catalog_table_id: table_id.pack(),
        column_id: column,
        referenced_catalog_version: ids.referenced_catalog_version,
    })
}

fn pack_expression(script: &AnalyzedScript, expr: &Expression) -> ExpressionT {
    let scanned = &script.parsed.scanned;
    let inner = match &expr.inner {
        ExpressionInner::None => ExpressionSubTypeT::NONE,
        ExpressionInner::ColumnRef(c) => ExpressionSubTypeT::ColumnRefExpression(Box::new(build!(ColumnRefExpressionT {
            ast_scope_root: c.ast_scope_root.unwrap_or(u32::MAX),
            column_name: Some(Box::new(qualified_column_name(&c.column_name))),
            resolved_column: c.resolved_ids.as_ref().map(|ids| Box::new(resolved_column(ids))),
        }))),
        ExpressionInner::Literal(l) => {
            let begin = (l.raw_value.offset as usize).min(scanned.text.len());
            let end = (begin + l.raw_value.length as usize).min(scanned.text.len());
            ExpressionSubTypeT::Literal(Box::new(build!(LiteralT {
                literal_type: l.literal_type,
                // Always written, even if empty
                raw_value: Some(scanned.text[begin..end].to_string()),
            })))
        }
        ExpressionInner::Comparison(c) => ExpressionSubTypeT::Comparison(Box::new(build!(ComparisonT {
            func: c.func,
            left_child: c.left_expression_id,
            right_child: c.right_expression_id,
        }))),
        ExpressionInner::BinaryExpression(b) => ExpressionSubTypeT::BinaryExpression(Box::new(build!(BinaryExpressionT {
            func: b.func,
            left_child: b.left_expression_id,
            right_child: b.right_expression_id,
        }))),
        ExpressionInner::FunctionCall(f) => {
            let arguments = match f.arguments {
                FunctionArguments::None => None,
                FunctionArguments::Generic { begin, count } => Some(
                    script.function_arguments[begin as usize..(begin + count) as usize]
                        .iter()
                        .filter_map(|a| a.expression_id)
                        .collect(),
                ),
            };
            ExpressionSubTypeT::FunctionCallExpression(Box::new(build!(FunctionCallExpressionT {
                func_name: match &f.function_name {
                    FunctionName::Qualified(n) => Some(Box::new(qualified_function_name(n))),
                    FunctionName::Known(_) => None,
                },
                func_call_modifiers: f.function_call_modifiers,
                arguments,
            })))
        }
        ExpressionInner::ConstIntervalCast(c) => {
            let mut out = build!(ConstIntervalCastT {
                value_expression: c.value_expression_id,
            });
            if let Some(interval) = &c.interval {
                out.interval_type = interval.interval_type;
                if let Some(p) = interval.precision_expression {
                    out.interval_precision = p as u32;
                }
            }
            ExpressionSubTypeT::ConstIntervalCast(Box::new(out))
        }
    };
    build!(ExpressionT {
        ast_node_id: expr.ast_node_id,
        ast_statement_id: expr.ast_statement_id.unwrap_or(PROTO_NULL_U32),
        symbol_span: expr.location.map(symbol_span),
        inner,
    })
}

/// The renderer-specific packing of a visualization spec: (vegalite json, umap spec, markdown spec)
pub type VisualizationPacker =
    dyn Fn(&AnalyzedScript, &VisualizationSpec) -> (Option<String>, Option<Box<dashql_buffers::visualization::UmapSpecT>>, Option<Box<dashql_buffers::visualization::MarkdownSpecT>>);

/// Pack an analyzed script (`AnalyzedScript::Pack`). `visualize` packs the renderer-specific specs.
pub fn pack_analyzed_script(script: &AnalyzedScript, visualize: &VisualizationPacker) -> AnalyzedScriptT {
    let entry = &script.entry;
    let tables = entry.table_declarations.iter().map(pack_table).collect();
    let table_references = script
        .table_references
        .iter()
        .map(|r| {
            let relation = r.inner.as_ref().expect("relation expression");
            build!(TableReferenceT {
                ast_node_id: r.ast_node_id,
                ast_statement_id: r.ast_statement_id.unwrap_or(PROTO_NULL_U32),
                symbol_span: r.location.map(symbol_span),
                table_name: Some(Box::new(qualified_table_name(&relation.table_name))),
                alias_name: r.alias.as_ref().map(|(a, _)| a.text.to_string()),
                resolved_table: relation.resolved_table.as_ref().map(|t| {
                    let (db, schema) = t.catalog_schema_id.unpack_schema_id();
                    Box::new(build!(ResolvedTableT {
                        catalog_database_id: db,
                        catalog_schema_id: schema,
                        catalog_table_id: t.catalog_table_id.unpack_table_id().pack(),
                        referenced_catalog_version: t.referenced_catalog_version,
                        table_name: Some(Box::new(qualified_table_name(&t.table_name))),
                    }))
                }),
                role: if r.role == TableRole::Write { TableReferenceRole::WRITE } else { TableReferenceRole::READ },
            })
        })
        .collect();
    let insert_statements = script
        .insert_statements
        .iter()
        .map(|insert| build!(InsertStatementT {
            ast_node_id: insert.ast_node_id,
            ast_statement_id: insert.ast_statement_id.unwrap_or(PROTO_NULL_U32),
            target_table_reference_id: script.table_references[insert.target as usize].table_reference_id.object,
            source_ast_node_id: insert.source_ast_node_id.unwrap_or(PROTO_NULL_U32),
            default_values: insert.default_values,
            returning: insert.returning,
            target_columns: Some(
                insert
                    .target_columns
                    .iter()
                    .map(|c| build!(InsertTargetColumnT {
                        ast_node_id: c.ast_node_id,
                        column_name: Some(c.column_name.text.to_string()),
                        resolved_column: c.resolved.and_then(|loc| {
                            let table = script.table(loc.table)?;
                            let ids = ResolvedColumnIds {
                                catalog_schema_id: table.catalog_schema_id,
                                catalog_table_column_id: table.table_columns[loc.column as usize].object_id,
                                referenced_catalog_version: table.catalog_version,
                            };
                            Some(Box::new(resolved_column(&ids)))
                        }),
                    }))
                    .collect(),
            ),
        }))
        .collect();
    let expressions = script.expressions.iter().map(|e| pack_expression(script, e)).collect();

    // Index the resolved table refs by catalog id, ties keep the order of std::sort
    let mut table_refs_by_id: Vec<IndexedTableReferenceT> = script
        .table_references
        .iter()
        .enumerate()
        .filter_map(|(i, r)| {
            let resolved = r.inner.as_ref()?.resolved_table.as_ref()?;
            let (db, schema) = resolved.catalog_schema_id.unpack_schema_id();
            Some(build!(IndexedTableReferenceT {
                catalog_database_id: db,
                catalog_schema_id: schema,
                catalog_table_id: resolved.catalog_table_id.unpack_table_id().pack(),
                table_reference_id: i as u32,
            }))
        })
        .collect();
    std_sort(&mut table_refs_by_id, &|l: &IndexedTableReferenceT, r: &IndexedTableReferenceT| {
        (l.catalog_database_id, l.catalog_schema_id, l.catalog_table_id) < (r.catalog_database_id, r.catalog_schema_id, r.catalog_table_id)
    });
    let mut column_refs_by_id: Vec<IndexedColumnReferenceT> = script
        .expressions
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let c = e.column_ref()?;
            if !c.resolved.is_resolved() {
                return None;
            }
            let ids = c.resolved_ids.as_ref()?;
            let (db, schema) = ids.catalog_schema_id.unpack_schema_id();
            let (table_id, column) = ids.catalog_table_column_id.unpack_table_column_id();
            Some(build!(IndexedColumnReferenceT {
                catalog_database_id: db,
                catalog_schema_id: schema,
                catalog_table_id: table_id.pack(),
                table_column_id: column,
                expression_id: i as u32,
            }))
        })
        .collect();
    std_sort(&mut column_refs_by_id, &|l: &IndexedColumnReferenceT, r: &IndexedColumnReferenceT| {
        (l.catalog_database_id, l.catalog_schema_id, l.catalog_table_id, l.table_column_id)
            < (r.catalog_database_id, r.catalog_schema_id, r.catalog_table_id, r.table_column_id)
    });

    let name_scopes = script
        .name_scopes
        .iter()
        .enumerate()
        .map(|(i, scope)| build!(NameScopeT {
            scope_id: i as u32,
            ast_node_id: scope.ast_node_id,
            ast_statement_id: scope.ast_statement_id,
            child_scopes: Some(scope.child_scopes.clone()),
            expressions: Some(scope.expressions.clone()),
            table_references: Some(scope.table_references.clone()),
        }))
        .collect();
    let constant_expressions = script
        .constant_expressions
        .iter()
        .map(|c| {
            let root = &script.expressions[c.root as usize];
            build!(ConstantExpressionT {
                ast_node_id: root.ast_node_id,
                ast_statement_id: root.ast_statement_id.unwrap_or(PROTO_NULL_U32),
                symbol_span: symbol_span(root.location.unwrap_or_default()),
                expression_id: root.expression_id,
            })
        })
        .collect();
    let function_declarations = entry
        .function_declarations
        .iter()
        .map(|f| build!(FunctionDeclarationT {
            ast_node_id: f.ast_node_id,
            ast_statement_id: f.ast_statement_id.unwrap_or(PROTO_NULL_U32),
            is_aggregate: f.is_aggregate,
            function_name: Some(Box::new(qualified_function_name(&f.function_name))),
            params: Some(
                f.params
                    .iter()
                    .map(|p| build!(FunctionParamT {
                        ast_node_id: p.ast_node_id.unwrap_or(PROTO_NULL_U32),
                        param_name: Some(p.param_name.text.to_string()),
                        param_type: Some(p.param_type.to_string()),
                    }))
                    .collect(),
            ),
            return_type: non_empty_str(&f.return_type),
        }))
        .collect();
    let visualization_specs = script
        .visualization_specs
        .iter()
        .map(|spec| {
            let (vegalite_spec, umap_spec, markdown_spec) = visualize(script, spec);
            build!(VisualizationSpecT {
                ast_node_id: spec.ast_node_id,
                ast_statement_id: spec.ast_statement_id.unwrap_or(PROTO_NULL_U32),
                source_kind: PackedVisSourceKind(spec.resolved_source.kind as u8),
                source_ast_node_id: spec.source_node_id.unwrap_or(PROTO_NULL_U32),
                source_inline_select_ast_node_id: spec.resolved_source.inline_select_ast_node_id.unwrap_or(PROTO_NULL_U32),
                renderer: spec.renderer.clone(),
                vegalite_spec,
                umap_spec,
                markdown_spec,
                dashboard: Some(Box::new(build!(DashboardSpecT {
                    row: spec.dashboard.row,
                    column: spec.dashboard.column,
                    width: spec.dashboard.width,
                    height: spec.dashboard.height,
                }))),
                table_spec: (spec.renderer.as_deref() == Some("table")).then(|| Box::new(TableSpecT::default())),
            })
        })
        .collect();
    let inferred_table_schemas = script
        .inferred_table_schemas
        .iter()
        .map(|schema| build!(InferredTableSchemaT {
            table_name: Some(Box::new(qualified_table_name(&schema.table_name))),
            confidence: dashql_buffers::analyzer::InferenceConfidence(schema.confidence as u8),
            columns: Some(
                schema
                    .columns
                    .iter()
                    .map(|c| build!(InferredColumnT {
                        column_name: Some(c.column_name.text.to_string()),
                        confidence: dashql_buffers::analyzer::InferenceConfidence(c.confidence as u8),
                        candidate_table_names: non_empty(c.candidate_table_names.iter().map(qualified_table_name).collect()),
                    }))
                    .collect(),
            ),
        }))
        .collect();
    build!(AnalyzedScriptT {
        catalog_entry_id: entry.catalog_entry_id,
        tables: Some(tables),
        table_references: Some(table_references),
        insert_statements: Some(insert_statements),
        resolved_table_references_by_id: Some(table_refs_by_id),
        expressions: Some(expressions),
        resolved_column_references_by_id: Some(column_refs_by_id),
        constant_expressions: Some(constant_expressions),
        name_scopes: Some(name_scopes),
        function_declarations: Some(function_declarations),
        visualization_specs: Some(visualization_specs),
        inferred_table_schemas: Some(inferred_table_schemas),
    })
}

/// The feature flags of a parsed script
pub fn has_visualize(parsed: &ParsedScript) -> bool {
    parsed.feature_flags & ParsedScriptFeature::VISUALIZE.0 != 0
}

/// Pack a cursor (`ScriptCursor::Pack`)
pub fn pack_cursor(cursor: &crate::cursor::ScriptCursor) -> dashql_buffers::cursor::ScriptCursorT {
    use crate::cursor::CursorContext;
    use dashql_buffers::cursor::{
        RelativeSymbolPosition, ScriptCursorColumnRefContextT, ScriptCursorContextT, ScriptCursorT, ScriptCursorTableRefContextT,
    };
    let mut out = ScriptCursorT::default();
    out.text_offset = cursor.text_offset as u32;
    match &cursor.scanner_location {
        Some(location) => {
            let target = &location.current;
            out.scanner_symbol_id = target.symbol_id;
            out.scanner_relative_position = target.relative_pos;
            out.scanner_symbol_offset = target.symbol.location.offset;
            out.scanner_symbol_kind = target.symbol.kind as u32;
            out.scanner_symbol_completable = crate::completion::is_symbol_kind_completable(target.symbol.kind);
        }
        None => {
            out.scanner_symbol_id = u32::MAX;
            out.scanner_relative_position = RelativeSymbolPosition::AFTER_SYMBOL;
            out.scanner_symbol_offset = 0;
            out.scanner_symbol_kind = 0;
            out.scanner_symbol_completable = false;
        }
    }
    out.statement_id = cursor.statement_id.unwrap_or(u32::MAX);
    out.ast_node_id = cursor.ast_node_id.unwrap_or(u32::MAX);
    out.ast_path_to_root = non_empty(cursor.ast_path_to_root.clone());
    out.name_scopes = non_empty(cursor.name_scopes.clone());
    out.context = match cursor.context {
        CursorContext::None => ScriptCursorContextT::NONE,
        CursorContext::TableRef { table_reference_id, .. } => {
            let mut ctx = ScriptCursorTableRefContextT::default();
            ctx.table_reference_id = table_reference_id;
            ScriptCursorContextT::ScriptCursorTableRefContext(Box::new(ctx))
        }
        CursorContext::ColumnRef { expression_id } => {
            let mut ctx = ScriptCursorColumnRefContextT::default();
            ctx.expression_id = expression_id;
            ScriptCursorContextT::ScriptCursorColumnRefContext(Box::new(ctx))
        }
    };
    out
}

/// Pack a completion (`Completion::Pack`)
pub fn pack_completion(completion: &crate::completion::Completion, upper_case_keywords: bool) -> dashql_buffers::completion::CompletionT {
    use crate::completion::CandidateObjectRef;
    use crate::utils::quote_identifier;
    use dashql_buffers::completion::{CompletionCandidateObjectT, CompletionCandidateObjectType, CompletionCandidateT, CompletionT};

    let candidates = completion
        .top_candidates
        .iter()
        .map(|candidate| {
            let upper_keyword = upper_case_keywords && candidate.keyword_symbol.is_some();
            let display_text = if upper_keyword {
                candidate.completion_text.to_ascii_uppercase()
            } else {
                candidate.completion_text.to_string()
            };
            let mut completion_text = if upper_keyword || candidate.completion_text_is_verbatim {
                display_text.clone()
            } else {
                quote_identifier(&candidate.completion_text)
            };
            let mut is_function = false;
            let catalog_objects = candidate
                .catalog_objects
                .iter()
                .map(|&co| {
                    let object = &completion.candidate_objects[co];
                    let mut o = CompletionCandidateObjectT::default();
                    o.object_type = CompletionCandidateObjectType(object.object.object_type() as u8);
                    o.candidate_tags = object.candidate_tags;
                    o.score = object.score;
                    o.qualified_name = Some(object.qualified_name.iter().map(|n| quote_identifier(n)).collect());
                    o.qualified_name_target_idx = object.qualified_name_target_idx as u32;
                    o.prefer_qualified = object.prefer_qualified;
                    match object.object {
                        CandidateObjectRef::Database(id) => o.catalog_database_id = id.unpack_database_id(),
                        CandidateObjectRef::Schema(id) => {
                            let (db, schema) = id.unpack_schema_id();
                            o.catalog_database_id = db;
                            o.catalog_schema_id = schema;
                        }
                        CandidateObjectRef::Table(loc) => {
                            if let Some(table) = completion.table(loc) {
                                let (db, schema) = table.catalog_schema_id.unpack_schema_id();
                                o.catalog_database_id = db;
                                o.catalog_schema_id = schema;
                                o.catalog_table_id = table.table_id().pack();
                                o.referenced_catalog_version = table.catalog_version;
                            }
                        }
                        CandidateObjectRef::Column(loc) => {
                            if let Some(table) = completion.table(loc.table) {
                                let (db, schema) = table.catalog_schema_id.unpack_schema_id();
                                let (table_id, column) = table.table_columns[loc.column as usize].object_id.unpack_table_column_id();
                                o.catalog_database_id = db;
                                o.catalog_schema_id = schema;
                                o.catalog_table_id = table_id.pack();
                                o.table_column_id = column;
                                o.referenced_catalog_version = table.catalog_version;
                            }
                        }
                        CandidateObjectRef::Function(loc) => {
                            is_function = true;
                            if let Some(f) = completion.entry_data(loc.entry).and_then(|d| d.function_declarations.get(loc.index as usize)) {
                                let (db, schema) = f.catalog_schema_id.unpack_schema_id();
                                o.catalog_database_id = db;
                                o.catalog_schema_id = schema;
                            }
                        }
                    }
                    o
                })
                .collect();
            if is_function {
                completion_text.push_str("()");
            }
            let mut c = CompletionCandidateT::default();
            c.completion_cursor_offset = (completion_text.len() - if is_function { 1 } else { 0 }) as u32;
            c.display_text = Some(display_text);
            c.completion_text = Some(completion_text);
            c.candidate_tags = candidate.candidate_tags;
            c.name_tags = candidate.coarse_name_tags;
            c.catalog_objects = Some(catalog_objects);
            c.score = candidate.score;
            c.target_location = Some(symbol_span(candidate.target_location));
            c.target_location_qualified = Some(symbol_span(candidate.target_location_qualified));
            c.keyword_continuation = candidate.keyword_continuation.filter(|k| !k.is_empty()).map(|k| {
                if upper_case_keywords {
                    k.to_ascii_uppercase()
                } else {
                    k.to_string()
                }
            });
            c
        })
        .collect();
    let mut out = CompletionT::default();
    out.cursor_offset = completion.cursor.text_offset as u32;
    out.dot_completion = completion.dot_completion;
    out.strategy = completion.strategy;
    out.candidates = Some(candidates);
    out
}

/// The renderer-specific packing of a visualization (the vegalite, umap and markdown branches of
/// `AnalyzedScript::Pack`)
#[allow(clippy::type_complexity)]
pub fn pack_visualization(
    script: &AnalyzedScript,
    spec: &VisualizationSpec,
) -> (Option<String>, Option<Box<dashql_buffers::visualization::UmapSpecT>>, Option<Box<dashql_buffers::visualization::MarkdownSpecT>>) {
    use crate::visualize;
    use dashql_buffers::visualization::{MarkdownSpec, UmapSpec};
    let renderer = spec.renderer.as_deref();
    let vegalite = (renderer == Some("vegalite"))
        .then(|| visualize::generate_vegalite_spec(spec, script))
        .filter(|json| !json.is_empty());
    let umap = (renderer == Some("umap")).then(|| visualize::compile_umap_spec(spec, script)).flatten().map(|doc| {
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = visualize::pack_umap_spec(&mut builder, &doc);
        builder.finish(packed, None);
        Box::new(flatbuffers::root::<UmapSpec>(builder.finished_data()).unwrap().unpack())
    });
    let markdown = (renderer == Some("markdown")).then(|| visualize::compile_markdown_spec(spec)).flatten().map(|doc| {
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = visualize::pack_markdown_spec(&mut builder, &doc);
        builder.finish(packed, None);
        Box::new(flatbuffers::root::<MarkdownSpec>(builder.finished_data()).unwrap().unpack())
    });
    (vegalite, umap, markdown)
}
