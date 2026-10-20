//! The parser snapshot encoder (`ParserSnapshotTest::EncodeScript`).

use super::{encode_location_range, encode_location_text, Map};
use dashql_buffers::parser::{CommentBlockType, Node, NodeType, StatementType};
use dashql_grammar::parser::context::resolve_text_span;
use dashql_grammar::parser::enums::enum_text;
use dashql_grammar::parser::ParsedScript;
use dashql_grammar::span::TextSpan;
use yaml_rust2::Yaml;

fn enum_name(name: Option<&'static str>) -> &'static str {
    name.unwrap_or("")
}

/// Encode an AST node and its children
fn encode_node(parsed: &ParsedScript, text: &str, node_id: usize) -> Yaml {
    let scanned = &*parsed.scanned;
    let node: &Node = &parsed.nodes[node_id];
    let resolve = |n: &Node| -> TextSpan { resolve_text_span(&scanned.text, &scanned.symbols, *n.symbol_span()) };
    let mut map = Map::new();
    if node.attribute_key().0 != 0 {
        map.plain("key", enum_name(node.attribute_key().variant_name()));
    }
    map.plain("type", enum_name(node.node_type().variant_name()));
    let children = |map: &mut Map| {
        let begin = node.children_begin_or_value() as usize;
        let items = (0..node.children_count() as usize).map(|i| encode_node(parsed, text, begin + i)).collect();
        map.insert("children", Yaml::Array(items));
    };
    match node.node_type() {
        NodeType::NONE => {}
        NodeType::BOOL => {
            map.int("value", (node.children_begin_or_value() != 0) as i64);
        }
        NodeType::OPERATOR
        | NodeType::NAME
        | NodeType::LITERAL_NULL
        | NodeType::LITERAL_FLOAT
        | NodeType::LITERAL_INTEGER
        | NodeType::LITERAL_INTERVAL
        | NodeType::LITERAL_STRING => {
            let span = resolve(node);
            encode_location_text(&mut map, text, span.offset, span.length, "text");
        }
        NodeType::ARRAY => {
            let span = resolve(node);
            encode_location_text(&mut map, text, span.offset, span.length, "text");
            children(&mut map);
        }
        t if t.0 > NodeType::OBJECT_KEYS_.0 => {
            let span = resolve(node);
            encode_location_text(&mut map, text, span.offset, span.length, "text");
            children(&mut map);
        }
        t if t.0 > NodeType::ENUM_KEYS_.0 => {
            map.plain("value", enum_text(node));
        }
        _ => {
            map.int("value", node.children_begin_or_value() as i64);
        }
    }
    map.into_yaml()
}

/// Encode a parsed script like the parser snapshots expect it
pub fn encode_script(parsed: &ParsedScript, text: &str) -> Yaml {
    let scanned = &*parsed.scanned;
    let descriptions = parsed.associate_descriptions();
    let mut root = Map::new();

    let mut statements = Vec::new();
    for (statement, description) in parsed.statements.iter().zip(&descriptions) {
        let mut s = Map::new();
        s.plain("type", enum_name(StatementType::variant_name(statement.statement_type)));
        s.int("ast-begin", statement.nodes_begin as i64);
        s.int("ast-size", statement.node_count as i64);
        let mut d = Map::new();
        encode_location_text(&mut d, text, description.source_span.offset, description.source_span.length, "text");
        d.int("description-begin", description.description_begin as i64);
        d.int("description-count", description.description_count as i64);
        if let Some(block) = description.description_block {
            d.int("description-block", block as i64);
        }
        s.insert("description", d.into_yaml());
        s.insert("ast", encode_node(parsed, text, statement.root as usize));
        statements.push(s.into_yaml());
    }
    root.insert("statements", Yaml::Array(statements));

    let scanner_errors = scanned
        .errors
        .iter()
        .map(|e| {
            let mut m = Map::new();
            m.plain("message", &e.message);
            encode_location_text(&mut m, text, e.location.offset, e.location.length, "text");
            m.into_yaml()
        })
        .collect();
    root.insert("scanner-errors", Yaml::Array(scanner_errors));

    let parser_errors = parsed
        .errors
        .iter()
        .map(|e| {
            let mut m = Map::new();
            m.plain("message", &e.message);
            let span = resolve_text_span(&scanned.text, &scanned.symbols, e.location);
            encode_location_text(&mut m, text, span.offset, span.length, "text");
            if !e.hint.is_empty() {
                m.plain("hint", &e.hint);
            }
            m.into_yaml()
        })
        .collect();
    root.insert("parser-errors", Yaml::Array(parser_errors));

    let line_breaks = scanned
        .line_breaks
        .iter()
        .map(|lb| {
            let mut m = Map::new();
            encode_location_range(&mut m, lb.offset, lb.length, "text");
            m.into_yaml()
        })
        .collect();
    root.insert("line-breaks", Yaml::Array(line_breaks));

    let comments = scanned
        .comments
        .iter()
        .map(|c| {
            let mut m = Map::new();
            encode_location_text(&mut m, text, c.offset, c.length, "text");
            m.into_yaml()
        })
        .collect();
    root.insert("comments", Yaml::Array(comments));

    let blocks = &parsed.comment_blocks;
    let comment_blocks = blocks
        .blocks
        .iter()
        .map(|b| {
            let mut m = Map::new();
            m.plain("type", enum_name(CommentBlockType::variant_name(b.block_type)));
            encode_location_text(&mut m, text, b.text_span.offset, b.text_span.length, "text");
            if b.tag_span.length > 0 {
                encode_location_text(&mut m, text, b.tag_span.offset, b.tag_span.length, "tag");
            }
            m.insert(
                "comments",
                Yaml::Array(vec![Yaml::Integer(b.comments_begin as i64), Yaml::Integer(b.comments_count as i64)]),
            );
            let lines = (0..b.lines_count as usize)
                .map(|i| {
                    let line = blocks.lines[b.lines_begin as usize + i];
                    let bytes = &text.as_bytes()[line.offset as usize..line.end() as usize];
                    Yaml::String(String::from_utf8_lossy(bytes).into_owned())
                })
                .collect();
            m.insert("lines", Yaml::Array(lines));
            m.into_yaml()
        })
        .collect();
    root.insert("comment-blocks", Yaml::Array(comment_blocks));
    if let Some(block) = blocks.metadata_block {
        root.int("metadata-block", block as i64);
    }
    let warnings = blocks
        .warnings
        .iter()
        .map(|(span, message)| {
            let mut m = Map::new();
            m.plain("message", message);
            encode_location_text(&mut m, text, span.offset, span.length, "text");
            m.into_yaml()
        })
        .collect();
    root.insert("comment-warnings", Yaml::Array(warnings));
    root.into_yaml()
}
