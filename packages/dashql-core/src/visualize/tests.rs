//! The `VisualizeTest` unit tests of `test/visualize_snapshot_test_suite.cc`.

use super::*;
use crate::analyzer::analyze;
use crate::catalog::Catalog;
use dashql_buffers::analyzer::{AnalyzerErrorSeverity, AnalyzerErrorType};
use dashql_grammar::parser::{parse, ParsedScript};
use dashql_grammar::scanner::scan;
use std::sync::Arc;

fn parse_text(catalog: &Catalog, text: &str) -> Arc<ParsedScript> {
    Arc::new(parse(Arc::new(scan(text, 0, catalog.allocate_entry_id()))))
}

fn analyze_text(text: &str) -> AnalyzedScript {
    let catalog = Catalog::new();
    analyze(parse_text(&catalog, text), &catalog).unwrap()
}

#[test]
fn select_source() {
    let analyzed = analyze_text("\nSELECT * FROM sales WHERE revenue > 0\nVISUALIZE USING vegalite (mark => bar)\n");
    assert!(!analyzed.visualization_specs.is_empty());
    let json = generate_vegalite_spec(&analyzed.visualization_specs[0], &analyzed);
    assert!(json.contains("SELECT * FROM sales WHERE revenue > 0"));
    assert!(!json.contains("visualize"));
}

#[test]
fn normalizes_dashboard_layout_with_warnings() {
    let text = "\nSELECT 1 AS value VISUALIZE USING vegalite (\n    mark => bar,\n    \
                dashboard => (row => -1, column => 15, width => 20, height => 0)\n)\n";
    let catalog = Catalog::new();
    let parsed = parse_text(&catalog, text);
    assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
    let analyzed = analyze(parsed, &catalog).unwrap();
    assert!(!analyzed.visualization_specs.is_empty());
    let dashboard = &analyzed.visualization_specs[0].dashboard;
    assert_eq!(dashboard.row, None);
    assert_eq!(dashboard.column, Some(0));
    assert_eq!(dashboard.width, 12);
    assert_eq!(dashboard.height, 1);
    assert_eq!(analyzed.errors.len(), 4);
    for warning in &analyzed.errors {
        assert_eq!(warning.error_type, AnalyzerErrorType::INVALID_DASHBOARD_LAYOUT);
        assert_eq!(warning.severity, AnalyzerErrorSeverity::WARNING);
    }
}

#[test]
fn rejects_dashboard_in_nested_vega_layer() {
    let catalog = Catalog::new();
    let parsed = parse_text(
        &catalog,
        "\nSELECT 1 AS value VISUALIZE USING vegalite (\n    layer => [(mark => bar, dashboard => (width => 6))]\n)\n",
    );
    assert!(!parsed.errors.is_empty());
}

#[test]
fn accepts_dashboard_for_every_renderer_root() {
    for renderer_spec in [
        "vegalite (mark => bar, dashboard => (width => 7))",
        "umap (vector => embedding, dashboard => (width => 7))",
        "markdown (template => '{{value}}', dashboard => (width => 7))",
        "table (dashboard => (width => 7))",
    ] {
        let catalog = Catalog::new();
        let parsed = parse_text(&catalog, &format!("SELECT value, embedding VISUALIZE USING {renderer_spec}"));
        assert!(parsed.errors.is_empty(), "{renderer_spec}: {:?}", parsed.errors);
        let analyzed = analyze(parsed, &catalog).unwrap();
        assert!(!analyzed.visualization_specs.is_empty());
        assert_eq!(analyzed.visualization_specs[0].dashboard.width, 7);
    }
}

#[test]
fn compiles_renderer_specs() {
    let analyzed = analyze_text(
        "SELECT embedding, cluster_id FROM t VISUALIZE USING umap (vector => embedding, category => cluster_id, \
         neighbors => 15, min_dist => 0.1, metric => cosine)",
    );
    let spec = &analyzed.visualization_specs[0];
    assert!(compile_markdown_spec(spec).is_none());
    let umap = compile_umap_spec(spec, &analyzed).unwrap();
    assert_eq!(umap.vector_column, "embedding");
    assert_eq!(umap.category_column, "cluster_id");
    assert_eq!(umap.label_column, "");
    let projection = umap.projection.as_ref().unwrap();
    assert_eq!(projection.metric, "cosine");
    assert_eq!(projection.neighbors, Some(15.0));
    assert_eq!(projection.min_dist, Some(0.1));

    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = pack_umap_spec(&mut builder, &umap);
    builder.finish(packed, None);
    let packed = flatbuffers::root::<dashql_buffers::visualization::UmapSpec>(builder.finished_data()).unwrap();
    assert_eq!(packed.vector_column(), Some("embedding"));
    assert_eq!(packed.label_column(), None);
    assert_eq!(packed.projection().unwrap().neighbors(), Some(15.0));

    let analyzed = analyze_text("SELECT 'item' AS product VISUALIZE USING markdown (template => '## {{product}}')");
    let spec = &analyzed.visualization_specs[0];
    assert!(compile_umap_spec(spec, &analyzed).is_none());
    let markdown = compile_markdown_spec(spec).unwrap();
    assert_eq!(markdown.template, "## {{product}}");
    assert_eq!(markdown.fields, vec!["product"]);
    assert_eq!(markdown.document.children.len(), 1);
}
