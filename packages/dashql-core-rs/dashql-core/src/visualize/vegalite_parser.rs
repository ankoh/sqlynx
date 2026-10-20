//! Turn a Vega-Lite spec back into a VISUALIZE statement (`vegalite_parser.cc`).
//!
//! The JSON is read like `rapidjson::Document::Parse` with the default flags. The C++ code reads many strings
//! through `GetString()` as C strings, which cuts them at the first NUL byte, and compares member names with
//! their full length elsewhere. Both are reproduced.

use crate::view::json::{c_str, Document, Number, ParseFlags, Value, ValueId};

/// The DSL channel keyword of a Vega-Lite encoding channel (`VEGALITE_TO_CHANNEL_KEY`)
fn channel_keyword(name: &[u8]) -> Option<&'static str> {
    Some(match name {
        b"x" => "x",
        b"y" => "y",
        b"x2" => "x2",
        b"y2" => "y2",
        b"color" => "color",
        b"fill" => "fill",
        b"stroke" => "stroke",
        b"fillOpacity" => "fill_opacity",
        b"strokeOpacity" => "stroke_opacity",
        b"strokeWidth" => "stroke_width",
        b"strokeDash" => "stroke_dash",
        b"opacity" => "opacity",
        b"size" => "size",
        b"shape" => "shape",
        b"angle" => "angle",
        b"theta" => "theta",
        b"theta2" => "theta2",
        b"radius" => "radius",
        b"radius2" => "radius2",
        b"detail" => "detail",
        b"order" => "order",
        b"tooltip" => "tooltip",
        b"text" => "text",
        b"row" => "row",
        b"column" => "column",
        b"facet" => "facet",
        b"href" => "href",
        b"url" => "url",
        b"key" => "key",
        b"latitude" => "latitude",
        b"longitude" => "longitude",
        b"latitude2" => "latitude2",
        b"longitude2" => "longitude2",
        b"xOffset" => "x_offset",
        b"yOffset" => "y_offset",
        _ => return None,
    })
}

/// A simple SQL identifier: starts with a letter or underscore, followed by alphanumerics or underscores
fn is_simple_ident(s: &[u8]) -> bool {
    match s.first() {
        Some(c) if c.is_ascii_alphabetic() || *c == b'_' => {}
        _ => return false,
    }
    s.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// Convert a camelCase JSON key to a snake_case DSL key (`labelAngle` -> `label_angle`)
fn to_snake_case(key: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(key.len() + 4);
    for &c in key {
        if c.is_ascii_uppercase() {
            if !out.is_empty() {
                out.push(b'_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// An identifier value: bare when simple, double-quoted otherwise (`EmitIdentifier`)
fn emit_identifier(s: &[u8]) -> Vec<u8> {
    if is_simple_ident(s) {
        return s.to_vec();
    }
    let mut out = Vec::with_capacity(s.len() + 2);
    out.push(b'"');
    for &c in s {
        if c == b'"' {
            out.extend_from_slice(b"\"\"");
        } else {
            out.push(c);
        }
    }
    out.push(b'"');
    out
}

/// A single-quoted SQL string literal (`EmitStringLiteral`)
fn emit_string_literal(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() + 2);
    out.push(b'\'');
    for &c in s {
        if c == b'\'' {
            out.extend_from_slice(b"''");
        } else {
            out.push(c);
        }
    }
    out.push(b'\'');
    out
}

/// `printf("%g", d)`: 6 significant digits, exponent notation below 1e-4 and from 1e6 on, no trailing zeros
pub(crate) fn format_g(d: f64) -> String {
    if d.is_infinite() {
        return if d < 0.0 { "-inf".to_string() } else { "inf".to_string() };
    }
    if d.is_nan() {
        return if d.is_sign_negative() { "-nan".to_string() } else { "nan".to_string() };
    }
    if d == 0.0 {
        return if d.is_sign_negative() { "-0".to_string() } else { "0".to_string() };
    }
    // The exponent after rounding to 6 significant digits
    let e_form = format!("{:.5e}", d);
    let (mantissa, exponent) = e_form.split_once('e').unwrap();
    let exponent: i32 = exponent.parse().unwrap();
    if !(-4..6).contains(&exponent) {
        let mantissa = trim_fraction_zeros(mantissa);
        let sign = if exponent < 0 { '-' } else { '+' };
        format!("{mantissa}e{sign}{:02}", exponent.abs())
    } else {
        let decimals = (5 - exponent) as usize;
        trim_fraction_zeros(&format!("{:.*}", decimals, d)).to_string()
    }
}

/// Remove trailing zeros of a fraction, and the decimal point if nothing follows it
fn trim_fraction_zeros(s: &str) -> &str {
    if !s.contains('.') {
        return s;
    }
    s.trim_end_matches('0').trim_end_matches('.')
}

/// A JSON number as a bare DSL literal (`EmitNumber`)
fn emit_number(n: Number) -> Vec<u8> {
    match n {
        Number::Int(i) => i.to_string().into_bytes(),
        Number::Uint(u) => u.to_string().into_bytes(),
        Number::Int64(i) => i.to_string().into_bytes(),
        Number::Uint64(u) => u.to_string().into_bytes(),
        Number::Double(d) => {
            let i = super::cvt_f64_i64(d);
            if d.is_finite() && d == i as f64 && d.abs() < 1e15 {
                i.to_string().into_bytes()
            } else {
                format_g(d).into_bytes()
            }
        }
    }
}

/// Join parts with a separator, in parentheses
fn parenthesize(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![b'('];
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(b", ");
        }
        out.extend_from_slice(part);
    }
    out.push(b')');
    out
}

/// `key => value`
fn assignment(key: &[u8], value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(key.len() + value.len() + 4);
    out.extend_from_slice(key);
    out.extend_from_slice(b" => ");
    out.extend_from_slice(value);
    out
}

/// The parser state
struct Parser {
    doc: Document,
}

impl Parser {
    fn value(&self, id: ValueId) -> &Value {
        self.doc.get(id)
    }

    /// The string of a value read through `GetString()`, cut at the first NUL
    fn c_string(&self, id: ValueId) -> Option<&[u8]> {
        self.doc.string(id).map(c_str)
    }

    /// `HasMember(name) && operator[](name)`
    fn member(&self, id: ValueId, name: &[u8]) -> Option<ValueId> {
        self.doc.find_member(id, name)
    }

    /// A lower-cased C string (enum keywords)
    fn lower_c_string(&self, id: ValueId) -> Option<Vec<u8>> {
        self.c_string(id).map(|s| s.to_ascii_lowercase())
    }

    /// A scalar as a DSL value, `None` for null, arrays and objects (`EmitScalar`)
    fn emit_scalar(&self, id: ValueId, as_ident: bool) -> Option<Vec<u8>> {
        match self.value(id) {
            Value::String(s) => {
                let s = c_str(s);
                Some(if as_ident { emit_identifier(s) } else { emit_string_literal(s) })
            }
            Value::Bool(b) => Some(if *b { b"true".to_vec() } else { b"false".to_vec() }),
            Value::Number(n) => Some(emit_number(*n)),
            _ => None,
        }
    }

    /// A scalar or an array of scalars, array strings are always string literals (`EmitValue`)
    fn emit_value(&self, id: ValueId, as_ident: bool) -> Option<Vec<u8>> {
        let Value::Array(elements) = self.value(id) else {
            return self.emit_scalar(id, as_ident);
        };
        let mut out = vec![b'['];
        let mut first = true;
        for element in elements {
            let Some(element) = self.emit_scalar(*element, false) else {
                continue;
            };
            if !first {
                out.extend_from_slice(b", ");
            }
            first = false;
            out.extend_from_slice(&element);
        }
        out.push(b']');
        Some(out)
    }

    /// A `( k => v, ... )` sub-object with snake_case keys, `type` is an enum keyword of scales
    /// (`EmitSubObject`). `None` if nothing was emitted.
    fn emit_sub_object(&self, id: ValueId, type_is_enum: bool) -> Option<Vec<u8>> {
        let mut parts = Vec::new();
        for member in self.doc.members(id) {
            let key = c_str(&member.name);
            if type_is_enum && key == b"type" {
                if let Some(ty) = self.lower_c_string(member.value) {
                    parts.push(assignment(b"type", &ty));
                }
                continue;
            }
            let Some(emitted) = self.emit_value(member.value, false) else {
                continue;
            };
            parts.push(assignment(&to_snake_case(key), &emitted));
        }
        if parts.is_empty() {
            return None;
        }
        Some(parenthesize(&parts))
    }

    /// A mark definition (`EmitMark`): `type` is an enum keyword, `point` and `line` recurse
    fn emit_mark(&self, id: ValueId) -> Vec<u8> {
        let mut parts = Vec::new();
        for member in self.doc.members(id) {
            let key = c_str(&member.name);
            if key == b"type" {
                if let Some(ty) = self.lower_c_string(member.value) {
                    parts.push(assignment(b"type", &ty));
                }
                continue;
            }
            if key == b"point" || key == b"line" {
                match self.value(member.value) {
                    Value::Object(_) => parts.push(assignment(key, &self.emit_mark(member.value))),
                    Value::Bool(b) => parts.push(assignment(key, if *b { b"true" } else { b"false" })),
                    _ => {}
                }
                continue;
            }
            let Some(emitted) = self.emit_value(member.value, false) else {
                continue;
            };
            parts.push(assignment(&to_snake_case(key), &emitted));
        }
        if parts.is_empty() {
            return b"()".to_vec();
        }
        parenthesize(&parts)
    }

    /// A `bin => ...` value: a boolean or an object of bin parameters (`EmitBin`)
    fn emit_bin(&self, id: ValueId) -> Option<Vec<u8>> {
        match self.value(id) {
            Value::Bool(b) => Some(if *b { b"true".to_vec() } else { b"false".to_vec() }),
            Value::Object(members) => {
                let mut parts = Vec::new();
                for member in members {
                    let Some(emitted) = self.emit_scalar(member.value, false) else {
                        continue;
                    };
                    parts.push(assignment(c_str(&member.name), &emitted));
                }
                if parts.is_empty() {
                    return Some(b"true".to_vec());
                }
                Some(parenthesize(&parts))
            }
            _ => None,
        }
    }

    /// Append an encoding channel `<channel> => (field => ..., type => ..., ...)` (`AppendChannel`)
    fn append_channel(&self, out: &mut Vec<u8>, channel_name: &str, channel: ValueId) {
        out.extend_from_slice(channel_name.as_bytes());
        out.extend_from_slice(b" => (");

        let mut parts = Vec::new();
        if let Some(field) = self.member(channel, b"field").and_then(|v| self.c_string(v)) {
            parts.push(assignment(b"field", &emit_identifier(field)));
        }
        if let Some(ty) = self.member(channel, b"type").and_then(|v| self.lower_c_string(v)) {
            parts.push(assignment(b"type", &ty));
        }
        if let Some(aggregate) = self.member(channel, b"aggregate").and_then(|v| self.c_string(v)) {
            parts.push(assignment(b"aggregate", &emit_identifier(aggregate)));
        }
        if let Some(bin) = self.member(channel, b"bin").and_then(|v| self.emit_bin(v)) {
            parts.push(assignment(b"bin", &bin));
        }
        if let Some(time_unit) = self.member(channel, b"timeUnit").and_then(|v| self.c_string(v)) {
            parts.push(assignment(b"time_unit", &emit_identifier(time_unit)));
        }
        for (json_key, dsl_key, type_is_enum) in
            [(&b"scale"[..], &b"scale"[..], true), (b"axis", b"axis", false), (b"legend", b"legend", false)]
        {
            let Some(value) = self.member(channel, json_key).filter(|v| self.doc.is_object(*v)) else {
                continue;
            };
            if let Some(emitted) = self.emit_sub_object(value, type_is_enum) {
                parts.push(assignment(dsl_key, &emitted));
            }
        }
        // Remaining simple field-def keys (sort, stack, title, format, ...)
        for member in self.doc.members(channel) {
            let key: &[u8] = &member.name;
            if matches!(
                key,
                b"field" | b"type" | b"aggregate" | b"bin" | b"timeUnit" | b"scale" | b"axis" | b"legend"
            ) {
                continue;
            }
            let dsl_key = to_snake_case(key);
            let as_ident = matches!(&dsl_key[..], b"field" | b"aggregate" | b"time_unit");
            let Some(emitted) = self.emit_value(member.value, as_ident) else {
                continue;
            };
            parts.push(assignment(&dsl_key, &emitted));
        }

        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                out.extend_from_slice(b", ");
            }
            out.extend_from_slice(part);
        }
        out.push(b')');
    }

    /// `EmitResolveMap`
    fn emit_resolve_map(&self, id: ValueId) -> Option<Vec<u8>> {
        if !self.doc.is_object(id) {
            return None;
        }
        let mut parts = Vec::new();
        for member in self.doc.members(id) {
            let Some(channel) = channel_keyword(&member.name) else {
                continue;
            };
            let Some(value) = self.emit_scalar(member.value, true) else {
                continue;
            };
            parts.push(assignment(channel.as_bytes(), &value));
        }
        if parts.is_empty() {
            return None;
        }
        Some(parenthesize(&parts))
    }

    /// `AppendVegaLiteSpecLines`
    fn append_spec_lines(&self, spec: ValueId, lines: &mut Vec<Vec<u8>>, indent: &[u8]) {
        if !self.doc.is_object(spec) {
            return;
        }
        let line = |head: &[u8], tail: &[u8]| -> Vec<u8> {
            let mut out = Vec::with_capacity(indent.len() + head.len() + tail.len());
            out.extend_from_slice(indent);
            out.extend_from_slice(head);
            out.extend_from_slice(tail);
            out
        };

        if let Some(mark) = self.member(spec, b"mark") {
            match self.value(mark) {
                Value::String(s) => lines.push(line(b"mark => ", &c_str(s).to_ascii_lowercase())),
                Value::Object(members) => {
                    let ty = self.member(mark, b"type").and_then(|t| self.lower_c_string(t));
                    match ty {
                        Some(ty) if members.len() == 1 => lines.push(line(b"mark => ", &ty)),
                        _ if !members.is_empty() => lines.push(line(b"mark => ", &self.emit_mark(mark))),
                        _ => {}
                    }
                }
                _ => {}
            }
        }

        if let Some(title) = self.member(spec, b"title").and_then(|t| self.c_string(t)) {
            lines.push(line(b"title => ", &emit_string_literal(title)));
        }

        if let Some(encoding) = self.member(spec, b"encoding").filter(|e| self.doc.is_object(*e)) {
            let mut channels = Vec::new();
            for member in self.doc.members(encoding) {
                if !self.doc.is_object(member.value) {
                    continue;
                }
                let Some(channel_name) = channel_keyword(&member.name) else {
                    continue;
                };
                let mut channel = line(b"  ", b"");
                self.append_channel(&mut channel, channel_name, member.value);
                channels.push(channel);
            }
            if !channels.is_empty() {
                let mut block = line(b"encoding => (\n", b"");
                for (i, channel) in channels.iter().enumerate() {
                    if i > 0 {
                        block.extend_from_slice(b",\n");
                    }
                    block.extend_from_slice(channel);
                }
                block.push(b'\n');
                block.extend_from_slice(indent);
                block.push(b')');
                lines.push(block);
            }
        }

        if let Some(Value::Array(layer_ids)) = self.member(spec, b"layer").map(|l| self.value(l)) {
            let mut layer_indent = indent.to_vec();
            layer_indent.extend_from_slice(b"    ");
            let mut layers = Vec::new();
            for &layer in layer_ids {
                if !self.doc.is_object(layer) {
                    continue;
                }
                let mut layer_lines = Vec::new();
                self.append_spec_lines(layer, &mut layer_lines, &layer_indent);
                if layer_lines.is_empty() {
                    continue;
                }
                let mut block = line(b"  (\n", b"");
                for (i, layer_line) in layer_lines.iter().enumerate() {
                    if i > 0 {
                        block.extend_from_slice(b",\n");
                    }
                    block.extend_from_slice(layer_line);
                }
                block.push(b'\n');
                block.extend_from_slice(indent);
                block.extend_from_slice(b"  )");
                layers.push(block);
            }
            if !layers.is_empty() {
                let mut block = line(b"layer => [\n", b"");
                for (i, layer) in layers.iter().enumerate() {
                    if i > 0 {
                        block.extend_from_slice(b",\n");
                    }
                    block.extend_from_slice(layer);
                }
                block.push(b'\n');
                block.extend_from_slice(indent);
                block.push(b']');
                lines.push(block);
            }
        }

        if let Some(resolve) = self.member(spec, b"resolve").filter(|r| self.doc.is_object(*r)) {
            let mut parts = Vec::new();
            for key in [&b"scale"[..], b"axis", b"legend"] {
                let Some(value) = self.member(resolve, key) else {
                    continue;
                };
                if let Some(value) = self.emit_resolve_map(value) {
                    parts.push(assignment(key, &value));
                }
            }
            if !parts.is_empty() {
                let mut block = line(b"resolve => (", b"");
                for (i, part) in parts.iter().enumerate() {
                    if i > 0 {
                        block.extend_from_slice(b", ");
                    }
                    block.extend_from_slice(part);
                }
                block.push(b')');
                lines.push(block);
            }
        }
    }

    /// The query before the VISUALIZE clause, from `$sql` or `$raw` of the `data` member (`EmitSource`)
    fn emit_source(&self, data: ValueId) -> Option<Vec<u8>> {
        if !self.doc.is_object(data) {
            return None;
        }
        for key in [&b"$sql"[..], b"$raw"] {
            if let Some(text) = self.member(data, key).and_then(|v| self.c_string(v)) {
                return if text.is_empty() { None } else { Some(text.to_vec()) };
            }
        }
        None
    }
}

/// Parse a Vega-Lite spec and produce a pretty-printed VISUALIZE statement (`ParseVegaLiteToVisualize`).
///
/// Returns the raw bytes: strings of the spec are copied without UTF-8 validation, and escaped lone low surrogates
/// decode into invalid UTF-8. Empty if the spec is not a JSON object or has no source.
pub fn parse_vegalite_to_visualize_bytes(vegalite_json: &[u8]) -> Vec<u8> {
    let Some(doc) = Document::parse_with(vegalite_json, ParseFlags::DEFAULT) else {
        return Vec::new();
    };
    let parser = Parser { doc };
    let root = parser.doc.root();
    if !parser.doc.is_object(root) {
        return Vec::new();
    }

    let mut lines = Vec::new();
    parser.append_spec_lines(root, &mut lines, b"  ");

    let Some(source) = parser.member(root, b"data").and_then(|data| parser.emit_source(data)) else {
        return Vec::new();
    };
    let mut result = source;
    result.extend_from_slice(b"\nVISUALIZE USING vegalite (\n");
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            result.extend_from_slice(b",\n");
        }
        result.extend_from_slice(line);
    }
    result.extend_from_slice(b"\n);");
    result
}

/// Parse a Vega-Lite spec and produce a pretty-printed VISUALIZE statement (`ParseVegaLiteToVisualize`).
///
/// Invalid UTF-8 in the result (see `parse_vegalite_to_visualize_bytes`) is replaced.
pub fn parse_vegalite_to_visualize(vegalite_json: &str) -> String {
    super::into_string(parse_vegalite_to_visualize_bytes(vegalite_json.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_printf_g() {
        for (value, expected) in [
            (1e15, "1e+15"),
            (1.5e15, "1.5e+15"),
            (0.1, "0.1"),
            (0.0001, "0.0001"),
            (0.00001234, "1.234e-05"),
            (123456.7, "123457"),
            (1234567.0, "1.23457e+06"),
            (0.5, "0.5"),
            (-2.25, "-2.25"),
            (1e300, "1e+300"),
            (1e-300, "1e-300"),
            (f64::INFINITY, "inf"),
            (f64::NEG_INFINITY, "-inf"),
            (999999.5, "1e+06"),
            (9.9999949, "9.99999"),
        ] {
            assert_eq!(format_g(value), expected, "{value}");
        }
    }

    fn roundtrip(json: &str) -> String {
        parse_vegalite_to_visualize(json)
    }

    #[test]
    fn requires_an_object_with_source() {
        assert_eq!(roundtrip(""), "");
        assert_eq!(roundtrip("[]"), "");
        assert_eq!(roundtrip(r#"{"mark":"bar"}"#), "");
        assert_eq!(roundtrip(r#"{"data":{"$sql":""}}"#), "");
        assert_eq!(roundtrip(r#"{"data":{"$sql":1, "$raw":"x"}}"#), "x\nVISUALIZE USING vegalite (\n\n);");
        // The default flags reject comments and trailing commas
        assert_eq!(roundtrip(r#"{"data":{"$sql":"x"},}"#), "");
        assert_eq!(roundtrip("{\"data\":{\"$sql\":\"x\"}} // c"), "");
    }

    #[test]
    fn emits_specs() {
        assert_eq!(
            roundtrip(
                r#"{"data":{"$sql":"SELECT 1"},"mark":{"type":"Bar","opacity":0.5,"point":{"filled":true}},
                "encoding":{"x":{"field":"a b","type":"Nominal","sort":["x",1.5e20],"labelAngle":3},"foo":{}},
                "resolve":{"scale":{"x":"independent","bogus":"y"}}}"#
            ),
            concat!(
                "SELECT 1\nVISUALIZE USING vegalite (\n",
                "  mark => (type => bar, opacity => 0.5, point => (filled => true)),\n",
                "  encoding => (\n",
                "    x => (field => \"a b\", type => nominal, sort => ['x', 1.5e+20], label_angle => 3)\n",
                "  ),\n",
                "  resolve => (scale => (x => independent))\n",
                ");"
            )
        );
    }
}
