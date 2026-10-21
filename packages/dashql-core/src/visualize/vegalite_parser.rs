//! Turn a Vega-Lite spec back into a VISUALIZE statement (`vegalite_parser.cc`).

use serde_json::{Map, Number, Value};

/// A JSON object
type Object = Map<String, Value>;

/// The DSL channel keyword of a Vega-Lite encoding channel (`VEGALITE_TO_CHANNEL_KEY`)
fn channel_keyword(name: &str) -> Option<&'static str> {
    Some(match name {
        "x" => "x",
        "y" => "y",
        "x2" => "x2",
        "y2" => "y2",
        "color" => "color",
        "fill" => "fill",
        "stroke" => "stroke",
        "fillOpacity" => "fill_opacity",
        "strokeOpacity" => "stroke_opacity",
        "strokeWidth" => "stroke_width",
        "strokeDash" => "stroke_dash",
        "opacity" => "opacity",
        "size" => "size",
        "shape" => "shape",
        "angle" => "angle",
        "theta" => "theta",
        "theta2" => "theta2",
        "radius" => "radius",
        "radius2" => "radius2",
        "detail" => "detail",
        "order" => "order",
        "tooltip" => "tooltip",
        "text" => "text",
        "row" => "row",
        "column" => "column",
        "facet" => "facet",
        "href" => "href",
        "url" => "url",
        "key" => "key",
        "latitude" => "latitude",
        "longitude" => "longitude",
        "latitude2" => "latitude2",
        "longitude2" => "longitude2",
        "xOffset" => "x_offset",
        "yOffset" => "y_offset",
        _ => return None,
    })
}

/// A simple SQL identifier: starts with a letter or underscore, followed by alphanumerics or underscores
fn is_simple_ident(s: &str) -> bool {
    match s.chars().next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Convert a camelCase JSON key to a snake_case DSL key (`labelAngle` -> `label_angle`)
fn to_snake_case(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            if !out.is_empty() {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// An identifier value: bare when simple, double-quoted otherwise (`EmitIdentifier`)
fn emit_identifier(s: &str) -> String {
    if is_simple_ident(s) {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('"', "\"\""))
    }
}

/// A single-quoted SQL string literal (`EmitStringLiteral`)
fn emit_string_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A JSON number as a bare DSL literal
fn emit_number(n: &Number) -> String {
    match n.as_f64() {
        Some(d) if n.is_f64() => format!("{d:?}"),
        _ => n.to_string(),
    }
}

/// Join parts with a separator, in parentheses
fn parenthesize(parts: &[String]) -> String {
    format!("({})", parts.join(", "))
}

/// `key => value`
fn assignment(key: &str, value: &str) -> String {
    format!("{key} => {value}")
}

/// A lower-cased string (enum keywords)
fn lower_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_ascii_lowercase)
}

/// A scalar as a DSL value, `None` for null, arrays and objects (`EmitScalar`)
fn emit_scalar(value: &Value, as_ident: bool) -> Option<String> {
    match value {
        Value::String(s) => Some(if as_ident { emit_identifier(s) } else { emit_string_literal(s) }),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(emit_number(n)),
        _ => None,
    }
}

/// A scalar or an array of scalars, array strings are always string literals (`EmitValue`)
fn emit_value(value: &Value, as_ident: bool) -> Option<String> {
    let Value::Array(elements) = value else {
        return emit_scalar(value, as_ident);
    };
    let elements: Vec<String> = elements.iter().filter_map(|element| emit_scalar(element, false)).collect();
    Some(format!("[{}]", elements.join(", ")))
}

/// A `( k => v, ... )` sub-object with snake_case keys, `type` is an enum keyword of scales
/// (`EmitSubObject`). `None` if nothing was emitted.
fn emit_sub_object(object: &Object, type_is_enum: bool) -> Option<String> {
    let mut parts = Vec::new();
    for (key, value) in object {
        if type_is_enum && key == "type" {
            if let Some(ty) = lower_string(value) {
                parts.push(assignment("type", &ty));
            }
            continue;
        }
        if let Some(emitted) = emit_value(value, false) {
            parts.push(assignment(&to_snake_case(key), &emitted));
        }
    }
    (!parts.is_empty()).then(|| parenthesize(&parts))
}

/// A mark definition (`EmitMark`): `type` is an enum keyword, `point` and `line` recurse
fn emit_mark(object: &Object) -> String {
    let mut parts = Vec::new();
    for (key, value) in object {
        match (key.as_str(), value) {
            ("type", _) => {
                if let Some(ty) = lower_string(value) {
                    parts.push(assignment("type", &ty));
                }
            }
            ("point" | "line", Value::Object(overlay)) => parts.push(assignment(key, &emit_mark(overlay))),
            ("point" | "line", Value::Bool(b)) => parts.push(assignment(key, &b.to_string())),
            ("point" | "line", _) => {}
            _ => {
                if let Some(emitted) = emit_value(value, false) {
                    parts.push(assignment(&to_snake_case(key), &emitted));
                }
            }
        }
    }
    parenthesize(&parts)
}

/// A `bin => ...` value: a boolean or an object of bin parameters (`EmitBin`)
fn emit_bin(value: &Value) -> Option<String> {
    match value {
        Value::Bool(b) => Some(b.to_string()),
        Value::Object(members) => {
            let parts: Vec<String> =
                members.iter().filter_map(|(key, value)| Some(assignment(key, &emit_scalar(value, false)?))).collect();
            Some(if parts.is_empty() { "true".to_string() } else { parenthesize(&parts) })
        }
        _ => None,
    }
}

/// An encoding channel `<channel> => (field => ..., type => ..., ...)` (`AppendChannel`)
fn emit_channel(channel_name: &str, channel: &Object) -> String {
    let string = |key: &str| channel.get(key).and_then(Value::as_str);
    let mut parts = Vec::new();
    if let Some(field) = string("field") {
        parts.push(assignment("field", &emit_identifier(field)));
    }
    if let Some(ty) = channel.get("type").and_then(lower_string) {
        parts.push(assignment("type", &ty));
    }
    if let Some(aggregate) = string("aggregate") {
        parts.push(assignment("aggregate", &emit_identifier(aggregate)));
    }
    if let Some(bin) = channel.get("bin").and_then(emit_bin) {
        parts.push(assignment("bin", &bin));
    }
    if let Some(time_unit) = string("timeUnit") {
        parts.push(assignment("time_unit", &emit_identifier(time_unit)));
    }
    for (key, type_is_enum) in [("scale", true), ("axis", false), ("legend", false)] {
        let Some(value) = channel.get(key).and_then(Value::as_object) else {
            continue;
        };
        if let Some(emitted) = emit_sub_object(value, type_is_enum) {
            parts.push(assignment(key, &emitted));
        }
    }
    // Remaining simple field-def keys (sort, stack, title, format, ...)
    for (key, value) in channel {
        if matches!(key.as_str(), "field" | "type" | "aggregate" | "bin" | "timeUnit" | "scale" | "axis" | "legend") {
            continue;
        }
        let dsl_key = to_snake_case(key);
        let as_ident = matches!(dsl_key.as_str(), "field" | "aggregate" | "time_unit");
        if let Some(emitted) = emit_value(value, as_ident) {
            parts.push(assignment(&dsl_key, &emitted));
        }
    }
    format!("{channel_name} => ({})", parts.join(", "))
}

/// `EmitResolveMap`
fn emit_resolve_map(value: &Value) -> Option<String> {
    let parts: Vec<String> = value
        .as_object()?
        .iter()
        .filter_map(|(key, value)| Some(assignment(channel_keyword(key)?, &emit_scalar(value, true)?)))
        .collect();
    (!parts.is_empty()).then(|| parenthesize(&parts))
}

/// A block of items, one per line, between an opening line and a closing line
fn block(open: String, items: &[String], close: String) -> String {
    format!("{open}\n{}\n{close}", items.join(",\n"))
}

/// `AppendVegaLiteSpecLines`
fn append_spec_lines(spec: &Object, lines: &mut Vec<String>, indent: &str) {
    match spec.get("mark") {
        Some(Value::String(mark)) => lines.push(format!("{indent}mark => {}", mark.to_ascii_lowercase())),
        Some(Value::Object(mark)) => match mark.get("type").and_then(lower_string) {
            Some(ty) if mark.len() == 1 => lines.push(format!("{indent}mark => {ty}")),
            _ if !mark.is_empty() => lines.push(format!("{indent}mark => {}", emit_mark(mark))),
            _ => {}
        },
        _ => {}
    }

    if let Some(title) = spec.get("title").and_then(Value::as_str) {
        lines.push(format!("{indent}title => {}", emit_string_literal(title)));
    }

    if let Some(encoding) = spec.get("encoding").and_then(Value::as_object) {
        let channels: Vec<String> = encoding
            .iter()
            .filter_map(|(key, value)| {
                let channel = value.as_object()?;
                Some(format!("{indent}  {}", emit_channel(channel_keyword(key)?, channel)))
            })
            .collect();
        if !channels.is_empty() {
            lines.push(block(format!("{indent}encoding => ("), &channels, format!("{indent})")));
        }
    }

    if let Some(layer_specs) = spec.get("layer").and_then(Value::as_array) {
        let layer_indent = format!("{indent}    ");
        let mut layers = Vec::new();
        for layer in layer_specs.iter().filter_map(Value::as_object) {
            let mut layer_lines = Vec::new();
            append_spec_lines(layer, &mut layer_lines, &layer_indent);
            if !layer_lines.is_empty() {
                layers.push(block(format!("{indent}  ("), &layer_lines, format!("{indent}  )")));
            }
        }
        if !layers.is_empty() {
            lines.push(block(format!("{indent}layer => ["), &layers, format!("{indent}]")));
        }
    }

    if let Some(resolve) = spec.get("resolve").and_then(Value::as_object) {
        let parts: Vec<String> = ["scale", "axis", "legend"]
            .into_iter()
            .filter_map(|key| Some(assignment(key, &emit_resolve_map(resolve.get(key)?)?)))
            .collect();
        if !parts.is_empty() {
            lines.push(format!("{indent}resolve => ({})", parts.join(", ")));
        }
    }
}

/// The query before the VISUALIZE clause, from `$sql` or `$raw` of the `data` member (`EmitSource`)
fn emit_source(data: &Value) -> Option<&str> {
    let data = data.as_object()?;
    let text = ["$sql", "$raw"].into_iter().find_map(|key| data.get(key).and_then(Value::as_str))?;
    (!text.is_empty()).then_some(text)
}

/// Parse a Vega-Lite spec and produce a pretty-printed VISUALIZE statement (`ParseVegaLiteToVisualize`).
///
/// Empty if the spec is not a JSON object or has no source.
pub fn parse_vegalite_to_visualize(vegalite_json: impl AsRef<[u8]>) -> String {
    let Ok(Value::Object(root)) = serde_json::from_slice(vegalite_json.as_ref()) else {
        return String::new();
    };
    let Some(source) = root.get("data").and_then(emit_source) else {
        return String::new();
    };
    let mut lines = Vec::new();
    append_spec_lines(&root, &mut lines, "  ");
    format!("{source}\nVISUALIZE USING vegalite (\n{}\n);", lines.join(",\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_numbers_without_losing_digits() {
        for (json, literal) in [
            ("1", "1"),
            ("-12", "-12"),
            ("1.0", "1.0"),
            ("1234567.0", "1234567.0"),
            ("123456.7", "123456.7"),
            ("0.1", "0.1"),
            ("0.00001234", "1.234e-5"),
            ("1e300", "1e300"),
            ("18446744073709551615", "18446744073709551615"),
        ] {
            let number: Number = serde_json::from_str(json).unwrap();
            assert_eq!(emit_number(&number), literal, "{json}");
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
        // Only standard JSON is accepted
        assert_eq!(roundtrip(r#"{"data":{"$sql":"x"},}"#), "");
        assert_eq!(roundtrip("{\"data\":{\"$sql\":\"x\"}} // c"), "");
        assert_eq!(roundtrip("{\"data\":{\"$sql\":\"x\"}}\0"), "");
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
                "    x => (field => \"a b\", type => nominal, sort => ['x', 1.5e20], label_angle => 3)\n",
                "  ),\n",
                "  resolve => (scale => (x => independent))\n",
                ");"
            )
        );
    }

    #[test]
    fn emits_numbers() {
        assert_eq!(
            roundtrip(r#"{"data":{"$raw":"r"},"encoding":{"x":{"sort":[1, -2, 18446744073709551615, -0, 2.0, 0.25]}}}"#),
            "r\nVISUALIZE USING vegalite (\n  encoding => (\n    x => (sort => [1, -2, 18446744073709551615, -0.0, 2.0, 0.25])\n  )\n);"
        );
    }
}
