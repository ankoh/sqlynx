//! The parser: the grammar actions (`grammar/rules_rs`), the parse context, and the LALR(1) driver.

pub mod actions;
pub mod context;
pub mod driver;
pub mod enums;
pub mod value;

use crate::comment_blocks::{group_comments, CommentBlocks};
use crate::scanner::ScannedScript;
use crate::span::TextSpan;
pub use context::{ParseError, Statement};
use dashql_buffers::parser::{AttributeKey, Node, NodeType, ParsedScriptFeature};
use std::sync::Arc;

/// A parsed script
#[derive(Clone, Debug)]
pub struct ParsedScript {
    /// The scanned script, including the names that the parser registered
    pub scanned: Arc<ScannedScript>,
    /// The AST nodes in post-order
    pub nodes: Vec<Node>,
    /// The statements
    pub statements: Vec<Statement>,
    /// The parser errors
    pub errors: Vec<ParseError>,
    /// Symbol-index spans (begin, end) covering the bodies of vis specs
    pub vis_spec_spans: Vec<(u32, u32)>,
    /// Bitwise OR of ParsedScriptFeature values detected by the parser
    pub feature_flags: u32,
    /// The comments grouped into blocks
    pub comment_blocks: CommentBlocks,
}

/// Source spans and description comments of a statement (`ParsedScript::StatementDescription`)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatementDescription {
    /// The text of the statement root
    pub statement_span: TextSpan,
    /// The statement source, including the terminating semicolon and trailing comments on its line
    pub source_span: TextSpan,
    /// The description comments (a slice of the comments of the script)
    pub description_begin: u32,
    pub description_count: u32,
    /// The `@dashql:description` block among the description comments
    pub description_block: Option<u32>,
}

/// Only whitespace and semicolons
fn is_description_gap(text: &[u8], begin: usize, end: usize) -> bool {
    text[begin..end.max(begin)].iter().all(|c| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b';'))
}

/// The end of the statement source, including comments that trail its terminating semicolon on the
/// same line
fn statement_source_end(text: &[u8], sql_end: usize, limit: usize, comments: &[TextSpan]) -> usize {
    let mut end = sql_end;
    for comment in comments {
        let offset = comment.offset as usize;
        if offset < end || offset >= limit {
            continue;
        }
        if !is_description_gap(text, end, offset) {
            break;
        }
        if text[end..offset].iter().any(|&c| c == b'\n' || c == b'\r') {
            break;
        }
        end = comment.end() as usize;
    }
    end
}

/// A leading description comment must start on a fresh line when it follows prior SQL
fn is_leading_description_comment_gap(text: &[u8], previous_end: usize, comment: TextSpan) -> bool {
    let offset = comment.offset as usize;
    if !is_description_gap(text, previous_end, offset) {
        return false;
    }
    if previous_end == 0 || offset == 0 {
        return true;
    }
    text[previous_end..offset].iter().any(|&c| c == b'\n' || c == b'\r')
}

impl ParsedScript {
    /// Derive source spans and contiguous description comment blocks (`AssociateDescriptions`)
    pub fn associate_descriptions(&self) -> Vec<StatementDescription> {
        let scanned = &*self.scanned;
        let input = scanned.text.as_bytes();
        let comments = &scanned.comments;
        let resolve = |node: u32| context::resolve_text_span(&scanned.text, &scanned.symbols, *self.nodes[node as usize].symbol_span());
        let mut metadata = Vec::with_capacity(self.statements.len());

        // AST root spans exclude statement separators and comments. Extend each root to its first
        // following semicolon before the next statement's root.
        for (i, statement) in self.statements.iter().enumerate() {
            let root_span = resolve(statement.root);
            let mut end = root_span.end() as usize;
            let next_begin = match self.statements.get(i + 1) {
                Some(next) => resolve(next.root).offset as usize,
                None => input.len(),
            };
            let mut cursor = end;
            while cursor < next_begin {
                if let Some(comment) = comments.iter().find(|c| (c.offset as usize) <= cursor && cursor < c.end() as usize) {
                    cursor = comment.end() as usize;
                    continue;
                }
                if input[cursor] == b';' {
                    end = cursor + 1;
                    break;
                }
                cursor += 1;
            }
            let end = statement_source_end(input, end, next_begin, comments);
            metadata.push(StatementDescription {
                statement_span: root_span,
                source_span: TextSpan::new(root_span.offset, (end - root_span.offset as usize) as u32),
                ..Default::default()
            });
        }

        let mut comment_cursor = 0;
        let mut previous_end = 0;
        let mut block_cursor = 0;
        let blocks = &self.comment_blocks.blocks;
        for statement in metadata.iter_mut() {
            while comment_cursor < comments.len() && (comments[comment_cursor].offset as usize) < previous_end {
                comment_cursor += 1;
            }
            let mut begin = comment_cursor;
            let mut end = begin;
            let mut cursor = previous_end;
            while end < comments.len() && comments[end].offset < statement.source_span.offset {
                let comment = comments[end];
                let allowed = if end == begin {
                    is_leading_description_comment_gap(input, cursor, comment)
                } else {
                    is_description_gap(input, cursor, comment.offset as usize)
                };
                if !allowed {
                    begin = end + 1;
                }
                cursor = comment.end() as usize;
                end += 1;
            }
            if begin < end && is_description_gap(input, cursor, statement.source_span.offset as usize) {
                statement.description_begin = begin as u32;
                statement.description_count = (end - begin) as u32;
                // Blocks never straddle the description comments, find the last description block
                while block_cursor < blocks.len() && (blocks[block_cursor].comments_begin as usize) < begin {
                    block_cursor += 1;
                }
                while block_cursor < blocks.len() && (blocks[block_cursor].comments_begin as usize) < end {
                    if blocks[block_cursor].block_type == crate::comment_blocks::CommentBlockType::DASHQL_DESCRIPTION {
                        statement.description_block = Some(block_cursor as u32);
                    }
                    block_cursor += 1;
                }
            }
            previous_end = statement.source_span.end() as usize;
            comment_cursor = end;
        }
        metadata
    }
}

/// Parse a scanned script.
///
/// The parser registers names (keywords used as names) and may update the replacements of
/// obfuscated literals, so the returned parsed script owns an updated copy of the scanned script
/// unless `scanned` is not shared.
pub fn parse(scanned: Arc<ScannedScript>) -> ParsedScript {
    parse_with_options(scanned, true)
}

/// Parse a scanned script, optionally rejecting the VISUALISE syntax.
pub fn parse_with_options(scanned: Arc<ScannedScript>, enable_vis_syntax: bool) -> ParsedScript {
    let mut scanned = Arc::try_unwrap(scanned).unwrap_or_else(|shared| (*shared).clone());
    let names = std::mem::take(&mut scanned.names);
    let state = {
        let mut ctx = context::ParseContext::new(&scanned.text, &scanned.symbols, names, enable_vis_syntax);
        driver::parse(&mut ctx);
        ctx.into_state()
    };
    scanned.names = state.names;

    let comment_blocks = group_comments(&scanned.text, &scanned.comments);
    let mut feature_flags = 0;
    if state.nodes.iter().any(|n| n.node_type() == NodeType::OBJECT_VIS_VISUALISE) {
        feature_flags |= ParsedScriptFeature::VISUALIZE.0 as u32;
    }
    replace_obfuscated_cast_literals(&mut scanned, &state.nodes);
    ParsedScript {
        scanned: Arc::new(scanned),
        nodes: state.nodes,
        statements: state.statements,
        errors: state.errors,
        vis_spec_spans: state.vis_spec_spans,
        feature_flags,
        comment_blocks,
    }
}

/// Obfuscated strings that are cast to a type need a replacement that the type accepts, e.g.
/// `timestamptz /*String(A834)*/` cannot become `timestamptz 'A834'`.
fn replace_obfuscated_cast_literals(scanned: &mut ScannedScript, nodes: &[Node]) {
    if scanned.obfuscated_literals.is_empty() {
        return;
    }
    for node in nodes {
        if node.node_type() != NodeType::LITERAL_STRING || node.attribute_key() != AttributeKey::SQL_CONST_CAST_VALUE {
            continue;
        }
        let cast = nodes[node.parent() as usize];
        if !matches!(
            cast.node_type(),
            NodeType::OBJECT_SQL_CONST_TYPE_CAST | NodeType::OBJECT_SQL_CONST_FUNCTION_CAST | NodeType::OBJECT_SQL_CONST_INTERVAL_CAST
        ) {
            continue;
        }
        let literal_span = context::resolve_text_span(&scanned.text, &scanned.symbols, *node.symbol_span());
        let Ok(i) = scanned
            .obfuscated_literals
            .binary_search_by_key(&literal_span.offset, |l| l.location.offset)
        else {
            continue;
        };
        // The type is the text of the cast in front of the literal, e.g. "timestamp with time zone"
        let cast_span = context::resolve_text_span(&scanned.text, &scanned.symbols, *cast.symbol_span());
        let type_text = scanned.text[cast_span.offset as usize..literal_span.offset as usize].to_ascii_lowercase();
        let literal = &mut scanned.obfuscated_literals[i];
        let hash = literal.replacement[1..5].to_string();
        let has = |s: &str| type_text.contains(s);
        let replacement = if has("timestamp") {
            "'2000-01-01 00:00:00'".to_string()
        } else if has("date") {
            "'2000-01-01'".to_string()
        } else if has("time") {
            "'00:00:00'".to_string()
        } else if has("interval") {
            "'1'".to_string()
        } else if has("uuid") {
            format!("'00000000-0000-0000-0000-00000000{hash}'")
        } else if has("json") {
            "'{}'".to_string()
        } else if has("bool") {
            "'true'".to_string()
        } else if ["int", "numeric", "decimal", "real", "double", "float"].iter().any(|s| has(s)) {
            format!("'{}'", u32::from_str_radix(&hash, 16).unwrap_or(0))
        } else {
            continue;
        };
        literal.replacement = replacement;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::scan;

    fn parse_text(text: &str) -> ParsedScript {
        parse(Arc::new(scan(text, 0, 0)))
    }

    #[test]
    fn parses_select() {
        let parsed = parse_text("select 1");
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        assert_eq!(parsed.statements.len(), 1);
        let root = parsed.nodes[parsed.statements[0].root as usize];
        assert_eq!(root.node_type(), NodeType::OBJECT_SQL_SELECT);
    }

    #[test]
    fn reports_syntax_errors() {
        let parsed = parse_text("select * from foo select");
        assert_eq!(parsed.statements.len(), 0);
        assert_eq!(parsed.errors.len(), 1);
        assert!(parsed.errors[0].message.starts_with("syntax error, unexpected SELECT"), "{:?}", parsed.errors);
    }
}
