//! The visualize snapshots (snapshots/visualize/*.yaml), compared like the C++ `VisualizeSnapshotTestSuite`.
//!
//! Unlike the C++ suite, the Vega-Lite JSON and its round trip are also compared for the `table` renderer.

use dashql_core::visualize::{
    compile_markdown_spec, compile_umap_spec, generate_vegalite_spec, parse_vegalite_to_visualize,
};
use dashql_snapshots::encode::visualize::{
    analyze_scripts, encode_dashboard_spec, encode_markdown_spec, encode_umap_spec,
};
use dashql_snapshots::{compare, load_category, run, Arguments, Failed, Trial, Yaml};

/// Trim spaces and line breaks like the C++ suite (`trim_view(..., is_no_space)`)
fn trim(input: &str) -> String {
    input.trim_matches([' ', '\n']).to_string()
}

/// A block literal without trailing line breaks
fn expected_text(node: &Yaml) -> String {
    node.as_str().unwrap_or_default().trim_end_matches('\n').to_string()
}

fn run_case(node: &Yaml, name: &str) -> Result<(), String> {
    let catalog_input = node["catalog"]["script"]["input"].as_str().map(trim);
    let script_input = node["script"]["input"].as_str().map(trim).unwrap_or_default();
    let analyzed = analyze_scripts(catalog_input.as_deref(), &script_input)?;
    let spec = analyzed.visualization_specs.first().ok_or("no visualization spec")?;
    let renderer = spec.renderer.as_deref();

    if !matches!(node["dashboard"], Yaml::BadValue) {
        compare(&node["dashboard"], &encode_dashboard_spec(&spec.dashboard)).map_err(|e| format!("dashboard: {e}"))?;
    }

    if name == "vis_layer_resolve" {
        let counts: Vec<usize> = spec.layers.iter().map(|l| l.encoding_channels.len()).collect();
        if spec.encoding_channels.len() != 1 || counts != [2, 1] {
            let channels = spec.encoding_channels.len();
            return Err(format!("unexpected layers: {channels} channels, layer channels {counts:?}"));
        }
    }

    if renderer == Some("umap") {
        let umap = compile_umap_spec(spec, &analyzed).ok_or("no umap spec")?;
        if !matches!(node["umap"], Yaml::BadValue) {
            compare(&node["umap"], &encode_umap_spec(&umap)).map_err(|e| format!("umap: {e}"))?;
        }
        return Ok(());
    }
    if renderer == Some("markdown") {
        let markdown = compile_markdown_spec(spec).ok_or("no markdown spec")?;
        if !matches!(node["markdown"], Yaml::BadValue) {
            compare(&node["markdown"], &encode_markdown_spec(&markdown)).map_err(|e| format!("markdown: {e}"))?;
        }
        return Ok(());
    }

    let vegalite = generate_vegalite_spec(spec, &analyzed);
    let roundtrip = parse_vegalite_to_visualize(&vegalite);
    if vegalite.is_empty() || roundtrip.is_empty() {
        return Err("empty Vega-Lite spec or round trip".to_string());
    }
    if !matches!(node["vegalite"], Yaml::BadValue) {
        let expected = expected_text(&node["vegalite"]);
        if vegalite != expected {
            return Err(format!("vegalite differs\nexpected:\n{expected}\nactual:\n{vegalite}"));
        }
    }
    if !matches!(node["roundtrip"], Yaml::BadValue) {
        let expected = expected_text(&node["roundtrip"]);
        if roundtrip != expected {
            return Err(format!("roundtrip differs\nexpected:\n{expected}\nactual:\n{roundtrip}"));
        }
    }
    Ok(())
}

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();
    for case in load_category("visualize").expect("cannot load visualize snapshots") {
        trials.push(Trial::test(case.trial_name(), move || run_case(&case.node, &case.name).map_err(Failed::from)));
    }
    run(&args, trials).exit();
}
