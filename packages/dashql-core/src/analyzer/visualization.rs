//! Analyze VISUALIZE statements (`analyze_visualization_pass.cc`).

use super::state::AnalysisState;
use super::types::*;
use dashql_buffers::analyzer::{AnalyzerErrorSeverity, AnalyzerErrorType};
use dashql_buffers::parser::{AttributeKey as K, Node, NodeType, VisFieldType, VisMarkType, VisScaleType};
use dashql_parser::attrs;
use std::ops::Range;

/// The state of a node
#[derive(Default)]
struct NodeState {
    /// The encoding channels collected in the subtree
    encoding_channels: Vec<VisEncodingChannel>,
    /// The mark type of the spec
    mark_type: Option<VisMarkType>,
    /// The structured mark definition, if the mark carries properties
    mark: Option<VisMark>,
    /// The chart title
    title: Option<String>,
    /// The nested Vega-Lite layer specifications
    layers: Vec<VegaLiteSpec>,
    /// The scale/axis/legend resolution settings
    resolve: Option<VisResolve>,
    /// The scale definition, taken by the enclosing field def
    scale: Option<VisScale>,
    /// The axis definition, taken by the enclosing field def
    axis: Option<VisAxis>,
    /// The legend definition, taken by the enclosing field def
    legend: Option<VisLegend>,
}

impl NodeState {
    fn merge_from(&mut self, other: &mut NodeState) {
        self.encoding_channels.append(&mut other.encoding_channels);
        if self.mark_type.is_none() && other.mark_type.is_some() {
            self.mark_type = other.mark_type;
        }
        if self.mark.is_none() && other.mark.is_some() {
            self.mark = other.mark.take();
        }
        if self.title.is_none() && other.title.is_some() {
            self.title = other.title.clone();
        }
        if self.layers.is_empty() && !other.layers.is_empty() {
            self.layers = std::mem::take(&mut other.layers);
        }
        if self.resolve.is_none() && other.resolve.is_some() {
            self.resolve = other.resolve.take();
        }
        if self.scale.is_none() && other.scale.is_some() {
            self.scale = other.scale.take();
        }
        if self.axis.is_none() && other.axis.is_some() {
            self.axis = other.axis.take();
        }
        if self.legend.is_none() && other.legend.is_some() {
            self.legend = other.legend.take();
        }
    }
}

fn read_text_value(state: &AnalysisState, node: Option<&Node>) -> Option<String> {
    let node = node?;
    match node.node_type() {
        NodeType::OBJECT_SQL_COLUMN_REF | NodeType::NAME => Some(state.text_at(*node.symbol_span()).to_string()),
        NodeType::LITERAL_STRING => Some(state.text_at(*node.symbol_span()).trim_matches('\'').to_string()),
        _ => None,
    }
}

fn read_unquoted_text_value(state: &AnalysisState, node: Option<&Node>) -> Option<String> {
    read_text_value(state, node).map(|t| t.trim_matches('\'').to_string())
}

fn read_sql_string_value(state: &AnalysisState, node: Option<&Node>) -> Option<String> {
    let node = node.filter(|n| n.node_type() == NodeType::LITERAL_STRING)?;
    let source = state.text_at(*node.symbol_span()).as_bytes();
    if source.len() < 2 || source[0] != b'\'' || source[source.len() - 1] != b'\'' {
        return None;
    }
    let mut decoded = Vec::with_capacity(source.len() - 2);
    let mut i = 1;
    while i + 1 < source.len() {
        if source[i] == b'\'' && i + 2 < source.len() && source[i + 1] == b'\'' {
            decoded.push(b'\'');
            i += 1;
        } else {
            decoded.push(source[i]);
        }
        i += 1;
    }
    Some(String::from_utf8_lossy(&decoded).into_owned())
}

fn read_numeric_value(state: &AnalysisState, node: Option<&Node>) -> Option<f64> {
    let node = node?;
    match node.node_type() {
        NodeType::LITERAL_INTEGER | NodeType::LITERAL_FLOAT | NodeType::OBJECT_SQL_NARY_EXPRESSION => {
            state.text_at(*node.symbol_span()).parse().ok()
        }
        _ => None,
    }
}

fn read_bool_value(state: &AnalysisState, node: Option<&Node>) -> Option<bool> {
    let node = node?;
    if node.node_type() == NodeType::BOOL {
        return Some(node.children_begin_or_value() != 0);
    }
    match read_text_value(state, Some(node))?.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// The name of a field-def key in the "unsupported key" warning
fn vis_field_def_key_name(key: K) -> Option<&'static str> {
    Some(match key {
        K::VIS_FIELD_DEF_SORT => "sort",
        K::VIS_FIELD_DEF_IMPUTE => "impute",
        K::VIS_FIELD_DEF_CONDITION => "condition",
        K::VIS_FIELD_DEF_TITLE => "title",
        K::VIS_FIELD_DEF_BAND_POSITION => "band_position",
        K::VIS_FIELD_DEF_DATUM => "datum",
        K::VIS_FIELD_DEF_VALUE => "value",
        K::VIS_FIELD_DEF_FORMAT => "format",
        K::VIS_FIELD_DEF_FORMAT_TYPE => "format_type",
        _ => return None,
    })
}

fn warn(state: &mut AnalysisState, error_type: AnalyzerErrorType, node: &Node, message: String) {
    let node_id = state.node_id(node);
    state.add_error(error_type, AnalyzerErrorSeverity::WARNING, node_id, message);
}

fn extract_dashboard_spec(state: &mut AnalysisState, node: &Node) -> DashboardSpec {
    let mut spec = DashboardSpec::default();
    let mut column_was_clamped = false;
    let [row, column, width, height] = attrs!(state.children(node), [
        K::VIS_DASHBOARD_ROW,
        K::VIS_DASHBOARD_COLUMN,
        K::VIS_DASHBOARD_WIDTH,
        K::VIS_DASHBOARD_HEIGHT,
    ]);
    const INVALID: AnalyzerErrorType = AnalyzerErrorType::INVALID_DASHBOARD_LAYOUT;
    if let Some(value) = read_numeric_value(state, row) {
        if value < 0.0 {
            warn(state, INVALID, row.unwrap(), "dashboard row must be non-negative and was removed".into());
        } else {
            spec.row = Some(value as i32);
        }
    }
    if let Some(value) = read_numeric_value(state, column) {
        if value < 0.0 {
            warn(state, INVALID, column.unwrap(), "dashboard column must be non-negative and was removed".into());
        } else {
            spec.column = Some(value.min(11.0) as i32);
            if value > 11.0 {
                column_was_clamped = true;
                warn(state, INVALID, column.unwrap(), "dashboard column was clamped to 11".into());
            }
        }
    }
    if let Some(value) = read_numeric_value(state, width) {
        spec.width = value.clamp(1.0, 12.0) as i32;
        if !(1.0..=12.0).contains(&value) {
            warn(state, INVALID, width.unwrap(), "dashboard width was clamped to the range 1..12".into());
        }
    }
    if let Some(value) = read_numeric_value(state, height) {
        if value < 1.0 {
            spec.height = 1;
            warn(state, INVALID, height.unwrap(), "dashboard height was clamped to 1".into());
        } else {
            spec.height = value as i32;
        }
    }
    if let Some(c) = spec.column {
        if c + spec.width > 12 {
            spec.column = Some(12 - spec.width);
            if !column_was_clamped {
                warn(
                    state,
                    INVALID,
                    column.unwrap(),
                    "dashboard column was moved so column + width does not exceed 12".into(),
                );
            }
        }
    }
    spec
}

/// Extract a mark definition from an OBJECT_VIS_MARK node
fn extract_vis_mark(state: &AnalysisState, node: &Node) -> VisMark {
    let mut mark = VisMark {
        ast_node_id: state.node_id(node),
        ..Default::default()
    };
    for child in state.children(node) {
        let c = Some(child);
        match child.attribute_key() {
            K::VIS_MARK_TYPE => {
                if child.node_type() == NodeType::ENUM_VIS_MARK_TYPE {
                    mark.mark_type = Some(VisMarkType(child.children_begin_or_value() as _));
                }
            }
            K::VIS_MARK_POINT => {
                if child.node_type() == NodeType::OBJECT_VIS_MARK {
                    mark.point = Some(Box::new(extract_vis_mark(state, child)));
                } else {
                    mark.point_enabled = read_bool_value(state, c);
                }
            }
            K::VIS_MARK_LINE => {
                if child.node_type() == NodeType::OBJECT_VIS_MARK {
                    mark.line = Some(Box::new(extract_vis_mark(state, child)));
                } else {
                    mark.line_enabled = read_bool_value(state, c);
                }
            }
            K::VIS_MARK_FILLED => mark.filled = read_bool_value(state, c),
            K::VIS_MARK_FILL => mark.fill = read_unquoted_text_value(state, c),
            K::VIS_MARK_STROKE => mark.stroke = read_unquoted_text_value(state, c),
            K::VIS_MARK_COLOR => mark.color = read_unquoted_text_value(state, c),
            K::VIS_MARK_OPACITY => mark.opacity = read_numeric_value(state, c),
            K::VIS_MARK_FILL_OPACITY => mark.fill_opacity = read_numeric_value(state, c),
            K::VIS_MARK_STROKE_OPACITY => mark.stroke_opacity = read_numeric_value(state, c),
            K::VIS_MARK_STROKE_WIDTH => mark.stroke_width = read_numeric_value(state, c),
            K::VIS_MARK_STROKE_DASH => mark.stroke_dash_node_id = Some(state.node_id(child)),
            K::VIS_MARK_SIZE => mark.size = read_numeric_value(state, c),
            K::VIS_MARK_SHAPE => mark.shape = read_unquoted_text_value(state, c),
            K::VIS_MARK_ANGLE => mark.angle = read_numeric_value(state, c),
            K::VIS_MARK_RADIUS => mark.radius = read_numeric_value(state, c),
            K::VIS_MARK_CORNER_RADIUS => mark.corner_radius = read_numeric_value(state, c),
            K::VIS_MARK_ORIENT => mark.orient = read_unquoted_text_value(state, c),
            K::VIS_MARK_INTERPOLATE => mark.interpolate = read_unquoted_text_value(state, c),
            K::VIS_MARK_TENSION => mark.tension = read_numeric_value(state, c),
            K::VIS_MARK_THICKNESS => mark.thickness = read_numeric_value(state, c),
            K::VIS_MARK_TOOLTIP => mark.tooltip = read_bool_value(state, c),
            _ => {}
        }
    }
    mark
}

fn read_column_expression_id(state: &AnalysisState, node: &Node) -> Option<u32> {
    state.expression_of(state.node_id(node))
}

fn extract_umap_spec(state: &AnalysisState, node: &Node) -> UmapSpec {
    let mut spec = UmapSpec {
        ast_node_id: state.node_id(node),
        ..Default::default()
    };
    for child in state.children(node) {
        match child.attribute_key() {
            K::VIS_UMAP_SPEC_VECTOR => spec.vector_expression_id = read_column_expression_id(state, child),
            K::VIS_UMAP_SPEC_CATEGORY => spec.category_expression_id = read_column_expression_id(state, child),
            K::VIS_UMAP_SPEC_LABEL => spec.label_expression_id = read_column_expression_id(state, child),
            K::VIS_UMAP_SPEC_METRIC => spec.projection.metric = read_text_value(state, Some(child)),
            K::VIS_UMAP_SPEC_NEIGHBORS => spec.projection.neighbors = read_numeric_value(state, Some(child)),
            K::VIS_UMAP_SPEC_MIN_DIST => spec.projection.min_dist = read_numeric_value(state, Some(child)),
            _ => {}
        }
    }
    spec
}

fn extract_markdown_spec(state: &AnalysisState, node: &Node) -> MarkdownSpec {
    let [template] = attrs!(state.children(node), [K::VIS_MARKDOWN_SPEC_TEMPLATE]);
    MarkdownSpec {
        ast_node_id: state.node_id(node),
        row_template: read_sql_string_value(state, template).unwrap_or_default(),
    }
}

/// Read the attributes of a scale object (shared by the pass and the nested spec extraction)
fn read_scale(state: &AnalysisState, node: &Node) -> VisScale {
    let [type_, domain, domain_min, domain_max, domain_mid, range, range_min, range_max, scheme, interpolate, nice, zero, clamp, padding, padding_inner, padding_outer, reverse, round, exponent, bins, name] =
        attrs!(state.children(node), [
            K::VIS_SCALE_TYPE,
            K::VIS_SCALE_DOMAIN,
            K::VIS_SCALE_DOMAIN_MIN,
            K::VIS_SCALE_DOMAIN_MAX,
            K::VIS_SCALE_DOMAIN_MID,
            K::VIS_SCALE_RANGE,
            K::VIS_SCALE_RANGE_MIN,
            K::VIS_SCALE_RANGE_MAX,
            K::VIS_SCALE_SCHEME,
            K::VIS_SCALE_INTERPOLATE,
            K::VIS_SCALE_NICE,
            K::VIS_SCALE_ZERO,
            K::VIS_SCALE_CLAMP,
            K::VIS_SCALE_PADDING,
            K::VIS_SCALE_PADDING_INNER,
            K::VIS_SCALE_PADDING_OUTER,
            K::VIS_SCALE_REVERSE,
            K::VIS_SCALE_ROUND,
            K::VIS_SCALE_EXPONENT,
            K::VIS_SCALE_BINS,
            K::VIS_SCALE_NAME,
        ]);
    let id = |n: Option<&Node>| n.map(|n| state.node_id(n));
    VisScale {
        ast_node_id: state.node_id(node),
        scale_type: type_
            .filter(|t| t.node_type() == NodeType::ENUM_VIS_SCALE_TYPE)
            .map(|t| VisScaleType(t.children_begin_or_value() as _)),
        domain_node_id: id(domain),
        domain_min_node_id: id(domain_min),
        domain_max_node_id: id(domain_max),
        domain_mid_node_id: id(domain_mid),
        range_node_id: id(range),
        range_min_node_id: id(range_min),
        range_max_node_id: id(range_max),
        scheme: read_text_value(state, scheme),
        interpolate: read_text_value(state, interpolate),
        nice: read_bool_value(state, nice),
        zero: read_bool_value(state, zero),
        clamp: read_bool_value(state, clamp),
        padding: read_numeric_value(state, padding),
        padding_inner: read_numeric_value(state, padding_inner),
        padding_outer: read_numeric_value(state, padding_outer),
        reverse: read_bool_value(state, reverse),
        round: read_bool_value(state, round),
        exponent: read_numeric_value(state, exponent),
        bins_node_id: id(bins),
        name: read_text_value(state, name),
        ..Default::default()
    }
}

/// Read the attributes of an axis object
fn read_axis(state: &AnalysisState, node: &Node) -> VisAxis {
    let [orient, format, format_type, grid, ticks, tick_count, tick_size, label_angle, label_font_size, label_overlap, direction, offset, values, zindex, title, domain, name] =
        attrs!(state.children(node), [
            K::VIS_AXIS_ORIENT,
            K::VIS_AXIS_FORMAT,
            K::VIS_AXIS_FORMAT_TYPE,
            K::VIS_AXIS_GRID,
            K::VIS_AXIS_TICKS,
            K::VIS_AXIS_TICK_COUNT,
            K::VIS_AXIS_TICK_SIZE,
            K::VIS_AXIS_LABEL_ANGLE,
            K::VIS_AXIS_LABEL_FONT_SIZE,
            K::VIS_AXIS_LABEL_OVERLAP,
            K::VIS_AXIS_DIRECTION,
            K::VIS_AXIS_OFFSET,
            K::VIS_AXIS_VALUES,
            K::VIS_AXIS_ZINDEX,
            K::VIS_AXIS_TITLE,
            K::VIS_AXIS_DOMAIN,
            K::VIS_AXIS_NAME,
        ]);
    VisAxis {
        ast_node_id: state.node_id(node),
        orient: read_text_value(state, orient),
        format: read_text_value(state, format),
        format_type: read_text_value(state, format_type),
        grid: read_bool_value(state, grid),
        ticks: read_bool_value(state, ticks),
        tick_count: read_numeric_value(state, tick_count),
        tick_size: read_numeric_value(state, tick_size),
        label_angle: read_numeric_value(state, label_angle),
        label_font_size: read_numeric_value(state, label_font_size),
        label_overlap: read_text_value(state, label_overlap),
        direction: read_text_value(state, direction),
        offset: read_numeric_value(state, offset),
        values_node_id: values.map(|n| state.node_id(n)),
        zindex: read_numeric_value(state, zindex).map(|v| v as i32),
        title: read_text_value(state, title),
        domain: read_bool_value(state, domain),
        name: read_text_value(state, name),
    }
}

/// Read the attributes of a legend object
fn read_legend(state: &AnalysisState, node: &Node) -> VisLegend {
    let [type_, orient, format, format_type, direction, title, values, padding, offset, zindex, name] =
        attrs!(state.children(node), [
            K::VIS_LEGEND_TYPE,
            K::VIS_LEGEND_ORIENT,
            K::VIS_LEGEND_FORMAT,
            K::VIS_LEGEND_FORMAT_TYPE,
            K::VIS_LEGEND_DIRECTION,
            K::VIS_LEGEND_TITLE,
            K::VIS_LEGEND_VALUES,
            K::VIS_LEGEND_PADDING,
            K::VIS_LEGEND_OFFSET,
            K::VIS_LEGEND_ZINDEX,
            K::VIS_LEGEND_NAME,
        ]);
    VisLegend {
        ast_node_id: state.node_id(node),
        legend_type: read_text_value(state, type_),
        orient: read_text_value(state, orient),
        format: read_text_value(state, format),
        format_type: read_text_value(state, format_type),
        direction: read_text_value(state, direction),
        title: read_text_value(state, title),
        values_node_id: values.map(|n| state.node_id(n)),
        padding: read_numeric_value(state, padding),
        offset: read_numeric_value(state, offset),
        zindex: read_numeric_value(state, zindex).map(|v| v as i32),
        name: read_text_value(state, name),
    }
}

/// The common attributes of a field def
fn read_field_def(state: &AnalysisState, node: &Node, channel: &mut VisEncodingChannel) -> Option<u32> {
    let [field, type_, bin, aggregate, time_unit, stack] = attrs!(state.children(node), [
        K::VIS_FIELD_DEF_FIELD,
        K::VIS_FIELD_DEF_TYPE,
        K::VIS_FIELD_DEF_BIN,
        K::VIS_FIELD_DEF_AGGREGATE,
        K::VIS_FIELD_DEF_TIME_UNIT,
        K::VIS_FIELD_DEF_STACK,
    ]);
    if let Some(t) = type_.filter(|t| t.node_type() == NodeType::ENUM_VIS_FIELD_TYPE) {
        channel.field_type = Some(VisFieldType(t.children_begin_or_value() as _));
    }
    if let Some(bin) = bin {
        channel.bin = Some(VisBin {
            ast_node_id: state.node_id(bin),
            ..Default::default()
        });
    }
    if aggregate.is_some() {
        channel.aggregate = read_text_value(state, aggregate);
    }
    if time_unit.is_some() {
        channel.time_unit = read_text_value(state, time_unit);
    }
    if let Some(stack) = stack {
        channel.stack_node_id = Some(state.node_id(stack));
    }
    field.map(|f| state.node_id(f))
}

/// Extract an encoding channel of a nested spec (`ExtractEncodingChannel`)
fn extract_encoding_channel(state: &AnalysisState, node: &Node) -> VisEncodingChannel {
    let mut channel = VisEncodingChannel {
        ast_node_id: state.node_id(node),
        channel_key: node.attribute_key(),
        ..Default::default()
    };
    if node.node_type() == NodeType::OBJECT_SQL_COLUMN_REF {
        channel.field_node_id = Some(state.node_id(node));
        return channel;
    }
    let field = read_field_def(state, node, &mut channel);
    let [scale, axis, legend] =
        attrs!(state.children(node), [K::VIS_FIELD_DEF_SCALE, K::VIS_FIELD_DEF_AXIS, K::VIS_FIELD_DEF_LEGEND]);
    channel.field_node_id = field;
    if let Some(scale) = scale.filter(|n| n.node_type() == NodeType::OBJECT_VIS_SCALE) {
        channel.scale = Some(read_scale(state, scale));
    }
    if let Some(axis) = axis.filter(|n| n.node_type() == NodeType::OBJECT_VIS_AXIS) {
        channel.axis = Some(read_axis(state, axis));
    }
    if let Some(legend) = legend.filter(|n| n.node_type() == NodeType::OBJECT_VIS_LEGEND) {
        channel.legend = Some(read_legend(state, legend));
    }
    channel
}

/// Extract a nested Vega-Lite spec (`ExtractVegaLiteSpec`)
fn extract_vega_lite_spec(state: &AnalysisState, node: &Node) -> VegaLiteSpec {
    let mut spec = VegaLiteSpec::default();
    let [mark, encoding, layer, resolve, title] = attrs!(state.children(node), [
        K::VIS_SPEC_MARK,
        K::VIS_SPEC_ENCODING,
        K::VIS_SPEC_LAYER,
        K::VIS_SPEC_RESOLVE,
        K::VIS_SPEC_TITLE,
    ]);
    if let Some(mark) = mark {
        if mark.node_type() == NodeType::ENUM_VIS_MARK_TYPE {
            spec.mark_type = Some(VisMarkType(mark.children_begin_or_value() as _));
        } else if mark.node_type() == NodeType::OBJECT_VIS_MARK {
            let m = extract_vis_mark(state, mark);
            spec.mark_type = m.mark_type;
            spec.mark = Some(m);
        }
    }
    if let Some(encoding) = encoding.filter(|n| n.node_type() == NodeType::OBJECT_VIS_ENCODING) {
        for child in state.children(encoding) {
            let key = child.attribute_key().0;
            if key >= K::VIS_ENCODING_X.0
                && key <= K::VIS_ENCODING_Y_OFFSET.0
                && (child.node_type() == NodeType::OBJECT_VIS_FIELD_DEF || child.node_type() == NodeType::OBJECT_SQL_COLUMN_REF)
            {
                spec.encoding_channels.push(extract_encoding_channel(state, child));
            }
        }
    }
    if let Some(layer) = layer.filter(|n| n.node_type() == NodeType::OBJECT_EXT_VARARG_ARRAY) {
        let [values] = attrs!(state.children(layer), [K::EXT_VARARG_ARRAY_VALUES]);
        if let Some(values) = values.filter(|n| n.node_type() == NodeType::ARRAY) {
            for child in state.children(values) {
                if child.node_type() == NodeType::OBJECT_VIS_SPEC {
                    spec.layers.push(extract_vega_lite_spec(state, child));
                }
            }
        }
    }
    if let Some(resolve) = resolve.filter(|n| n.node_type() == NodeType::OBJECT_VIS_SPEC) {
        let [scale, axis, legend] =
            attrs!(state.children(resolve), [K::VIS_RESOLVE_SCALE, K::VIS_RESOLVE_AXIS, K::VIS_RESOLVE_LEGEND]);
        spec.resolve = Some(VisResolve {
            scale_node_id: scale.map(|n| state.node_id(n)),
            axis_node_id: axis.map(|n| state.node_id(n)),
            legend_node_id: legend.map(|n| state.node_id(n)),
        });
    }
    spec.title = read_text_value(state, title);
    spec
}

/// The pass that extracts the visualization specs of VISUALIZE statements (`AnalyzeVisualizationPass`)
pub(super) struct AnalyzeVisualizationPass {
    /// The node states, only allocated for nodes that carry visualization state
    node_states: Vec<Option<Box<NodeState>>>,
    /// The visualization specs, moved to the output during finish
    collected_specs: Vec<VisualizationSpec>,
}

impl AnalyzeVisualizationPass {
    pub fn new(state: &AnalysisState) -> Self {
        let mut node_states = Vec::with_capacity(state.ast.len());
        node_states.resize_with(state.ast.len(), || None);
        Self {
            node_states,
            collected_specs: Vec::new(),
        }
    }

    /// Merge the states of the children into a state. A missing state is empty, and merging into an
    /// empty state takes over the child state.
    fn merge_child_states(&mut self, dst: &mut Option<Box<NodeState>>, node: &Node) {
        let begin = node.children_begin_or_value() as usize;
        for child in begin..begin + node.children_count() as usize {
            let Some(mut child_state) = self.node_states[child].take() else { continue };
            match dst {
                None => *dst = Some(child_state),
                Some(dst) => dst.merge_from(&mut child_state),
            }
        }
    }

    pub fn visit(&mut self, state: &mut AnalysisState, morsel: Range<usize>) {
        for node_id in morsel {
            let node = &state.ast[node_id];
            // Most nodes have no visualization state: skip nodes without children quickly
            if node.children_count() == 0 && !Self::produces_state(node) {
                continue;
            }
            let mut node_state = self.node_states[node_id].take();
            self.visit_node(state, node, node_id as u32, &mut node_state);
            self.node_states[node_id] = node_state;
        }
    }

    /// Does a node create visualization state on its own?
    fn produces_state(node: &Node) -> bool {
        matches!(
            node.node_type(),
            NodeType::OBJECT_VIS_SCALE
                | NodeType::OBJECT_VIS_AXIS
                | NodeType::OBJECT_VIS_LEGEND
                | NodeType::OBJECT_VIS_FIELD_DEF
                | NodeType::OBJECT_VIS_ENCODING
                | NodeType::OBJECT_VIS_SPEC
                | NodeType::OBJECT_VIS_VISUALISE
        )
    }

    fn visit_node(&mut self, state: &mut AnalysisState, node: &Node, node_id: u32, slot: &mut Option<Box<NodeState>>) {
        let node_type = node.node_type();
        if !Self::produces_state(node) {
            self.merge_child_states(slot, node);
            return;
        }
        if node_type == NodeType::OBJECT_VIS_SPEC && node.attribute_key() != K::VIS_VISUALISE_SPEC {
            return;
        }
        let node_state = slot.get_or_insert_with(Default::default);
        let node_state: &mut NodeState = node_state;
        match node_type {
            NodeType::OBJECT_VIS_SCALE => node_state.scale = Some(read_scale(state, node)),
            NodeType::OBJECT_VIS_AXIS => node_state.axis = Some(read_axis(state, node)),
            NodeType::OBJECT_VIS_LEGEND => node_state.legend = Some(read_legend(state, node)),

            NodeType::OBJECT_VIS_FIELD_DEF => {
                self.merge_into(node_state, node);
                let mut channel = VisEncodingChannel {
                    ast_node_id: node_id,
                    channel_key: node.attribute_key(),
                    scale: node_state.scale.take(),
                    axis: node_state.axis.take(),
                    legend: node_state.legend.take(),
                    ..Default::default()
                };
                if let Some(field) = read_field_def(state, node, &mut channel) {
                    channel.field_expression_id = state.expression_of(field);
                }
                // Warn about field-def keys that the grammar accepts but the spec drops
                for child in state.children(node) {
                    if let Some(key_name) = vis_field_def_key_name(child.attribute_key()) {
                        let message = format!("{key_name} is not yet supported and will be ignored");
                        warn(state, AnalyzerErrorType::UNSUPPORTED_VIS_KEY, child, message);
                    }
                }
                node_state.encoding_channels.push(channel);
            }

            NodeType::OBJECT_VIS_ENCODING => {
                self.merge_into(node_state, node);
                // Shorthand encoding values (direct column refs as children)
                for child in state.children(node) {
                    let key = child.attribute_key().0;
                    if child.attribute_key() == K::NONE || key < K::VIS_ENCODING_X.0 || key > K::VIS_ENCODING_Y_OFFSET.0 {
                        continue;
                    }
                    if child.node_type() == NodeType::OBJECT_SQL_COLUMN_REF {
                        let child_id = state.node_id(child);
                        node_state.encoding_channels.push(VisEncodingChannel {
                            ast_node_id: child_id,
                            channel_key: child.attribute_key(),
                            field_expression_id: state.expression_of(child_id),
                            ..Default::default()
                        });
                    }
                }
            }

            NodeType::OBJECT_VIS_SPEC => {
                self.merge_into(node_state, node);
                let [mark, layer, resolve, title] =
                    attrs!(state.children(node), [K::VIS_SPEC_MARK, K::VIS_SPEC_LAYER, K::VIS_SPEC_RESOLVE, K::VIS_SPEC_TITLE]);
                if let Some(mark) = mark {
                    if mark.node_type() == NodeType::ENUM_VIS_MARK_TYPE {
                        node_state.mark_type = Some(VisMarkType(mark.children_begin_or_value() as _));
                    } else if mark.node_type() == NodeType::OBJECT_VIS_MARK {
                        let m = extract_vis_mark(state, mark);
                        node_state.mark_type = m.mark_type;
                        node_state.mark = Some(m);
                    }
                }
                if layer.is_some() || resolve.is_some() {
                    let composed = extract_vega_lite_spec(state, node);
                    node_state.layers = composed.layers;
                    node_state.resolve = composed.resolve;
                }
                node_state.title = read_text_value(state, title);
            }

            NodeType::OBJECT_VIS_VISUALISE => {
                self.merge_into(node_state, node);
                let [select, spec_node, using] =
                    attrs!(state.children(node), [K::VIS_VISUALISE_SELECT, K::VIS_VISUALISE_SPEC, K::VIS_VISUALISE_USING]);
                let mut spec = VisualizationSpec {
                    ast_node_id: node_id,
                    renderer: using.and_then(|u| read_text_value(state, Some(u))),
                    mark_type: node_state.mark_type,
                    mark: node_state.mark.take(),
                    title: node_state.title.clone(),
                    encoding_channels: std::mem::take(&mut node_state.encoding_channels),
                    layers: std::mem::take(&mut node_state.layers),
                    resolve: node_state.resolve.take(),
                    ..Default::default()
                };
                if let Some(spec_node) = spec_node {
                    match spec_node.node_type() {
                        NodeType::OBJECT_VIS_UMAP_SPEC => spec.umap = Some(extract_umap_spec(state, spec_node)),
                        NodeType::OBJECT_VIS_MARKDOWN_SPEC => spec.markdown = Some(extract_markdown_spec(state, spec_node)),
                        _ => {}
                    }
                    let [dashboard] = attrs!(state.children(spec_node), [K::VIS_SPEC_DASHBOARD]);
                    if let Some(dashboard) = dashboard.filter(|n| n.node_type() == NodeType::OBJECT_VIS_DASHBOARD_SPEC) {
                        spec.dashboard = extract_dashboard_spec(state, dashboard);
                    }
                }
                spec.source_node_id = select.map(|s| state.node_id(s));
                self.collected_specs.push(spec);
            }

            _ => unreachable!(),
        }
    }

    /// Merge the states of the children into an existing state
    fn merge_into(&mut self, dst: &mut NodeState, node: &Node) {
        let begin = node.children_begin_or_value() as usize;
        for child in begin..begin + node.children_count() as usize {
            if let Some(mut child_state) = self.node_states[child].take() {
                dst.merge_from(&mut child_state);
            }
        }
    }

    pub fn finish(&mut self, state: &mut AnalysisState) {
        let statements = &state.parsed.statements;
        for spec in self.collected_specs.iter_mut() {
            spec.ast_statement_id = statements
                .iter()
                .position(|s| spec.ast_node_id >= s.nodes_begin && spec.ast_node_id < s.nodes_begin + s.node_count)
                .map(|i| i as u32);
            if let Some(source) = spec.source_node_id {
                if state.ast[source as usize].node_type() == NodeType::OBJECT_SQL_SELECT {
                    spec.resolved_source.kind = VisSourceKind::InlineSelect;
                    spec.resolved_source.inline_select_ast_node_id = Some(source);
                }
            }
        }
        state.out.visualization_specs.append(&mut self.collected_specs);
    }
}
