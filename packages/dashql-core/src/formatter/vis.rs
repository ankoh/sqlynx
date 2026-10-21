//! VISUALIZE statements (`formatter/formatter_vis.cc`).

use dashql_parser::attrs;
use super::{FmtReg, Formatter, FormattingJoinPolicy, K};
use dashql_buffers::formatting::FormattingMode;
use dashql_buffers::parser::{AttributeKey, Node, NodeType, VisFieldType, VisMarkType, VisScaleType};

fn get_vis_attribute_key_text(key: AttributeKey) -> &'static str {
    match key {
        K::VIS_SPEC_MARK => "mark",
        K::VIS_SPEC_ENCODING => "encoding",
        K::VIS_SPEC_LAYER => "layer",
        K::VIS_SPEC_DATA => "data",
        K::VIS_SPEC_TRANSFORM => "transform",
        K::VIS_SPEC_PARAMS => "params",
        K::VIS_SPEC_PROJECTION => "projection",
        K::VIS_SPEC_AUTOSIZE => "autosize",
        K::VIS_SPEC_RESOLVE => "resolve",
        K::VIS_SPEC_DATASETS => "datasets",
        K::VIS_SPEC_VIEW => "view",
        K::VIS_SPEC_NAME => "name",
        K::VIS_SPEC_TITLE => "title",
        K::VIS_SPEC_DASHBOARD => "dashboard",
        K::VIS_SPEC_PADDING => "padding",
        K::VIS_SPEC_BACKGROUND => "background",
        K::VIS_SPEC_FILTER => "filter",
        K::VIS_SPEC_DESCRIPTION => "describe",
        K::VIS_SPEC_TYPE => "type",
        K::VIS_RESOLVE_SCALE => "scale",
        K::VIS_RESOLVE_AXIS => "axis",
        K::VIS_RESOLVE_LEGEND => "legend",
        K::VIS_ENCODING_X => "x",
        K::VIS_ENCODING_Y => "y",
        K::VIS_ENCODING_X2 => "x2",
        K::VIS_ENCODING_Y2 => "y2",
        K::VIS_ENCODING_COLOR => "color",
        K::VIS_ENCODING_FILL => "fill",
        K::VIS_ENCODING_STROKE => "stroke",
        K::VIS_ENCODING_FILL_OPACITY => "fill_opacity",
        K::VIS_ENCODING_STROKE_OPACITY => "stroke_opacity",
        K::VIS_ENCODING_STROKE_WIDTH => "stroke_width",
        K::VIS_ENCODING_STROKE_DASH => "stroke_dash",
        K::VIS_ENCODING_OPACITY => "opacity",
        K::VIS_ENCODING_SIZE => "size",
        K::VIS_ENCODING_SHAPE => "shape",
        K::VIS_ENCODING_ANGLE => "angle",
        K::VIS_ENCODING_THETA => "theta",
        K::VIS_ENCODING_THETA2 => "theta2",
        K::VIS_ENCODING_RADIUS => "radius",
        K::VIS_ENCODING_RADIUS2 => "radius2",
        K::VIS_ENCODING_DETAIL => "detail",
        K::VIS_ENCODING_ORDER => "order",
        K::VIS_ENCODING_TOOLTIP => "tooltip",
        K::VIS_ENCODING_TEXT => "text",
        K::VIS_ENCODING_ROW => "row",
        K::VIS_ENCODING_COLUMN => "column",
        K::VIS_ENCODING_FACET => "facet",
        K::VIS_ENCODING_HREF => "href",
        K::VIS_ENCODING_URL => "url",
        K::VIS_ENCODING_KEY => "key",
        K::VIS_ENCODING_LATITUDE => "latitude",
        K::VIS_ENCODING_LONGITUDE => "longitude",
        K::VIS_ENCODING_LATITUDE2 => "latitude2",
        K::VIS_ENCODING_LONGITUDE2 => "longitude2",
        K::VIS_ENCODING_X_OFFSET => "x_offset",
        K::VIS_ENCODING_Y_OFFSET => "y_offset",
        K::VIS_FIELD_DEF_FIELD => "field",
        K::VIS_FIELD_DEF_TYPE => "type",
        K::VIS_FIELD_DEF_BIN => "bin",
        K::VIS_FIELD_DEF_AGGREGATE => "aggregate",
        K::VIS_FIELD_DEF_TIME_UNIT => "time_unit",
        K::VIS_FIELD_DEF_SCALE => "scale",
        K::VIS_FIELD_DEF_AXIS => "axis",
        K::VIS_FIELD_DEF_LEGEND => "legend",
        K::VIS_FIELD_DEF_SORT => "sort",
        K::VIS_FIELD_DEF_STACK => "stack",
        K::VIS_FIELD_DEF_IMPUTE => "impute",
        K::VIS_FIELD_DEF_CONDITION => "condition",
        K::VIS_FIELD_DEF_TITLE => "title",
        K::VIS_FIELD_DEF_BAND_POSITION => "band_position",
        K::VIS_FIELD_DEF_DATUM => "datum",
        K::VIS_FIELD_DEF_VALUE => "value",
        K::VIS_FIELD_DEF_FORMAT => "format",
        K::VIS_FIELD_DEF_FORMAT_TYPE => "format_type",
        K::VIS_SCALE_TYPE => "type",
        K::VIS_SCALE_DOMAIN => "domain",
        K::VIS_SCALE_DOMAIN_MIN => "domain_min",
        K::VIS_SCALE_DOMAIN_MAX => "domain_max",
        K::VIS_SCALE_DOMAIN_MID => "domain_mid",
        K::VIS_SCALE_RANGE => "range",
        K::VIS_SCALE_RANGE_MIN => "range_min",
        K::VIS_SCALE_RANGE_MAX => "range_max",
        K::VIS_SCALE_SCHEME => "scheme",
        K::VIS_SCALE_INTERPOLATE => "interpolate",
        K::VIS_SCALE_NICE => "nice",
        K::VIS_SCALE_ZERO => "zero",
        K::VIS_SCALE_CLAMP => "clamp",
        K::VIS_SCALE_PADDING => "padding",
        K::VIS_SCALE_PADDING_INNER => "padding_inner",
        K::VIS_SCALE_PADDING_OUTER => "padding_outer",
        K::VIS_SCALE_REVERSE => "reverse",
        K::VIS_SCALE_ROUND => "round",
        K::VIS_SCALE_EXPONENT => "exponent",
        K::VIS_SCALE_BINS => "bins",
        K::VIS_SCALE_NAME => "name",
        K::VIS_AXIS_ORIENT => "orient",
        K::VIS_AXIS_FORMAT => "format",
        K::VIS_AXIS_FORMAT_TYPE => "format_type",
        K::VIS_AXIS_GRID => "grid",
        K::VIS_AXIS_TICKS => "ticks",
        K::VIS_AXIS_TICK_COUNT => "tick_count",
        K::VIS_AXIS_TICK_SIZE => "tick_size",
        K::VIS_AXIS_LABEL_ANGLE => "label_angle",
        K::VIS_AXIS_LABEL_FONT_SIZE => "label_font_size",
        K::VIS_AXIS_LABEL_OVERLAP => "label_overlap",
        K::VIS_AXIS_DIRECTION => "direction",
        K::VIS_AXIS_OFFSET => "offset",
        K::VIS_AXIS_VALUES => "values",
        K::VIS_AXIS_ZINDEX => "z_index",
        K::VIS_AXIS_TITLE => "title",
        K::VIS_AXIS_DOMAIN => "domain",
        K::VIS_AXIS_NAME => "name",
        K::VIS_LEGEND_TYPE => "type",
        K::VIS_LEGEND_ORIENT => "orient",
        K::VIS_LEGEND_FORMAT => "format",
        K::VIS_LEGEND_FORMAT_TYPE => "format_type",
        K::VIS_LEGEND_DIRECTION => "direction",
        K::VIS_LEGEND_TITLE => "title",
        K::VIS_LEGEND_VALUES => "values",
        K::VIS_LEGEND_PADDING => "padding",
        K::VIS_LEGEND_OFFSET => "offset",
        K::VIS_LEGEND_ZINDEX => "z_index",
        K::VIS_LEGEND_NAME => "name",
        K::VIS_MARK_TYPE => "type",
        K::VIS_MARK_POINT => "point",
        K::VIS_MARK_LINE => "line",
        K::VIS_MARK_FILLED => "filled",
        K::VIS_MARK_FILL => "fill",
        K::VIS_MARK_STROKE => "stroke",
        K::VIS_MARK_COLOR => "color",
        K::VIS_MARK_OPACITY => "opacity",
        K::VIS_MARK_FILL_OPACITY => "fill_opacity",
        K::VIS_MARK_STROKE_OPACITY => "stroke_opacity",
        K::VIS_MARK_STROKE_WIDTH => "stroke_width",
        K::VIS_MARK_STROKE_DASH => "stroke_dash",
        K::VIS_MARK_SIZE => "size",
        K::VIS_MARK_SHAPE => "shape",
        K::VIS_MARK_ANGLE => "angle",
        K::VIS_MARK_RADIUS => "radius",
        K::VIS_MARK_CORNER_RADIUS => "corner_radius",
        K::VIS_MARK_ORIENT => "orient",
        K::VIS_MARK_INTERPOLATE => "interpolate",
        K::VIS_MARK_TENSION => "tension",
        K::VIS_MARK_THICKNESS => "thickness",
        K::VIS_MARK_TOOLTIP => "tooltip",
        K::VIS_UMAP_SPEC_VECTOR => "vector",
        K::VIS_UMAP_SPEC_CATEGORY => "category",
        K::VIS_UMAP_SPEC_LABEL => "label",
        K::VIS_UMAP_SPEC_METRIC => "metric",
        K::VIS_UMAP_SPEC_NEIGHBORS => "neighbors",
        K::VIS_UMAP_SPEC_MIN_DIST => "min_dist",
        K::VIS_MARKDOWN_SPEC_TEMPLATE => "template",
        K::VIS_DASHBOARD_ROW => "row",
        K::VIS_DASHBOARD_COLUMN => "column",
        K::VIS_DASHBOARD_WIDTH => "width",
        K::VIS_DASHBOARD_HEIGHT => "height",
        _ => "",
    }
}

fn vis_mark_type_text(value: VisMarkType) -> Option<&'static str> {
    Some(match value {
        VisMarkType::ARC => "arc",
        VisMarkType::AREA => "area",
        VisMarkType::BAR => "bar",
        VisMarkType::BOXPLOT => "boxplot",
        VisMarkType::CIRCLE => "circle",
        VisMarkType::GEOSHAPE => "geoshape",
        VisMarkType::IMAGE => "image",
        VisMarkType::LINE => "line",
        VisMarkType::POINT => "point",
        VisMarkType::RECT => "rect",
        VisMarkType::RULE => "rule",
        VisMarkType::SQUARE => "square",
        VisMarkType::TEXT => "text",
        VisMarkType::TICK => "tick",
        VisMarkType::TRAIL => "trail",
        _ => return None,
    })
}

fn vis_field_type_text(value: VisFieldType) -> Option<&'static str> {
    Some(match value {
        VisFieldType::NOMINAL => "nominal",
        VisFieldType::ORDINAL => "ordinal",
        VisFieldType::QUANTITATIVE => "quantitative",
        VisFieldType::TEMPORAL => "temporal",
        VisFieldType::GEOJSON => "geojson",
        _ => return None,
    })
}

fn vis_scale_type_text(value: VisScaleType) -> Option<&'static str> {
    Some(match value {
        VisScaleType::LINEAR => "linear",
        VisScaleType::LOG => "log",
        VisScaleType::POW => "pow",
        VisScaleType::SQRT => "sqrt",
        VisScaleType::SYMLOG => "symlog",
        VisScaleType::IDENTITY => "identity",
        VisScaleType::SEQUENTIAL => "sequential",
        VisScaleType::TIME => "time",
        VisScaleType::UTC => "utc",
        VisScaleType::QUANTILE => "quantile",
        VisScaleType::QUANTIZE => "quantize",
        VisScaleType::THRESHOLD => "threshold",
        VisScaleType::ORDINAL => "ordinal",
        VisScaleType::BAND => "band",
        VisScaleType::POINT => "point",
        VisScaleType::BIN_ORDINAL => "bin_ordinal",
        VisScaleType::DIVERGING => "diverging",
        _ => return None,
    })
}

impl<'a> Formatter<'a> {
    /// Vis enums. ENUM_VIS_ENCODING_CHANNEL has no text and is always unformattable.
    pub(super) fn format_vis_enum(&self, node: &'a Node) -> FmtReg {
        let value = super::value_u8(node);
        let text = match node.node_type() {
            NodeType::ENUM_VIS_MARK_TYPE => vis_mark_type_text(VisMarkType(value)),
            NodeType::ENUM_VIS_FIELD_TYPE => vis_field_type_text(VisFieldType(value)),
            NodeType::ENUM_VIS_SCALE_TYPE => vis_scale_type_text(VisScaleType(value)),
            _ => None,
        };
        match text {
            Some(text) => self.fmt.text(text),
            None => self.format_unimplemented(node),
        }
    }

    pub(super) fn format_vararg_array(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [values] = attrs!(self.children(node), [K::EXT_VARARG_ARRAY_VALUES]);
        let Some(values) = values.filter(|v| v.node_type() == NodeType::ARRAY) else {
            return self.format_unimplemented(node);
        };
        if values.children_count() == 0 {
            return f.text("[]");
        }
        let items: Vec<FmtReg> = self.children(values).iter().map(|v| self.reg(v)).filter(|&r| r != 0).collect();
        if items.is_empty() {
            return f.text("[]");
        }
        let (inline_separator, break_separator) = self.comma_separators();
        let list =
            f.join(&items, inline_separator, break_separator, Some(FormattingJoinPolicy::BreakOnOverflow), false);
        f.concat(&[f.text("["), list, f.text("]")])
    }

    pub(super) fn format_vis_property_list(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let mut parts = Vec::new();
        for child in self.children(node) {
            if child.node_type() == NodeType::NONE {
                continue;
            }
            let key_text = get_vis_attribute_key_text(child.attribute_key());
            if key_text.is_empty() {
                continue;
            }
            let value_reg = self.reg(child);
            if value_reg == 0 {
                continue;
            }
            parts.push(f.concat(&[f.verbatim(key_text), f.text(" => "), value_reg]));
        }
        if parts.is_empty() {
            return f.empty();
        }

        let eager_break = self.config.mode == FormattingMode::PRETTY;
        let inline_mode = self.config.mode == FormattingMode::INLINE;
        let is_top_level_spec = matches!(
            node.node_type(),
            NodeType::OBJECT_VIS_SPEC
                | NodeType::OBJECT_VIS_UMAP_SPEC
                | NodeType::OBJECT_VIS_MARKDOWN_SPEC
                | NodeType::OBJECT_VIS_TABLE_SPEC
        );
        let (inline_separator, break_separator) = self.comma_separators();
        let broken_block =
            |join: FmtReg| f.concat(&[f.text("("), f.indented(f.concat(&[f.break_(), join])), f.break_(), f.text(")")]);
        if eager_break {
            let join = f.join(&parts, inline_separator, break_separator, Some(FormattingJoinPolicy::ForceBreak), false);
            return broken_block(join);
        }
        let join = f.join(&parts, inline_separator, break_separator, None, false);
        if is_top_level_spec && !inline_mode {
            return broken_block(join);
        }
        f.parenthesized(join)
    }

    pub(super) fn format_visualize(&self, node_id: usize) -> FmtReg {
        let f = &self.fmt;
        let node: &'a Node = &self.ast[node_id];
        let [source, spec, renderer] =
            attrs!(self.children(node), [K::VIS_VISUALISE_SELECT, K::VIS_VISUALISE_SPEC, K::VIS_VISUALISE_USING]);
        let Some(spec) = spec else { return self.format_unimplemented(node) };
        let spec_reg = self.reg(spec);
        if spec_reg == 0 {
            return self.format_unimplemented(node);
        }
        let Some(source) = source.filter(|s| s.node_type() != NodeType::NONE) else {
            return self.format_unimplemented(node);
        };
        let source_reg = self.reg(source);
        if source_reg == 0 {
            return self.format_unimplemented(node);
        }

        let mut suffix_parts = vec![f.text("visualize using ")];
        if let Some(renderer) = renderer.filter(|r| r.node_type() != NodeType::NONE) {
            suffix_parts.push(f.verbatim(self.text_at(renderer.symbol_span())));
            suffix_parts.push(f.text(" "));
        }
        suffix_parts.push(spec_reg);
        let suffix = f.concat(&suffix_parts);
        let policy = if self.config.mode == FormattingMode::INLINE {
            FormattingJoinPolicy::BreakOnOverflow
        } else {
            FormattingJoinPolicy::ForceBreak
        };
        self.space_join(&[source_reg, suffix], policy, false)
    }
}
