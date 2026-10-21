//! A port of `PlanViewModelSnapshotTest::EncodePlanViewModel` (`src/testing/plan_view_model_snapshot_test.cc`).

use super::{plain, Map};
use crate::ryml::Node;
use dashql_buffers::view as fb;

/// The layout config of `HyperPlanSnapshotTestSuite`
pub fn snapshot_config() -> fb::PlanLayoutConfig {
    let mut config = fb::PlanLayoutConfig::default();
    config.set_level_height(64.0);
    config.set_node_height(32.0);
    config.set_node_margin_horizontal(20.0);
    config.set_node_padding_left(8.0);
    config.set_node_padding_right(8.0);
    config.set_icon_width(14.0);
    config.set_icon_margin_right(8.0);
    config.set_max_label_chars(20);
    config.set_width_per_label_char(8.5);
    config.set_node_min_width(0.0);
    config
}

/// `std::to_string(double)`, which formats with `%f`
fn to_string(v: f64) -> String {
    format!("{v:.6}")
}

/// Encode an operator and its children depth-first
fn encode_operator(vm: &fb::PlanViewModel, oid: u32) -> Node {
    let op = vm.operators().unwrap().get(oid as usize);
    let strings = vm.string_dictionary().unwrap();
    let mut out = Map::new();
    out.plain("id", &op.operator_id().to_string());
    let parent_path = strings.get(op.parent_path() as usize);
    if !parent_path.is_empty() {
        out.plain("path", parent_path);
    }
    out.plain("type", strings.get(op.operator_type_name() as usize));
    if op.operator_label() != u32::MAX {
        let label = strings.get(op.operator_label() as usize);
        if !label.is_empty() {
            out.plain("label", label);
        }
    }
    let loc = op.source_location();
    if loc.length() > 0 {
        out.plain("loc", &format!("{}..{}", loc.offset(), loc.offset() + loc.length()));
    }
    if op.parent_operator_id() != u32::MAX {
        out.plain("parent", &op.parent_operator_id().to_string());
    }
    let rect = op.layout_rect();
    out.insert("position", Node::flow_seq(vec![plain(&to_string(rect.x())), plain(&to_string(rect.y()))]));
    if op.children_count() > 0 {
        let children = (0..op.children_count()).map(|i| encode_operator(vm, op.children_begin() + i)).collect();
        out.insert("children", Node::seq(children));
    }
    out.into_node()
}

/// Encode a packed plan view model like `EncodePlanViewModel`: the sections `fragments`, `operators`,
/// `operator-edges` and `pipelines`
pub fn encode_plan_view_model(buffer: &[u8]) -> Map {
    let vm = flatbuffers::root::<fb::PlanViewModel>(buffer).expect("valid plan view model");
    let roots = vm.root_operators().unwrap();
    let fragment_operators = vm.fragment_operators().unwrap();
    let pipeline_edges = vm.pipeline_edges().unwrap();
    let mut root = Map::new();

    let mut out_fragments = Vec::new();
    for fragment in vm.fragments().unwrap() {
        let mut out = Map::new();
        out.plain("id", &fragment.fragment_id().to_string());
        out.plain("anchor", &fragment.anchor_operator().to_string());
        let operators = (0..fragment.operator_count())
            .map(|i| plain(&fragment_operators.get((fragment.operators_begin() + i) as usize).to_string()))
            .collect();
        out.insert("operators", Node::flow_seq(operators));
        out_fragments.push(out.into_node());
    }
    root.insert("fragments", Node::seq(out_fragments));
    root.insert("operators", Node::seq(roots.iter().map(|r| encode_operator(&vm, r)).collect()));

    let mut out_edges = Vec::new();
    for edge in vm.operator_edges().unwrap() {
        let mut out = Map::new();
        out.plain("id", &edge.edge_id().to_string());
        out.plain("child", &edge.child_operator().to_string());
        out.plain("parent", &edge.parent_operator().to_string());
        out.plain("port-index", &edge.parent_operator_port_index().to_string());
        out.plain("port-count", &edge.parent_operator_port_count().to_string());
        out_edges.push(out.into_node());
    }
    root.insert("operator-edges", Node::seq(out_edges));

    let mut out_pipelines = Vec::new();
    for pipeline in vm.pipelines().unwrap() {
        let mut out = Map::new();
        out.plain("id", &pipeline.pipeline_id().to_string());
        let mut edges = Vec::new();
        for j in 0..pipeline.edge_count() {
            let edge = pipeline_edges.get((pipeline.edges_begin() + j) as usize);
            let mut out_edge = Map::new();
            out_edge.plain("id", &edge.edge_id().to_string());
            out_edge.plain("pipeline", &edge.pipeline_id().to_string());
            out_edge.plain("child", &edge.child_operator().to_string());
            out_edge.plain("parent", &edge.parent_operator().to_string());
            out_edge.plain("parent-breaks", if edge.parent_breaks_pipeline() == 1 { "true" } else { "false" });
            edges.push(out_edge.into_node());
        }
        out.insert("edges", Node::seq(edges));
        out_pipelines.push(out.into_node());
    }
    root.insert("pipelines", Node::seq(out_pipelines));
    root
}
