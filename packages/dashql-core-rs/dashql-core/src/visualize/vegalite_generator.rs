//! Generate a Vega-Lite spec from an analyzed VISUALIZE statement (`vegalite_generator.cc`).

use super::pretty_writer::PrettyWriter;
use super::{c_str, cvt_f64_i64, node_text, strip_single_quotes, strtod_c};
use crate::analyzer::types::{
    VegaLiteSpec, VisAxis, VisBin, VisEncodingChannel, VisLegend, VisMark, VisResolve, VisScale, VisualizationSpec,
};
use crate::analyzer::AnalyzedScript;
use dashql_buffers::parser::{AttributeKey as K, Node, NodeType, VisMarkType};

/// The Vega-Lite name of an encoding channel key (`CHANNEL_KEY_TO_VEGALITE`)
pub(crate) fn channel_name(key: K) -> Option<&'static str> {
    Some(match key {
        K::VIS_ENCODING_X => "x",
        K::VIS_ENCODING_Y => "y",
        K::VIS_ENCODING_X2 => "x2",
        K::VIS_ENCODING_Y2 => "y2",
        K::VIS_ENCODING_COLOR => "color",
        K::VIS_ENCODING_FILL => "fill",
        K::VIS_ENCODING_STROKE => "stroke",
        K::VIS_ENCODING_FILL_OPACITY => "fillOpacity",
        K::VIS_ENCODING_STROKE_OPACITY => "strokeOpacity",
        K::VIS_ENCODING_STROKE_WIDTH => "strokeWidth",
        K::VIS_ENCODING_STROKE_DASH => "strokeDash",
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
        K::VIS_ENCODING_X_OFFSET => "xOffset",
        K::VIS_ENCODING_Y_OFFSET => "yOffset",
        _ => return None,
    })
}

/// The lower-cased name of an enum value in its type table (`ToLower(tt->names[value])`)
fn enum_name(name: Option<&'static str>) -> Vec<u8> {
    name.unwrap_or_default().to_ascii_lowercase().into_bytes()
}

/// The field name of an expression (`ResolveFieldName`): the column name of a column reference, the text of the
/// expression otherwise
pub(crate) fn resolve_field_name<'a>(script: &'a AnalyzedScript, expression_id: u32) -> &'a [u8] {
    let expression = &script.expressions[expression_id as usize];
    match expression.column_ref() {
        Some(column) => column.column_name.column_name.text.as_bytes(),
        None => node_text(script, expression.ast_node_id),
    }
}

/// The generator state
struct Generator<'a> {
    script: &'a AnalyzedScript,
    writer: PrettyWriter,
}

impl<'a> Generator<'a> {
    /// Write a number if the text of a node is one, the text otherwise (domain and range bounds)
    fn write_number_or_string(&mut self, node_id: u32) {
        let text = c_str(node_text(self.script, node_id));
        match strtod_c(text) {
            Some(value) => self.writer.double(value),
            None => self.writer.string(text),
        }
    }

    /// `WriteArrayNode`: the values of an `OBJECT_EXT_VARARG_ARRAY`
    fn write_array_node(&mut self, node_id: u32) {
        let script: &'a AnalyzedScript = self.script;
        let nodes = &script.parsed.nodes;
        let node = &nodes[node_id as usize];
        let array_node = children(node).find(|&i| nodes[i as usize].attribute_key() == K::EXT_VARARG_ARRAY_VALUES);
        self.writer.start_array();
        if let Some(array_node) = array_node {
            for elem_id in children(&nodes[array_node as usize]) {
                let elem = &nodes[elem_id as usize];
                let full_text = node_text(script, elem_id);
                let text = c_str(full_text);
                match elem.node_type() {
                    NodeType::LITERAL_INTEGER | NodeType::LITERAL_FLOAT | NodeType::OBJECT_SQL_NARY_EXPRESSION => {
                        match strtod_c(text) {
                            Some(value)
                                if elem.node_type() == NodeType::LITERAL_INTEGER
                                    && value == cvt_f64_i64(value) as f64 =>
                            {
                                self.writer.int64(cvt_f64_i64(value))
                            }
                            Some(value) => self.writer.double(value),
                            None => self.writer.string(text),
                        }
                    }
                    // The quotes are stripped before the string is cut at a NUL
                    NodeType::LITERAL_STRING => self.writer.string(c_str(strip_single_quotes(full_text))),
                    _ => self.writer.string(text),
                }
            }
        }
        self.writer.end_array();
    }

    /// `WriteScale`
    fn write_scale(&mut self, s: &VisScale) {
        let w = &mut self.writer;
        w.start_object();
        if let Some(scale_type) = s.scale_type {
            w.key(b"type");
            w.string(&enum_name(scale_type.variant_name()));
        }
        write_bool(w, b"zero", s.zero);
        write_bool(w, b"nice", s.nice);
        write_bool(w, b"clamp", s.clamp);
        write_bool(w, b"reverse", s.reverse);
        write_bool(w, b"round", s.round);
        write_str(w, b"scheme", &s.scheme);
        write_str(w, b"interpolate", &s.interpolate);
        write_double(w, b"exponent", s.exponent);
        write_double(w, b"base", s.base);
        write_double(w, b"constant", s.constant);
        write_double(w, b"padding", s.padding);
        write_double(w, b"paddingInner", s.padding_inner);
        write_double(w, b"paddingOuter", s.padding_outer);
        write_double(w, b"align", s.align);
        for (key, node_id, is_array) in [
            (&b"domain"[..], s.domain_node_id, true),
            (b"domainMin", s.domain_min_node_id, false),
            (b"domainMax", s.domain_max_node_id, false),
            (b"domainMid", s.domain_mid_node_id, false),
            (b"range", s.range_node_id, true),
            (b"rangeMin", s.range_min_node_id, false),
            (b"rangeMax", s.range_max_node_id, false),
        ] {
            let Some(node_id) = node_id else {
                continue;
            };
            self.writer.key(key);
            if is_array {
                self.write_array_node(node_id);
            } else {
                self.write_number_or_string(node_id);
            }
        }
        write_str(&mut self.writer, b"name", &s.name);
        self.writer.end_object();
    }

    /// `WriteMark`: `point` and `line` overlays recurse, a boolean toggle writes a bool
    fn write_mark(&mut self, m: &VisMark) {
        self.writer.start_object();
        if let Some(mark_type) = m.mark_type {
            self.writer.key(b"type");
            self.writer.string(&enum_name(mark_type.variant_name()));
        }
        let w = &mut self.writer;
        write_bool(w, b"filled", m.filled);
        write_str(w, b"fill", &m.fill);
        write_str(w, b"stroke", &m.stroke);
        write_str(w, b"color", &m.color);
        write_double(w, b"opacity", m.opacity);
        write_double(w, b"fillOpacity", m.fill_opacity);
        write_double(w, b"strokeOpacity", m.stroke_opacity);
        write_double(w, b"strokeWidth", m.stroke_width);
        if let Some(node_id) = m.stroke_dash_node_id {
            self.writer.key(b"strokeDash");
            self.write_array_node(node_id);
        }
        let w = &mut self.writer;
        write_double(w, b"size", m.size);
        write_str(w, b"shape", &m.shape);
        write_double(w, b"angle", m.angle);
        write_double(w, b"radius", m.radius);
        write_double(w, b"cornerRadius", m.corner_radius);
        write_str(w, b"orient", &m.orient);
        write_str(w, b"interpolate", &m.interpolate);
        write_double(w, b"tension", m.tension);
        write_double(w, b"thickness", m.thickness);
        write_bool(w, b"tooltip", m.tooltip);
        if let Some(point) = &m.point {
            self.writer.key(b"point");
            self.write_mark(point);
        } else {
            write_bool(&mut self.writer, b"point", m.point_enabled);
        }
        if let Some(line) = &m.line {
            self.writer.key(b"line");
            self.write_mark(line);
        } else {
            write_bool(&mut self.writer, b"line", m.line_enabled);
        }
        self.writer.end_object();
    }

    /// `WriteStack`: booleans become a JSON bool, everything else a string without single quotes
    fn write_stack(&mut self, node_id: u32) {
        let script: &'a AnalyzedScript = self.script;
        let node = &script.parsed.nodes[node_id as usize];
        if node.node_type() == NodeType::BOOL {
            self.writer.bool(node.children_begin_or_value() != 0);
            return;
        }
        let text = strip_single_quotes(node_text(script, node_id));
        if text == b"true" || text == b"false" {
            self.writer.bool(text == b"true");
            return;
        }
        self.writer.string(c_str(text));
    }

    /// `WriteResolveMap`
    fn write_resolve_map(&mut self, node_id: u32) {
        let script: &'a AnalyzedScript = self.script;
        let nodes = &script.parsed.nodes;
        self.writer.start_object();
        for child_id in children(&nodes[node_id as usize]) {
            let child = &nodes[child_id as usize];
            let Some(channel) = channel_name(child.attribute_key()) else {
                continue;
            };
            let value_node_id = if child.children_count() == 1 { child.children_begin_or_value() } else { child_id };
            let value = strip_single_quotes(node_text(script, value_node_id));
            self.writer.key(channel.as_bytes());
            self.writer.string(c_str(value));
        }
        self.writer.end_object();
    }

    /// `WriteEncoding`
    fn write_encoding(&mut self, channels: &[VisEncodingChannel]) {
        let script: &'a AnalyzedScript = self.script;
        if channels.is_empty() {
            return;
        }
        self.writer.key(b"encoding");
        self.writer.start_object();
        for channel in channels {
            let Some(name) = channel_name(channel.channel_key) else {
                continue;
            };
            self.writer.key(name.as_bytes());
            self.writer.start_object();
            let field_name = match (channel.field_expression_id, channel.field_node_id) {
                (Some(expression_id), _) => Some(resolve_field_name(script, expression_id)),
                (None, Some(node_id)) => Some(node_text(script, node_id)),
                (None, None) => None,
            };
            if let Some(field_name) = field_name {
                self.writer.key(b"field");
                self.writer.string(c_str(field_name));
            }
            if let Some(field_type) = channel.field_type {
                self.writer.key(b"type");
                self.writer.string(&enum_name(field_type.variant_name()));
            }
            write_str(&mut self.writer, b"aggregate", &channel.aggregate);
            if let Some(bin) = &channel.bin {
                self.writer.key(b"bin");
                write_bin(&mut self.writer, bin);
            }
            write_str(&mut self.writer, b"timeUnit", &channel.time_unit);
            if let Some(node_id) = channel.stack_node_id {
                self.writer.key(b"stack");
                self.write_stack(node_id);
            }
            if let Some(scale) = &channel.scale {
                self.writer.key(b"scale");
                self.write_scale(scale);
            }
            if let Some(axis) = &channel.axis {
                self.writer.key(b"axis");
                write_axis(&mut self.writer, axis);
            }
            if let Some(legend) = &channel.legend {
                self.writer.key(b"legend");
                write_legend(&mut self.writer, legend);
            }
            self.writer.end_object();
        }
        self.writer.end_object();
    }

    /// `WriteVegaLiteSpecFields`. Nested specs write their layers before `resolve`, the top-level spec writes them
    /// after it (the caller does).
    fn write_spec_fields(&mut self, fields: SpecFields, layers: Option<&[VegaLiteSpec]>) {
        match fields.mark {
            Some(mark) if mark.has_properties() => {
                self.writer.key(b"mark");
                self.write_mark(mark);
            }
            _ => {
                if let Some(mark_type) = fields.mark_type {
                    self.writer.key(b"mark");
                    self.writer.string(&enum_name(mark_type.variant_name()));
                }
            }
        }
        write_str(&mut self.writer, b"title", fields.title);
        self.write_encoding(fields.encoding_channels);
        if let Some(layers) = layers {
            self.write_layers(layers);
        }
        if let Some(resolve) = fields.resolve {
            self.writer.key(b"resolve");
            self.writer.start_object();
            for (key, node_id) in [
                (&b"scale"[..], resolve.scale_node_id),
                (b"axis", resolve.axis_node_id),
                (b"legend", resolve.legend_node_id),
            ] {
                if let Some(node_id) = node_id {
                    self.writer.key(key);
                    self.write_resolve_map(node_id);
                }
            }
            self.writer.end_object();
        }
    }

    fn write_layers(&mut self, layers: &[VegaLiteSpec]) {
        if layers.is_empty() {
            return;
        }
        self.writer.key(b"layer");
        self.writer.start_array();
        for layer in layers {
            self.writer.start_object();
            self.write_spec_fields(SpecFields::of_layer(layer), Some(&layer.layers));
            self.writer.end_object();
        }
        self.writer.end_array();
    }
}

/// The fields that top-level and nested specs share
struct SpecFields<'a> {
    mark: Option<&'a VisMark>,
    mark_type: Option<VisMarkType>,
    title: &'a Option<String>,
    encoding_channels: &'a [VisEncodingChannel],
    resolve: Option<&'a VisResolve>,
}

impl<'a> SpecFields<'a> {
    fn of_spec(spec: &'a VisualizationSpec) -> Self {
        Self {
            mark: spec.mark.as_ref(),
            mark_type: spec.mark_type,
            title: &spec.title,
            encoding_channels: &spec.encoding_channels,
            resolve: spec.resolve.as_ref(),
        }
    }

    fn of_layer(spec: &'a VegaLiteSpec) -> Self {
        Self {
            mark: spec.mark.as_ref(),
            mark_type: spec.mark_type,
            title: &spec.title,
            encoding_channels: &spec.encoding_channels,
            resolve: spec.resolve.as_ref(),
        }
    }
}

/// The child node ids of a node
fn children(node: &Node) -> std::ops::Range<u32> {
    let begin = node.children_begin_or_value();
    begin..begin + node.children_count()
}

fn write_bool(w: &mut PrettyWriter, key: &[u8], value: Option<bool>) {
    if let Some(value) = value {
        w.key(key);
        w.bool(value);
    }
}

fn write_double(w: &mut PrettyWriter, key: &[u8], value: Option<f64>) {
    if let Some(value) = value {
        w.key(key);
        w.double(value);
    }
}

fn write_int(w: &mut PrettyWriter, key: &[u8], value: Option<i32>) {
    if let Some(value) = value {
        w.key(key);
        w.int(value);
    }
}

fn write_str(w: &mut PrettyWriter, key: &[u8], value: &Option<String>) {
    if let Some(value) = value {
        w.key(key);
        w.string(value.as_bytes());
    }
}

/// `WriteAxis`
fn write_axis(w: &mut PrettyWriter, a: &VisAxis) {
    w.start_object();
    write_str(w, b"orient", &a.orient);
    write_str(w, b"title", &a.title);
    write_str(w, b"format", &a.format);
    write_str(w, b"formatType", &a.format_type);
    write_bool(w, b"grid", a.grid);
    write_bool(w, b"ticks", a.ticks);
    write_bool(w, b"domain", a.domain);
    write_double(w, b"tickCount", a.tick_count);
    write_double(w, b"tickSize", a.tick_size);
    write_double(w, b"labelAngle", a.label_angle);
    write_double(w, b"labelFontSize", a.label_font_size);
    write_str(w, b"labelOverlap", &a.label_overlap);
    write_str(w, b"direction", &a.direction);
    write_double(w, b"offset", a.offset);
    write_int(w, b"zIndex", a.zindex);
    write_str(w, b"name", &a.name);
    w.end_object();
}

/// `WriteLegend`
fn write_legend(w: &mut PrettyWriter, l: &VisLegend) {
    w.start_object();
    write_str(w, b"type", &l.legend_type);
    write_str(w, b"orient", &l.orient);
    write_str(w, b"title", &l.title);
    write_str(w, b"format", &l.format);
    write_str(w, b"formatType", &l.format_type);
    write_str(w, b"direction", &l.direction);
    write_double(w, b"padding", l.padding);
    write_double(w, b"offset", l.offset);
    write_int(w, b"zIndex", l.zindex);
    write_str(w, b"name", &l.name);
    w.end_object();
}

/// `WriteBin`: `true` without parameters
fn write_bin(w: &mut PrettyWriter, b: &VisBin) {
    let has_params = b.step.is_some()
        || b.maxbins.is_some()
        || b.minstep.is_some()
        || b.anchor.is_some()
        || b.base.is_some()
        || b.nice.is_some()
        || b.binned.is_some();
    if !has_params {
        w.bool(true);
        return;
    }
    w.start_object();
    write_bool(w, b"binned", b.binned);
    write_double(w, b"step", b.step);
    write_double(w, b"maxbins", b.maxbins);
    write_double(w, b"minstep", b.minstep);
    write_double(w, b"anchor", b.anchor);
    write_double(w, b"base", b.base);
    write_bool(w, b"nice", b.nice);
    w.end_object();
}

/// Generate the pretty-printed Vega-Lite spec of a visualization (`GenerateVegaLiteSpec`)
pub fn generate_vegalite_spec(spec: &VisualizationSpec, script: &AnalyzedScript) -> String {
    let mut g = Generator { script, writer: PrettyWriter::new() };
    g.writer.start_object();
    g.writer.key(b"$schema");
    g.writer.string(b"https://vega.github.io/schema/vega-lite/v5.json");

    if let Some(source_node_id) = spec.source_node_id {
        g.writer.key(b"data");
        g.writer.start_object();
        if script.parsed.nodes[source_node_id as usize].node_type() == NodeType::OBJECT_SQL_SELECT {
            g.writer.key(b"$sql");
            g.writer.string(c_str(node_text(script, source_node_id)));
        }
        g.writer.end_object();
    }

    g.write_spec_fields(SpecFields::of_spec(spec), None);
    g.write_layers(&spec.layers);
    g.writer.end_object();
    super::into_string(g.writer.finish())
}
