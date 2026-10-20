//! The Rust visualization port must produce exactly the output of the C++ core.
//!
//! Compares the generated Vega-Lite JSON, its round trip through the Vega-Lite parser, the compiled Markdown and
//! UMAP specs and the dashboard layout of every visualization (`dashql_oracle::visualize`) on:
//!   - every visualize snapshot case and the prefixes of its script,
//!   - every snapshot input of every category that contains VISUALIZE, alone and against the visualize snapshot
//!     catalogs, and their prefixes,
//!   - deterministic fuzz inputs that vary the keys and values of vis specs.
//!
//! The Vega-Lite parser and the Markdown compiler are also compared directly on the generated specs, on mutated
//! and fuzzed JSON, and on fuzzed Markdown templates.

use dashql_core::visualize::{compile_markdown_template, parse_vegalite_to_visualize_bytes};
use dashql_snapshots::corpus::{prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::encode::visualize::{analyze_scripts, dump_markdown, dump_visualizations};
use dashql_snapshots::{load_category, run, Arguments, Failed, Trial};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

/// Comparison statistics, printed at the end
static SCRIPTS: AtomicUsize = AtomicUsize::new(0);
static SPECS: AtomicUsize = AtomicUsize::new(0);
static ROUNDTRIPS: AtomicUsize = AtomicUsize::new(0);
static VEGALITE_PARSES: AtomicUsize = AtomicUsize::new(0);
static VEGALITE_STATEMENTS: AtomicUsize = AtomicUsize::new(0);
static MARKDOWN_TEMPLATES: AtomicUsize = AtomicUsize::new(0);
static MARKDOWN_NODES: AtomicUsize = AtomicUsize::new(0);

/// Show the first difference of two dumps
fn first_difference(expected: &str, actual: &str) -> String {
    // Without the length prefixes of the JSON texts
    let strip = |s: &str| -> Vec<u8> {
        let mut out = String::new();
        let mut rest = s;
        while let Some(at) = rest.find("vegalite ").or_else(|| rest.find("roundtrip ")) {
            let (head, tail) = rest.split_at(at);
            out.push_str(head);
            let space = tail.find(' ').unwrap() + 1;
            out.push_str(&tail[..space]);
            let tail = &tail[space..];
            rest = match tail.find(':') {
                Some(colon) if tail[..colon].bytes().all(|c| c.is_ascii_digit()) => &tail[colon + 1..],
                _ => tail,
            };
        }
        out.push_str(rest);
        out.into_bytes()
    };
    let (e, a) = (strip(expected), strip(actual));
    let (e, a) = (&e[..], &a[..]);
    let at = e.iter().zip(a).position(|(x, y)| x != y).unwrap_or(e.len().min(a.len()));
    let begin = at.saturating_sub(120);
    let context = |s: &[u8]| String::from_utf8_lossy(&s[begin.min(s.len())..(at + 80).min(s.len())]).into_owned();
    format!("at byte {at}\n  C++:  {:?}\n  Rust: {:?}", context(e), context(a))
}

/// Compare the visualizations of a script
fn compare_visualizations(catalog: Option<&str>, text: &str) -> Result<(), String> {
    let expected = dashql_oracle::visualize::visualize(catalog, text);
    let actual = analyze_scripts(catalog, text).map(|analyzed| dump_visualizations(&analyzed));
    SCRIPTS.fetch_add(1, Relaxed);
    match (expected, actual) {
        (Ok(e), Ok(a)) if e == a => {
            SPECS.fetch_add(e.matches("\nvegalite ").count(), Relaxed);
            let roundtrips = e.lines().filter(|l| l.starts_with("roundtrip ") && !l.starts_with("roundtrip 0:"));
            ROUNDTRIPS.fetch_add(roundtrips.count(), Relaxed);
            MARKDOWN_NODES.fetch_add(e.lines().filter(|l| l.starts_with("  ")).count(), Relaxed);
            Ok(())
        }
        (Ok(e), Ok(a)) => Err(format!("catalog {catalog:?}\nscript {text:?}\n{}", first_difference(&e, &a))),
        // Both fail, e.g. on a function name the C++ analyzer cannot read
        (Err(_), Err(_)) => Ok(()),
        (e, a) => Err(format!("catalog {catalog:?}\nscript {text:?}\nC++: {:?}\nRust: {:?}", e.err(), a.err())),
    }
}

/// Compare the Vega-Lite parser on a JSON text
fn compare_vegalite(json: &[u8]) -> Result<(), String> {
    let expected = dashql_oracle::visualize::parse_vegalite(json)?;
    let actual = parse_vegalite_to_visualize_bytes(json);
    VEGALITE_PARSES.fetch_add(1, Relaxed);
    if !expected.is_empty() {
        VEGALITE_STATEMENTS.fetch_add(1, Relaxed);
    }
    if expected != actual {
        return Err(format!(
            "json {:?}\nC++:  {:?}\nRust: {:?}",
            String::from_utf8_lossy(json),
            String::from_utf8_lossy(&expected),
            String::from_utf8_lossy(&actual)
        ));
    }
    Ok(())
}

/// Compare the Markdown compiler on a template
fn compare_markdown(template: &str) -> Result<(), String> {
    let expected = dashql_oracle::visualize::compile_markdown(template)?;
    let mut actual = String::new();
    dump_markdown(&mut actual, compile_markdown_template(template).as_ref());
    MARKDOWN_TEMPLATES.fetch_add(1, Relaxed);
    MARKDOWN_NODES.fetch_add(expected.lines().count(), Relaxed);
    if expected != actual {
        return Err(format!("template {template:?}\n{}", first_difference(&expected, &actual)));
    }
    Ok(())
}

/// The Vega-Lite JSON texts of a dump
fn dumped_vegalite(dump: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = dump;
    while let Some(at) = rest.find("\nvegalite ") {
        let tail = &rest[at + "\nvegalite ".len()..];
        let (len, tail) = tail.split_once(':').unwrap();
        let len: usize = len.parse().unwrap();
        out.push(tail[..len].to_string());
        rest = &tail[len..];
    }
    out
}

/// Constants (`sql_a_expr_const`)
const CONSTANTS: &[&str] = &[
    "1", "0", "2", "15", "2.5", "0.1", "1.", ".5", "1e3", "1e400", "1e-400", "9223372036854775807",
    "9223372036854775808", "18446744073709551616", "1.5e300", "''", "'a'", "'a''b'", "'x y'", "'\"q\"'", "'1.5'",
    "'-2'", "'true'", "'false'", "true", "false", "null", "'zero'", "'normalize'", "'center'", "'nan'", "'inf'",
    "'viridis'", "'monotone'", "'bottom'", "'gradient'", "'é'", "'line\nbreak'", "'tab\tx'", "'back\\slash'",
    "'nul\0x'", "'{{a}}'", "'''quoted'''", "'2024-01-01'",
];

/// Column references and function calls
const COLUMNS: &[&str] = &[
    "a", "b", "c", "x", "\"Quoted Name\"", "\"a\"\"b\"", "a.b", "t.a", "nan", "inf", "independent", "shared",
    "month", "sum", "count(*)", "sum(b)", "lower('x')", "embedding", "cluster_id", "name", "product", "revenue",
];

const MARK_TYPES: &[&str] = &[
    "arc", "area", "bar", "boxplot", "circle", "geoshape", "image", "line", "point", "rect", "rule", "square",
    "text", "tick", "trail",
];
const SPEC_KEYS: &[&str] = &[
    "data", "transform", "params", "projection", "autosize", "datasets", "view", "name", "title", "padding",
    "background", "filter", "describe", "type",
];
const MARK_KEYS: &[&str] = &[
    "filled", "fill", "stroke", "color", "opacity", "fill_opacity", "stroke_opacity", "stroke_width", "stroke_dash",
    "size", "shape", "angle", "radius", "corner_radius", "orient", "interpolate", "tension", "thickness", "tooltip",
];
const CHANNEL_KEYS: &[&str] = &[
    "x", "y", "x2", "y2", "color", "fill", "stroke", "fill_opacity", "stroke_opacity", "stroke_width",
    "stroke_dash", "opacity", "size", "shape", "angle", "theta", "theta2", "radius", "radius2", "detail", "order",
    "tooltip", "text", "row", "column", "facet", "href", "url", "key", "latitude", "longitude", "latitude2",
    "longitude2", "x_offset", "y_offset",
];
const FIELD_DEF_KEYS: &[&str] = &[
    "field", "field", "field", "bin", "aggregate", "time_unit", "sort", "stack", "stack", "impute", "condition",
    "title", "band_position", "datum", "value", "format", "format_type",
];
const FIELD_TYPES: &[&str] = &["nominal", "ordinal", "quantitative", "temporal", "geojson", "'nominal'", "1"];
const SCALE_TYPES: &[&str] = &[
    "linear", "log", "pow", "sqrt", "symlog", "identity", "sequential", "time", "utc", "quantile", "quantize",
    "threshold", "ordinal", "band", "point", "'log'",
];
const SCALE_KEYS: &[&str] = &[
    "domain", "domain_min", "domain_max", "domain_mid", "range", "range_min", "range_max", "scheme", "interpolate",
    "nice", "zero", "clamp", "padding", "padding_inner", "padding_outer", "reverse", "round", "exponent", "bins",
    "name",
];
const AXIS_KEYS: &[&str] = &[
    "orient", "format", "format_type", "grid", "ticks", "tick_count", "tick_size", "label_angle", "label_font_size",
    "label_overlap", "direction", "offset", "values", "z_index", "title", "domain", "name",
];
const LEGEND_KEYS: &[&str] = &[
    "type", "orient", "format", "format_type", "direction", "title", "values", "padding", "offset", "z_index", "name",
];

/// A comma-separated list of `n` generated items, sometimes with empty entries
fn list(rng: &mut Rng, max: usize, mut item: impl FnMut(&mut Rng) -> String) -> String {
    let n = rng.below(max + 1);
    let mut items: Vec<String> = (0..n).map(|_| item(rng)).collect();
    if rng.below(16) == 0 {
        items.push(String::new());
    }
    items.join(", ")
}

/// An array (`vararg_array_brackets`)
fn random_array(rng: &mut Rng, depth: usize) -> String {
    let elements = list(rng, 4, |rng| match rng.below(10) {
        0..=4 => rng.pick(CONSTANTS).to_string(),
        5 => format!("-{}", rng.pick(CONSTANTS)),
        6 | 7 => rng.pick(COLUMNS).to_string(),
        8 if depth < 2 => random_array(rng, depth + 1),
        _ => "(k = 1)".to_string(),
    });
    format!("[{elements}]")
}

/// A value (`vis_value`)
fn random_value(rng: &mut Rng, depth: usize) -> String {
    match rng.below(12) {
        0..=4 => rng.pick(CONSTANTS).to_string(),
        5 => format!("{}{}", rng.pick(&["-", "+"]), rng.pick(CONSTANTS)),
        6..=8 => rng.pick(COLUMNS).to_string(),
        9 | 10 => random_array(rng, 0),
        _ if depth < 3 => format!("({})", random_spec_fields(rng, depth + 1, false)),
        _ => rng.pick(CONSTANTS).to_string(),
    }
}

/// A mark definition (`vis_mark_list`)
fn random_mark_list(rng: &mut Rng, depth: usize) -> String {
    list(rng, 4, |rng| match rng.below(6) {
        0 | 1 => format!("type => {}", rng.pick(MARK_TYPES)),
        2 | 3 if depth < 2 => {
            let overlay = if rng.below(2) == 0 {
                format!("({})", random_mark_list(rng, depth + 1))
            } else {
                rng.pick(&["true", "false", "1", "'x'", "null"]).to_string()
            };
            format!("{} => {overlay}", rng.pick(&["point", "line"]))
        }
        _ => format!("{} => {}", rng.pick(MARK_KEYS), random_value(rng, depth + 1)),
    })
}

/// A field definition (`vis_fielddef_list`)
fn random_field_def(rng: &mut Rng, depth: usize) -> String {
    list(rng, 5, |rng| match rng.below(10) {
        0 => format!(
            "scale => ({})",
            list(rng, 4, |rng| if rng.below(4) == 0 {
                format!("type => {}", rng.pick(SCALE_TYPES))
            } else {
                format!("{} => {}", rng.pick(SCALE_KEYS), random_value(rng, depth + 1))
            })
        ),
        1 => format!(
            "axis => ({})",
            list(rng, 4, |rng| format!("{} => {}", rng.pick(AXIS_KEYS), random_value(rng, depth + 1)))
        ),
        2 => format!(
            "legend => ({})",
            list(rng, 4, |rng| format!("{} => {}", rng.pick(LEGEND_KEYS), random_value(rng, depth + 1)))
        ),
        3 | 4 => format!("type => {}", rng.pick(FIELD_TYPES)),
        _ => format!("{} => {}", rng.pick(FIELD_DEF_KEYS), random_value(rng, depth + 1)),
    })
}

/// An encoding (`vis_encoding_list`)
fn random_encoding(rng: &mut Rng, depth: usize) -> String {
    list(rng, 4, |rng| {
        let value = match rng.below(6) {
            0..=3 => format!("({})", random_field_def(rng, depth)),
            4 => random_array(rng, 0),
            _ => rng.pick(COLUMNS).to_string(),
        };
        format!("{} => {value}", rng.pick(CHANNEL_KEYS))
    })
}

/// A resolve map (`vis_resolve_list`)
fn random_resolve(rng: &mut Rng) -> String {
    list(rng, 3, |rng| {
        let map = list(rng, 3, |rng| {
            let value = rng.pick(&["independent", "shared", "'independent'", "1", "x.y", "true"]);
            format!("{} => {value}", rng.pick(CHANNEL_KEYS))
        });
        format!("{} => ({map})", rng.pick(&["scale", "axis", "legend"]))
    })
}

/// A dashboard placement
fn random_dashboard(rng: &mut Rng) -> String {
    let fields = list(rng, 4, |rng| {
        format!(
            "{} => {}",
            rng.pick(&["row", "column", "width", "height"]),
            rng.pick(&["0", "1", "2", "6", "12", "13", "-1", "+3", "100", "99999999999"])
        )
    });
    format!("dashboard => ({fields})")
}

/// The fields of a Vega-Lite spec (`vis_spec_list`)
fn random_spec_fields(rng: &mut Rng, depth: usize, root: bool) -> String {
    list(rng, 4, |rng| match rng.below(12) {
        0..=2 => format!("encoding => ({})", random_encoding(rng, depth)),
        3 if depth < 2 => {
            let layers = list(rng, 3, |rng| format!("({})", random_spec_fields(rng, depth + 1, false)));
            if layers.is_empty() {
                "layer => [(mark => bar)]".to_string()
            } else {
                format!("layer => [{layers}]")
            }
        }
        4 => format!("resolve => ({})", random_resolve(rng)),
        5 | 6 => format!("mark => {}", rng.pick(MARK_TYPES)),
        7 => format!("mark => ({})", random_mark_list(rng, depth)),
        8 if root => random_dashboard(rng),
        _ => format!("{} => {}", rng.pick(SPEC_KEYS), random_value(rng, depth + 1)),
    })
}

/// A random VISUALIZE statement of any renderer
fn random_statement(rng: &mut Rng) -> String {
    let source = rng.pick(&[
        "select a, b, c from t",
        "select * from t where a > 0",
        "select a as x, sum(b) as y from t group by a",
        "select 1 as value, 'x' as label",
        "select embedding, cluster_id, name from embeddings",
        "select product, revenue from product_summary",
        "with q as (select a from t) select * from q",
    ]);
    let keyword = rng.pick(&["visualize", "VISUALIZE", "visualise"]);
    match rng.below(10) {
        0 | 1 => {
            let template = random_markdown(rng).replace('\'', "''");
            let mut fields = vec![format!("template => '{template}'")];
            if rng.below(3) == 0 {
                fields.push(random_dashboard(rng));
            }
            format!("{source} {keyword} using markdown ({})", fields.join(", "))
        }
        2 => {
            let fields = list(rng, 5, |rng| match rng.below(4) {
                0 => format!("{} => {}", rng.pick(&["vector", "category", "label"]), rng.pick(COLUMNS)),
                1 => {
                    let key = rng.pick(&["neighbors", "min_dist"]);
                    format!("{key} => {}{}", rng.pick(&["", "-", "+"]), rng.pick(CONSTANTS))
                }
                2 => format!("metric => {}", rng.pick(&["cosine", "euclidean"])),
                _ => random_dashboard(rng),
            });
            format!("{source} {keyword} using umap ({fields})")
        }
        3 => {
            let dashboard = if rng.below(2) == 0 { random_dashboard(rng) } else { String::new() };
            format!("{source} {keyword} using table ({dashboard})")
        }
        _ => format!("{source} {keyword} using vegalite ({})", random_spec_fields(rng, 0, true)),
    }
}

/// Markdown fragments
const MARKDOWN_FRAGMENTS: &[&str] = &[
    "# ", "## ", "###### ", "####### ", "{{a}}", "{{ b }}", "{{}}", "{{", "}}", "text", " ", "  ", "\n", "\n\n",
    "\r\n", "\t", "*", "**", "***", "_", "__", "`", "``", "```", "~~~", "\\", "\\*", "\\\n", "&amp;", "&#65;",
    "&#x1F600;", "&#0;", "&bogus;", "&ngE;", "&", ";", "<", ">", "<div>", "</div>", "<b>", "<!-- c -->", "<?x?>",
    "<!X>", "<![CDATA[x]]>", "<script>", "</script>", "<https://x.y>", "<a@b.c>", "[", "]", "[a]", "[a]: /url",
    "[a]: <u v> 'T'", "[A]", "[a][]", "[a][A]", "![i]", "![i](/p.png \"t\")", "[l](http://x \"t\")",
    "[l](javascript:x)", "[l]({{a}})", "[l](/u '{{b}}')", "(", ")", "- ", "* ", "+ ", "1. ", "2) ", "> ", ">", "---",
    "***\n", "===", "    ", "\0", "é", "ü*", "*ü", "\u{a0}", "„", "1", "a_b", "_a_", "*a*", "**a**", "`c`",
];

/// A random Markdown template
fn random_markdown(rng: &mut Rng) -> String {
    let n = rng.below(24);
    (0..n).map(|_| *rng.pick(MARKDOWN_FRAGMENTS)).collect()
}

/// Vega-Lite specs for the quirks of the parser
const HANDCRAFTED_VEGALITE: &[&str] = &[
    "",
    "[]",
    r#"{"mark":"bar"}"#,
    r#"{"data":{"$sql":""}}"#,
    r#"{"data":{"$sql":1, "$raw":"x"}}"#,
    r#"{"data":{"$sql":"x"},}"#,
    "{\"data\":{\"$sql\":\"x\"}} // c",
    r#"{"data":{"$sql":"SELECT 1"},"mark":{"type":"Bar","opacity":0.5,"point":{"filled":true}},
        "encoding":{"x":{"field":"a b","type":"Nominal","sort":["x",1.5e20],"labelAngle":3},"foo":{}},
        "resolve":{"scale":{"x":"independent","bogus":"y"}}}"#,
    // Duplicate keys: lookups take the first member, iterations see all of them
    r#"{"data":{"$sql":"a"},"data":{"$sql":"b"},"title":"t1","title":"t2","encoding":{"x":{"field":"f"},"x":{"field":"g"}}}"#,
    // NUL bytes: C strings are cut, member names are compared with their length
    r#"{"data":{"$sql":"a\u0000b"},"mark":{"type\u0000x":"bar","po\u0000":true},"encoding":{"x":{"field":"a\u0000b","type\u0000":"q"}}}"#,
    // Numbers
    r#"{"data":{"$raw":"r"},"encoding":{"x":{"sort":[1e15,999999999999999,1e-5,0.1,123456.7,1234567,-0,-0.0,1.0,4294967296,-2147483649,18446744073709551615,9e308,1e-320]}}}"#,
    // Marks
    r#"{"data":{"$raw":"r"},"mark":{"type":7}}"#,
    r#"{"data":{"$raw":"r"},"mark":{}}"#,
    r#"{"data":{"$raw":"r"},"mark":{"Type":"bar","strokeDash":[1,"a",null,{},true],"line":{"point":{}}}}"#,
    // Layers and resolve
    r#"{"data":{"$raw":"r"},"layer":[1,{},{"mark":"a","layer":[{"title":"x"}]}],"resolve":{"axis":{"x":1.5,"yOffset":null,"color":"a b"},"legend":3}}"#,
    // Bins, scales, axes and legends
    r#"{"data":{"$raw":"r"},"encoding":{"y":{"bin":{"maxbins":10,"x":{}},"scale":{"type":"LOG","domainMin":1,"zero":false},"axis":{},"legend":{"labelAngle":45,"zIndex":2}},"x":{"bin":{},"timeUnit":"month day","aggregate":"sum","Field":"F","time_unit":"t"}}}"#,
];

/// Markdown templates that exercise md4c quirks
const HANDCRAFTED_MARKDOWN: &[&str] = &[
    // A list item paragraph line starting at offset 4 looks like an MD_BLOCK_LI header to the empty list item check
    "-   a\n\n\n  b",
    "-   a\n\n\n    b",
    "- a\n\n\n  b",
    "-\n\n  b",
    "1.  a\n\n\n    b",
    // Reference definitions: duplicates, case folding, whitespace, multi-line labels and titles, hash collisions
    "[foo]\n\n[foo]: /a\n[FOO]: /b\n[Foo]: /c",
    "[ẞ]\n\n[SS]: /ss\n[ß]: /sz",
    "[a  b]\n\n[a\nb]: /x",
    "[a\nb]\n\n[a b]: /x 'multi\nline'",
    "[x1] [x2] [x3] [x4] [x5] [x6]\n\n[x1]: /1\n[x2]: /2\n[x3]: /3\n[x4]: /4\n[x5]: /5\n[x6]: /6\n[x7]: /7",
    "[l]: /url\n\"title\" ok\n\n[l]",
    "[l]: /url \"title\" ok\n\n[l]",
    "> [q]: /q\n\n[q]",
    "[full][ref] [collapsed][] [shortcut] ![img][ref]\n\n[ref]: /r\n[collapsed]: /c\n[shortcut]: /s",
    "Setext\n[d]: /d\n===",
    "[d]: /d\n===\n\n[d]",
    // Code spans, fences and indentation
    "`a\nb` ``a `` ` b `",
    "```\n\0code\0\0x\n```",
    "    \0a\n\n    b\0",
    "- ```\n  a\n ```\n- b",
    "```a`b\nx",
    "\t\tcode\n  \tmore",
    // HTML blocks of every type
    "<pre>\na\n</pre>\nafter",
    "<!-- c\n-->x",
    "<?x\n?>",
    "<!X\n>",
    "<![CDATA[\n]]>",
    "<div>\n*a*\n\nb",
    "<header>\nx",
    "<custom-tag>\nx",
    "para\n<custom-tag>\nx",
    "<!-->",
    "a <b>c</b> <!-- d --> e",
    // Emphasis and the rule of three
    "*a **b** c*", "***a* b**", "**a*b***", "_a_b_", "*a_b*", "„*a*„", "a*„b*", "*(*a*)*",
    // Links
    "[a](<b c> 'd') [e](f(g)h) [i](j \"k\" ) [l]( m )",
    "[a](b\n'c')", "[a](\n'c')", "[a]( ", "[a](`b)`", "[[a](b)](c)", "![[a](b)](c)",
    "<http://a.b/c?d#e> <mailto:x> <a@b-.c> <a@-b.c> <ab:c>",
    "&#0; &#x110000; &#xD800; &#55296; &amp &ThisEntityDoesNotExist; &CounterClockwiseContourIntegral;",
    // The templates of the unit tests in dashql-core/src/visualize/markdown/tests.rs
    "{{ a }} {{b}} {{a}} {{}} {{ ",
    "a\\*b &amp; c",
    "&bogus; &#x41;",
    "a\0b",
    "# H1 #\n\nSetext\n---",
    "- a\n- b\n\n1) c",
    "- a\n\n- b",
    "```sql x\nselect\n```\n\n    code",
    "<div>\nhtml\n</div>\n\n***",
    "> q\n",
    "[a][ref] ![img](/x.png \"t\") <https://x.y> <me@x.y> [bad](javascript:x)\n\n[REF]: http://r 'T'",
    "[x]({{f}} \"{{f}}\")",
    "***a** b*",
    "a_b_c *x*",
    "`` a`b ``",
    "a  \nb\\\nc",
    "    a\0b",
];

/// Line prefixes: indentation and container marks
const LINE_PREFIXES: &[&str] = &[
    "", "", "", " ", "  ", "   ", "    ", "     ", "\t", " \t", "> ", ">", "> > ", "- ", "* ", "+ ", "-", "1. ", "2) ",
    "10. ", "1234567890. ", "0. ", "-   ", "- > ", "> - ", "  - ", "    - ", "1.  ", "-\t",
];

/// Line contents
const LINE_CONTENTS: &[&str] = &[
    "", "", "text", "more text", "{{a}}", "# h", "## h ##", "#h", "####### x", "```", "```sql", "``` x y", "~~~",
    "~~~~ lang", "```a`b", "---", "***", "___", "- - -", "===", "--", "[a]: /url", "[a]: /url 'title'", "[a]:",
    "[a]: <u> \"t\" junk", "[b]:\n/url", "'title'", "[a]", "[a][b]", "[A]", "<div>", "</div>", "<!--", "-->",
    "<pre>", "</pre>", "<script>x</script>", "<?php", "?>", "<!DOCTYPE x>", "<![CDATA[", "]]>", "<b>", "<a href='x'>",
    "*a* **b**", "`code", "span`", "[link", "](url)", "](u \"t", "\"t\")", "> quote", "- item", "1. item",
    "a  ", "b\\", "&amp; &copy; &#x;", "x_y_", "*", "**", "_", "<http://a.b>", "<x@y.z>", "![i](u)", "\0",
    "é ü", "a\tb", "|a|b|", "{{ b }}",
];

/// A random line-based Markdown template, for block structure
fn random_markdown_lines(rng: &mut Rng) -> String {
    let n = 1 + rng.below(12);
    let mut out = String::new();
    for i in 0..n {
        if i > 0 {
            out.push_str(if rng.below(16) == 0 { "\r\n" } else { "\n" });
        }
        for _ in 0..rng.below(3) {
            out.push_str(*rng.pick::<&str>(LINE_PREFIXES));
        }
        out.push_str(*rng.pick::<&str>(LINE_CONTENTS));
        if rng.below(4) == 0 {
            out.push(' ');
            out.push_str(*rng.pick::<&str>(MARKDOWN_FRAGMENTS));
        }
    }
    out
}

/// JSON fragments of Vega-Lite specs
fn random_json(rng: &mut Rng, depth: usize) -> String {
    let scalars = [
        "\"bar\"", "\"Bar\"", "\"a b\"", "\"a\\\"b\"", "\"it's\"", "\"x\\u0000y\"", "\"\\u00e9\"", "\"\\udc00\"",
        "\"type\\u0000x\"", "1", "-1", "0", "-0", "1.0", "2.5", "1e15", "1.5e20", "123456789", "4294967296",
        "-2147483649", "18446744073709551615", "1e-7", "0.000123456789", "9e308", "true", "false", "null", "\"\"",
        "\"SELECT 1\"", "\"field\"", "\"monthdate\"",
    ];
    let keys = [
        "data", "$sql", "$raw", "mark", "title", "encoding", "layer", "resolve", "scale", "axis", "legend", "type",
        "field", "aggregate", "bin", "timeUnit", "stack", "sort", "labelAngle", "Field", "time_unit", "x", "y",
        "color", "xOffset", "strokeDash", "point", "line", "filled", "maxbins", "domain", "domainMin", "foo",
        "type\\u0000x", "",
    ];
    match rng.below(if depth < 4 { 6 } else { 3 }) {
        0..=2 => rng.pick(&scalars).to_string(),
        3 => {
            let n = rng.below(4);
            let elements: Vec<String> = (0..n).map(|_| random_json(rng, depth + 1)).collect();
            format!("[{}]", elements.join(","))
        }
        _ => {
            let n = rng.below(5);
            let members: Vec<String> =
                (0..n).map(|_| format!("\"{}\":{}", rng.pick(&keys), random_json(rng, depth + 1))).collect();
            format!("{{{}}}", members.join(","))
        }
    }
}

/// A random Vega-Lite spec with a source
fn random_spec(rng: &mut Rng) -> String {
    let mut members = vec![format!(
        "\"data\":{}",
        rng.pick(&[
            "{\"$sql\":\"SELECT 1\"}",
            "{\"$raw\":\"r\"}",
            "{\"$sql\":\"\"}",
            "{}",
            "1",
            "{\"$sql\":\"a\\u0000b\"}",
        ])
    )];
    for _ in 0..rng.below(6) {
        let key = rng.pick(&["mark", "title", "encoding", "layer", "resolve", "foo", "data"]);
        members.push(format!("\"{key}\":{}", random_json(rng, 1)));
    }
    let (i, j) = (rng.below(members.len()), rng.below(members.len()));
    members.swap(i, j);
    format!("{{{}}}", members.join(","))
}

/// Mutations of a JSON text: truncations, trailing garbage, comments and commas
fn json_mutations(json: &str) -> Vec<Vec<u8>> {
    let mut out = vec![json.as_bytes().to_vec()];
    for prefix in prefixes(json, 12) {
        out.push(prefix.as_bytes().to_vec());
    }
    out.push(format!("{json} x").into_bytes());
    out.push(format!("{json}\0junk").into_bytes());
    out.push(format!("// c\n{json}").into_bytes());
    out.push(json.replacen('}', ",}", 1).into_bytes());
    out.push(json.replace('\n', "").into_bytes());
    out
}

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();

    // The visualize snapshot cases and their catalogs
    let trim = |s: &str| s.trim_matches([' ', '\n']).to_string();
    let mut catalogs: Vec<String> = Vec::new();
    for case in load_category("visualize").expect("cannot load visualize snapshots") {
        let main = case.node["script"]["input"].as_str().map(trim).unwrap_or_default();
        let catalog = case.node["catalog"]["script"]["input"].as_str().map(trim);
        if let Some(c) = &catalog {
            if !catalogs.contains(c) {
                catalogs.push(c.clone());
            }
        }
        trials.push(Trial::test(format!("snapshot::{}", case.trial_name()), move || {
            compare_visualizations(catalog.as_deref(), &main).map_err(Failed::from)?;
            for prefix in prefixes(&main, 64) {
                compare_visualizations(catalog.as_deref(), prefix).map_err(Failed::from)?;
            }
            // The generated specs through the Vega-Lite parser, with mutations
            let dump = dashql_oracle::visualize::visualize(catalog.as_deref(), &main).map_err(Failed::from)?;
            for json in dumped_vegalite(&dump) {
                for mutation in json_mutations(&json) {
                    compare_vegalite(&mutation).map_err(Failed::from)?;
                }
            }
            Ok(())
        }));
    }

    // All snapshot inputs with VISUALIZE statements, alone and against the visualize catalogs
    for category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            let inputs: Vec<String> =
                inputs.into_iter().filter(|input| input.to_ascii_lowercase().contains("visualize")).collect();
            if inputs.is_empty() {
                continue;
            }
            let catalogs = catalogs.clone();
            trials.push(Trial::test(format!("inputs::{category}::{file}"), move || {
                let mut rng = Rng::new(inputs.len() as u64 + 7);
                for input in &inputs {
                    compare_visualizations(None, input).map_err(Failed::from)?;
                    let catalog = rng.pick(&catalogs);
                    compare_visualizations(Some(catalog), input).map_err(Failed::from)?;
                    for prefix in prefixes(input, 16) {
                        compare_visualizations(Some(catalog), prefix).map_err(Failed::from)?;
                    }
                }
                Ok(())
            }));
        }
    }

    // Fuzzed VISUALIZE statements
    let catalog = "create table t (a int, b int, c text); \
                   create table embeddings (embedding float[], cluster_id int, name text); \
                   create table product_summary (product text, revenue decimal)";
    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::statements::{batch}"), move || {
            let mut rng = Rng::new(0x5EC + batch);
            for _ in 0..1000 {
                let script = random_statement(&mut rng);
                let catalog = (rng.below(4) != 0).then_some(catalog);
                compare_visualizations(catalog, &script).map_err(Failed::from)?;
                if rng.below(8) == 0 {
                    for prefix in prefixes(&script, 8) {
                        compare_visualizations(catalog, prefix).map_err(Failed::from)?;
                    }
                }
            }
            Ok(())
        }));
    }

    // Fuzzed Vega-Lite JSON
    for batch in 0..8u64 {
        trials.push(Trial::test(format!("fuzz::vegalite::{batch}"), move || {
            let mut rng = Rng::new(0x7E6A + batch);
            for _ in 0..4000 {
                let spec = random_spec(&mut rng);
                compare_vegalite(spec.as_bytes()).map_err(Failed::from)?;
                if rng.below(16) == 0 {
                    for mutation in json_mutations(&spec) {
                        compare_vegalite(&mutation).map_err(Failed::from)?;
                    }
                }
            }
            Ok(())
        }));
    }

    // Handcrafted Vega-Lite specs, and the specs of the unit tests in dashql-core/src/visualize/vegalite_parser.rs
    trials.push(Trial::test("vegalite::handcrafted", || {
        for json in HANDCRAFTED_VEGALITE {
            compare_vegalite(json.as_bytes()).map_err(Failed::from)?;
        }
        Ok(())
    }));

    // Handcrafted Markdown templates for md4c quirks, and the templates of the unit tests
    trials.push(Trial::test("markdown::handcrafted", || {
        for template in HANDCRAFTED_MARKDOWN {
            compare_markdown(template).map_err(Failed::from)?;
        }
        Ok(())
    }));

    // Fuzzed line-based Markdown templates
    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::markdown_lines::{batch}"), move || {
            let mut rng = Rng::new(0x11E + batch);
            for _ in 0..4000 {
                compare_markdown(&random_markdown_lines(&mut rng)).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    // Fuzzed Markdown templates
    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::markdown::{batch}"), move || {
            let mut rng = Rng::new(0x3D + batch);
            for _ in 0..4000 {
                compare_markdown(&random_markdown(&mut rng)).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    let conclusion = run(&args, trials);
    eprintln!(
        "compared {} scripts with {} visualizations ({} round trips, {} markdown nodes), {} Vega-Lite texts ({} \
         statements), {} Markdown templates",
        SCRIPTS.load(Relaxed),
        SPECS.load(Relaxed),
        ROUNDTRIPS.load(Relaxed),
        MARKDOWN_NODES.load(Relaxed),
        VEGALITE_PARSES.load(Relaxed),
        VEGALITE_STATEMENTS.load(Relaxed),
        MARKDOWN_TEMPLATES.load(Relaxed),
    );
    conclusion.exit();
}
