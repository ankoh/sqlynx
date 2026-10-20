//! A port of the visualize snapshot encoders (`src/testing/visualize_snapshot_test.cc`) and the dump format of the
//! visualization oracle (`dashql_oracle::visualize`).

use super::{plain, Map};
use crate::ryml::Node;
use dashql_buffers::visualization::MarkdownNodeType;
use dashql_core::analyzer::{AnalyzedScript, DashboardSpec};
use dashql_core::visualize::{
    compile_markdown_spec, compile_umap_spec, generate_vegalite_spec, parse_vegalite_to_visualize, MarkdownDocument,
    MarkdownNode, UmapDocument,
};
use std::fmt::Write as _;

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

/// A double of the dump format, `inf` and `nan` like the C++ oracle
fn dump_double(d: f64) -> String {
    match d {
        d if d.is_nan() => "nan".to_string(),
        d if d.is_infinite() => if d < 0.0 { "-inf" } else { "inf" }.to_string(),
        d => dashql_core::utils::format_double(d),
    }
}

/// A length-prefixed string of the dump format
fn dump_string(out: &mut String, s: &str) {
    let _ = write!(out, "{}:{s}", s.len());
}

fn dump_markdown_node(out: &mut String, node: &MarkdownNode, depth: usize) {
    out.push_str(&" ".repeat(depth * 2));
    out.push_str(node.node_type.variant_name().unwrap_or("?"));
    for (key, value) in
        [(" value=", &node.value), (" url=", &node.url), (" title=", &node.title), (" language=", &node.language)]
    {
        out.push_str(key);
        dump_string(out, value);
    }
    let _ = writeln!(
        out,
        " level={} start={} ordered={} tight={}",
        node.level, node.start, node.ordered as u8, node.tight as u8
    );
    for child in &node.children {
        dump_markdown_node(out, child, depth + 1);
    }
}

/// The dump of a compiled Markdown spec (`DumpMarkdown` of the oracle)
pub fn dump_markdown(out: &mut String, markdown: Option<&MarkdownDocument>) {
    let Some(markdown) = markdown else {
        out.push_str("markdown: null\n");
        return;
    };
    out.push_str("markdown template=");
    dump_string(out, &markdown.template);
    let _ = write!(out, " fields={}", markdown.fields.len());
    for field in &markdown.fields {
        out.push(' ');
        dump_string(out, field);
    }
    out.push('\n');
    dump_markdown_node(out, &markdown.document, 1);
}

/// The dump of all visualization specs of a script (`dashql_oracle_visualize`)
pub fn dump_visualizations(script: &AnalyzedScript) -> String {
    let mut out = String::new();
    for (i, spec) in script.visualization_specs.iter().enumerate() {
        let _ = write!(out, "spec {i} renderer=");
        match &spec.renderer {
            Some(renderer) => dump_string(&mut out, renderer),
            None => out.push_str("null"),
        }
        let optional = |v: Option<i32>| v.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string());
        let d = &spec.dashboard;
        let _ = writeln!(out, " dashboard={},{},{},{}", optional(d.row), optional(d.column), d.width, d.height);

        let vegalite = generate_vegalite_spec(spec, script);
        out.push_str("vegalite ");
        dump_string(&mut out, &vegalite);
        out.push_str("\nroundtrip ");
        dump_string(&mut out, &parse_vegalite_to_visualize(&vegalite));
        out.push('\n');

        if spec.markdown.is_some() {
            dump_markdown(&mut out, compile_markdown_spec(spec).as_ref());
        }
        if spec.umap.is_some() {
            let umap = compile_umap_spec(spec, script).expect("umap spec");
            out.push_str("umap vector=");
            dump_string(&mut out, &umap.vector_column);
            out.push_str(" category=");
            dump_string(&mut out, &umap.category_column);
            out.push_str(" label=");
            dump_string(&mut out, &umap.label_column);
            if let Some(p) = &umap.projection {
                let _ = write!(out, " method={} metric=", p.method.0);
                dump_string(&mut out, &p.metric);
                let optional = |v: Option<f64>| v.map(dump_double).unwrap_or_else(|| "null".to_string());
                let _ = write!(out, " neighbors={} min_dist={}", optional(p.neighbors), optional(p.min_dist));
            }
            out.push('\n');
        }
    }
    out
}
