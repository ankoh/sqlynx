//! A port of the visualize snapshot encoders (`src/testing/visualize_snapshot_test.cc`).

use super::{plain, Map};
use crate::ryml::Node;
use dashql_buffers::visualization::MarkdownNodeType;
use dashql_core::analyzer::{AnalyzedScript, DashboardSpec};
use dashql_core::visualize::{MarkdownDocument, MarkdownNode, UmapDocument};

/// Analyze a script like the visualize snapshot test: the catalog script (if any) is analyzed and loaded with its
/// entry id as rank, then the main script is analyzed
pub fn analyze_scripts(catalog_input: Option<&str>, main_input: &str) -> Result<AnalyzedScript, String> {
    use dashql_core::catalog::Catalog;
    use dashql_grammar::parser::parse;
    use dashql_grammar::scanner::scan;
    use std::sync::Arc;

    let mut catalog = Catalog::new();
    let analyze_text = |catalog: &Catalog, text: &str| -> Result<AnalyzedScript, String> {
        let entry_id = catalog.allocate_entry_id();
        let parsed = Arc::new(parse(Arc::new(scan(text, 0, entry_id))));
        dashql_core::analyzer::analyze(parsed, catalog).map_err(|e| e.message)
    };
    if let Some(input) = catalog_input {
        let analyzed = analyze_text(&catalog, input)?;
        let rank = analyzed.catalog_entry_id();
        catalog.load_script(Arc::new(analyzed), rank).map_err(|e| e.message)?;
    }
    analyze_text(&catalog, main_input)
}

/// `MarkdownNodeName`
pub fn markdown_node_name(node_type: MarkdownNodeType) -> &'static str {
    match node_type {
        MarkdownNodeType::DOCUMENT => "document",
        MarkdownNodeType::PARAGRAPH => "paragraph",
        MarkdownNodeType::BLOCKQUOTE => "blockquote",
        MarkdownNodeType::LIST_ITEM => "listItem",
        MarkdownNodeType::EMPHASIS => "emphasis",
        MarkdownNodeType::STRONG => "strong",
        MarkdownNodeType::SPAN => "span",
        MarkdownNodeType::HEADING => "heading",
        MarkdownNodeType::LIST => "list",
        MarkdownNodeType::TEXT => "text",
        MarkdownNodeType::FIELD => "field",
        MarkdownNodeType::INLINE_CODE => "inlineCode",
        MarkdownNodeType::CODE_BLOCK => "codeBlock",
        MarkdownNodeType::LINK => "link",
        MarkdownNodeType::IMAGE => "image",
        MarkdownNodeType::HARD_BREAK => "hardBreak",
        MarkdownNodeType::THEMATIC_BREAK => "thematicBreak",
        _ => "none",
    }
}

/// `EncodeMarkdownNode`
fn encode_markdown_node(node: &MarkdownNode) -> Node {
    let mut map = Map::new();
    map.plain("type", markdown_node_name(node.node_type));
    match node.node_type {
        MarkdownNodeType::TEXT => {
            map.plain("value", &node.value);
        }
        MarkdownNodeType::FIELD => {
            map.plain("field", &node.value);
        }
        MarkdownNodeType::HEADING => {
            map.int("level", node.level as i64);
        }
        MarkdownNodeType::LIST => {
            map.boolean("ordered", node.ordered);
            map.boolean("tight", node.tight);
            if node.ordered {
                map.int("start", node.start as i64);
            }
        }
        MarkdownNodeType::LINK | MarkdownNodeType::IMAGE => {
            map.plain("url", &node.url);
            if !node.title.is_empty() {
                map.plain("title", &node.title);
            }
        }
        MarkdownNodeType::CODE_BLOCK if !node.language.is_empty() => {
            map.plain("language", &node.language);
        }
        _ => {}
    }
    if !node.children.is_empty() {
        map.insert("children", Node::seq(node.children.iter().map(encode_markdown_node).collect()));
    }
    map.into_node()
}

/// `EncodeMarkdownSpec`
pub fn encode_markdown_spec(spec: &MarkdownDocument) -> Node {
    let mut map = Map::new();
    // Multi-line templates are emitted as block literals
    if spec.template.contains('\n') {
        map.insert("template", Node::literal(spec.template.as_str()));
    } else {
        map.plain("template", &spec.template);
    }
    map.insert("fields", Node::seq(spec.fields.iter().map(|f| plain(f)).collect()));
    map.insert("document", encode_markdown_node(&spec.document));
    map.into_node()
}

/// `EncodeUmapSpec`
pub fn encode_umap_spec(spec: &UmapDocument) -> Node {
    let mut map = Map::new();
    map.plain("vector-column", &spec.vector_column);
    if !spec.category_column.is_empty() {
        map.plain("category-column", &spec.category_column);
    }
    if !spec.label_column.is_empty() {
        map.plain("label-column", &spec.label_column);
    }
    let mut projection = Map::new();
    projection.plain("method", "umap");
    if let Some(p) = &spec.projection {
        if !p.metric.is_empty() {
            projection.plain("metric", &p.metric);
        }
        if let Some(neighbors) = p.neighbors {
            projection.plain("neighbors", &super::analyzer::format_double(neighbors));
        }
        if let Some(min_dist) = p.min_dist {
            projection.plain("min-dist", &super::analyzer::format_double(min_dist));
        }
    }
    map.insert("projection", projection.into_node());
    map.into_node()
}

/// `EncodeDashboardSpec`
pub fn encode_dashboard_spec(spec: &DashboardSpec) -> Node {
    let mut map = Map::new();
    if let Some(row) = spec.row {
        map.int("row", row as i64);
    }
    if let Some(column) = spec.column {
        map.int("column", column as i64);
    }
    map.int("width", spec.width as i64);
    map.int("height", spec.height as i64);
    map.into_node()
}
