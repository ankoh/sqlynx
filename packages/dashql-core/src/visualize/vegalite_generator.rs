//! Generate a Vega-Lite spec from an analyzed VISUALIZE statement (`vegalite_generator.cc`).
//!
//! The spec is built as a `serde_json` value and pretty-printed with an indentation of two spaces.

use super::{node_text, strip_single_quotes};
use crate::analyzer::types::{
    VegaLiteSpec, VisAxis, VisBin, VisEncodingChannel, VisLegend, VisMark, VisResolve, VisScale, VisualizationSpec,
};
use crate::analyzer::AnalyzedScript;
use dashql_buffers::parser::{AttributeKey as K, Node, NodeType, VisMarkType};
use serde_json::{Map, Value};

/// A JSON object
type Object = Map<String, Value>;

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
fn enum_name(name: Option<&'static str>) -> Value {
    Value::from(name.unwrap_or_default().to_ascii_lowercase())
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

/// A JSON string of script text
fn text_value(text: &[u8]) -> Value {
    Value::from(String::from_utf8_lossy(text))
}

/// A number literal of a script
fn parse_number(text: &[u8]) -> Option<f64> {
    std::str::from_utf8(text).ok()?.parse().ok()
}

/// Insert a member if the value is present
fn put(object: &mut Object, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        insert(object, key, value.into());
    }
}

/// Insert a member. Not inlined into the many `put` calls, which saves 12 KB of wasm.
#[inline(never)]
fn insert(object: &mut Object, key: &str, value: Value) {
    object.insert(key.to_string(), value);
}

/// The generator state
struct Generator<'a> {
    /// The analyzed script of the visualization
    script: &'a AnalyzedScript,
}

impl Generator<'_> {
    /// A number if the text of a node is one, the text otherwise with the quotes of a string literal stripped
    /// (domain and range bounds)
    fn number_or_string(&self, node_id: u32) -> Value {
        let text = node_text(self.script, node_id);
        if self.script.parsed.nodes[node_id as usize].node_type() == NodeType::LITERAL_STRING {
            return text_value(strip_single_quotes(text));
        }
        parse_number(text).map(Value::from).unwrap_or_else(|| text_value(text))
    }

    /// `WriteArrayNode`: the values of an `OBJECT_EXT_VARARG_ARRAY`
    fn array_node(&self, node_id: u32) -> Value {
        let nodes = &self.script.parsed.nodes;
        let node = &nodes[node_id as usize];
        let Some(array_node) =
            children(node).find(|&i| nodes[i as usize].attribute_key() == K::EXT_VARARG_ARRAY_VALUES)
        else {
            return Value::Array(Vec::new());
        };
        let elements = children(&nodes[array_node as usize]).map(|elem_id| {
            let elem = &nodes[elem_id as usize];
            let text = node_text(self.script, elem_id);
            let number = match elem.node_type() {
                // Integer literals are integers in JSON if they are integers as doubles
                NodeType::LITERAL_INTEGER => parse_number(text).map(|d| match d {
                    d if d.fract() == 0.0 && (-(2f64.powi(63))..2f64.powi(63)).contains(&d) => Value::from(d as i64),
                    d => Value::from(d),
                }),
                NodeType::LITERAL_FLOAT | NodeType::OBJECT_SQL_NARY_EXPRESSION => parse_number(text).map(Value::from),
                // The quotes are stripped, `''` stays as it is
                NodeType::LITERAL_STRING => return text_value(strip_single_quotes(text)),
                _ => None,
            };
            number.unwrap_or_else(|| text_value(text))
        });
        Value::Array(elements.collect())
    }

    /// `WriteScale`
    fn scale(&self, s: &VisScale) -> Value {
        let mut o = Object::new();
        put(&mut o, "type", s.scale_type.map(|t| enum_name(t.variant_name())));
        put(&mut o, "zero", s.zero);
        put(&mut o, "nice", s.nice);
        put(&mut o, "clamp", s.clamp);
        put(&mut o, "reverse", s.reverse);
        put(&mut o, "round", s.round);
        put(&mut o, "scheme", s.scheme.as_deref());
        put(&mut o, "interpolate", s.interpolate.as_deref());
        put(&mut o, "exponent", s.exponent);
        put(&mut o, "base", s.base);
        put(&mut o, "constant", s.constant);
        put(&mut o, "padding", s.padding);
        put(&mut o, "paddingInner", s.padding_inner);
        put(&mut o, "paddingOuter", s.padding_outer);
        put(&mut o, "align", s.align);
        put(&mut o, "domain", s.domain_node_id.map(|n| self.array_node(n)));
        put(&mut o, "domainMin", s.domain_min_node_id.map(|n| self.number_or_string(n)));
        put(&mut o, "domainMax", s.domain_max_node_id.map(|n| self.number_or_string(n)));
        put(&mut o, "domainMid", s.domain_mid_node_id.map(|n| self.number_or_string(n)));
        put(&mut o, "range", s.range_node_id.map(|n| self.array_node(n)));
        put(&mut o, "rangeMin", s.range_min_node_id.map(|n| self.number_or_string(n)));
        put(&mut o, "rangeMax", s.range_max_node_id.map(|n| self.number_or_string(n)));
        put(&mut o, "name", s.name.as_deref());
        Value::Object(o)
    }

    /// `WriteMark`: `point` and `line` overlays recurse, a boolean toggle writes a bool
    fn mark(&self, m: &VisMark) -> Value {
        let mut o = Object::new();
        put(&mut o, "type", m.mark_type.map(|t| enum_name(t.variant_name())));
        put(&mut o, "filled", m.filled);
        put(&mut o, "fill", m.fill.as_deref());
        put(&mut o, "stroke", m.stroke.as_deref());
        put(&mut o, "color", m.color.as_deref());
        put(&mut o, "opacity", m.opacity);
        put(&mut o, "fillOpacity", m.fill_opacity);
        put(&mut o, "strokeOpacity", m.stroke_opacity);
        put(&mut o, "strokeWidth", m.stroke_width);
        put(&mut o, "strokeDash", m.stroke_dash_node_id.map(|n| self.array_node(n)));
        put(&mut o, "size", m.size);
        put(&mut o, "shape", m.shape.as_deref());
        put(&mut o, "angle", m.angle);
        put(&mut o, "radius", m.radius);
        put(&mut o, "cornerRadius", m.corner_radius);
        put(&mut o, "orient", m.orient.as_deref());
        put(&mut o, "interpolate", m.interpolate.as_deref());
        put(&mut o, "tension", m.tension);
        put(&mut o, "thickness", m.thickness);
        put(&mut o, "tooltip", m.tooltip);
        match &m.point {
            Some(point) => put(&mut o, "point", Some(self.mark(point))),
            None => put(&mut o, "point", m.point_enabled),
        }
        match &m.line {
            Some(line) => put(&mut o, "line", Some(self.mark(line))),
            None => put(&mut o, "line", m.line_enabled),
        }
        Value::Object(o)
    }

    /// `WriteStack`: booleans become a JSON bool, everything else a string without single quotes
    fn stack(&self, node_id: u32) -> Value {
        let node = &self.script.parsed.nodes[node_id as usize];
        if node.node_type() == NodeType::BOOL {
            return Value::Bool(node.children_begin_or_value() != 0);
        }
        match strip_single_quotes(node_text(self.script, node_id)) {
            b"true" => Value::Bool(true),
            b"false" => Value::Bool(false),
            text => text_value(text),
        }
    }

    /// `WriteResolveMap`
    fn resolve_map(&self, node_id: u32) -> Value {
        let nodes = &self.script.parsed.nodes;
        let mut o = Object::new();
        for child_id in children(&nodes[node_id as usize]) {
            let child = &nodes[child_id as usize];
            let Some(channel) = channel_name(child.attribute_key()) else {
                continue;
            };
            let value_node_id = if child.children_count() == 1 { child.children_begin_or_value() } else { child_id };
            o.insert(channel.to_string(), text_value(strip_single_quotes(node_text(self.script, value_node_id))));
        }
        Value::Object(o)
    }

    /// `WriteEncoding`
    fn encoding(&self, channels: &[VisEncodingChannel]) -> Option<Value> {
        if channels.is_empty() {
            return None;
        }
        let mut encoding = Object::new();
        for channel in channels {
            let Some(name) = channel_name(channel.channel_key) else {
                continue;
            };
            let mut o = Object::new();
            let field_name = match (channel.field_expression_id, channel.field_node_id) {
                (Some(expression_id), _) => Some(resolve_field_name(self.script, expression_id)),
                (None, Some(node_id)) => Some(node_text(self.script, node_id)),
                (None, None) => None,
            };
            put(&mut o, "field", field_name.map(text_value));
            put(&mut o, "type", channel.field_type.map(|t| enum_name(t.variant_name())));
            put(&mut o, "aggregate", channel.aggregate.as_deref());
            put(&mut o, "bin", channel.bin.as_ref().map(bin));
            put(&mut o, "timeUnit", channel.time_unit.as_deref());
            put(&mut o, "stack", channel.stack_node_id.map(|n| self.stack(n)));
            put(&mut o, "scale", channel.scale.as_ref().map(|s| self.scale(s)));
            put(&mut o, "axis", channel.axis.as_ref().map(axis));
            put(&mut o, "legend", channel.legend.as_ref().map(legend));
            encoding.insert(name.to_string(), Value::Object(o));
        }
        Some(Value::Object(encoding))
    }

    /// `WriteVegaLiteSpecFields`. Nested specs write their layers before `resolve`, the top-level spec writes them
    /// after it (the caller does).
    fn spec_fields(&self, o: &mut Object, fields: SpecFields, layers: Option<&[VegaLiteSpec]>) {
        let mark = match fields.mark {
            Some(mark) if mark.has_properties() => Some(self.mark(mark)),
            _ => fields.mark_type.map(|t| enum_name(t.variant_name())),
        };
        put(o, "mark", mark);
        put(o, "title", fields.title.as_deref());
        put(o, "encoding", self.encoding(fields.encoding_channels));
        if let Some(layers) = layers {
            self.layers(o, layers);
        }
        if let Some(resolve) = fields.resolve {
            let mut r = Object::new();
            put(&mut r, "scale", resolve.scale_node_id.map(|n| self.resolve_map(n)));
            put(&mut r, "axis", resolve.axis_node_id.map(|n| self.resolve_map(n)));
            put(&mut r, "legend", resolve.legend_node_id.map(|n| self.resolve_map(n)));
            o.insert("resolve".to_string(), Value::Object(r));
        }
    }

    fn layers(&self, o: &mut Object, layers: &[VegaLiteSpec]) {
        if layers.is_empty() {
            return;
        }
        let layers = layers.iter().map(|layer| {
            let mut l = Object::new();
            self.spec_fields(&mut l, SpecFields::of_layer(layer), Some(&layer.layers));
            Value::Object(l)
        });
        o.insert("layer".to_string(), Value::Array(layers.collect()));
    }
}

/// The fields that top-level and nested specs share
struct SpecFields<'a> {
    /// The mark definition, written instead of the mark type if it has properties
    mark: Option<&'a VisMark>,
    /// The mark type
    mark_type: Option<VisMarkType>,
    /// The title
    title: &'a Option<String>,
    /// The encoding channels
    encoding_channels: &'a [VisEncodingChannel],
    /// The resolution of scales, axes and legends
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

/// `WriteAxis`
fn axis(a: &VisAxis) -> Value {
    let mut o = Object::new();
    put(&mut o, "orient", a.orient.as_deref());
    put(&mut o, "title", a.title.as_deref());
    put(&mut o, "format", a.format.as_deref());
    put(&mut o, "formatType", a.format_type.as_deref());
    put(&mut o, "grid", a.grid);
    put(&mut o, "ticks", a.ticks);
    put(&mut o, "domain", a.domain);
    put(&mut o, "tickCount", a.tick_count);
    put(&mut o, "tickSize", a.tick_size);
    put(&mut o, "labelAngle", a.label_angle);
    put(&mut o, "labelFontSize", a.label_font_size);
    put(&mut o, "labelOverlap", a.label_overlap.as_deref());
    put(&mut o, "direction", a.direction.as_deref());
    put(&mut o, "offset", a.offset);
    put(&mut o, "zIndex", a.zindex);
    put(&mut o, "name", a.name.as_deref());
    Value::Object(o)
}

/// `WriteLegend`
fn legend(l: &VisLegend) -> Value {
    let mut o = Object::new();
    put(&mut o, "type", l.legend_type.as_deref());
    put(&mut o, "orient", l.orient.as_deref());
    put(&mut o, "title", l.title.as_deref());
    put(&mut o, "format", l.format.as_deref());
    put(&mut o, "formatType", l.format_type.as_deref());
    put(&mut o, "direction", l.direction.as_deref());
    put(&mut o, "padding", l.padding);
    put(&mut o, "offset", l.offset);
    put(&mut o, "zIndex", l.zindex);
    put(&mut o, "name", l.name.as_deref());
    Value::Object(o)
}

/// `WriteBin`: `true` without parameters
fn bin(b: &VisBin) -> Value {
    let has_params = b.step.is_some()
        || b.maxbins.is_some()
        || b.minstep.is_some()
        || b.anchor.is_some()
        || b.base.is_some()
        || b.nice.is_some()
        || b.binned.is_some();
    if !has_params {
        return Value::Bool(true);
    }
    let mut o = Object::new();
    put(&mut o, "binned", b.binned);
    put(&mut o, "step", b.step);
    put(&mut o, "maxbins", b.maxbins);
    put(&mut o, "minstep", b.minstep);
    put(&mut o, "anchor", b.anchor);
    put(&mut o, "base", b.base);
    put(&mut o, "nice", b.nice);
    Value::Object(o)
}

/// Generate the pretty-printed Vega-Lite spec of a visualization (`GenerateVegaLiteSpec`)
pub fn generate_vegalite_spec(spec: &VisualizationSpec, script: &AnalyzedScript) -> String {
    let g = Generator { script };
    let mut root = Object::new();
    root.insert("$schema".to_string(), Value::from("https://vega.github.io/schema/vega-lite/v5.json"));
    if let Some(source_node_id) = spec.source_node_id {
        let mut data = Object::new();
        if script.parsed.nodes[source_node_id as usize].node_type() == NodeType::OBJECT_SQL_SELECT {
            data.insert("$sql".to_string(), text_value(node_text(script, source_node_id)));
        }
        root.insert("data".to_string(), Value::Object(data));
    }
    g.spec_fields(&mut root, SpecFields::of_spec(spec), None);
    g.layers(&mut root, &spec.layers);
    serde_json::to_string_pretty(&root).expect("a JSON value always serializes")
}
