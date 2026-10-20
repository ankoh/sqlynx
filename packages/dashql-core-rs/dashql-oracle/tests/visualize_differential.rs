//! The Rust visualization port must produce exactly the output of the C++ core. Doubles in generated JSON are
//! compared by value: the Rust core writes the shortest round-trip digits, the C++ core rapidjson's Grisu2.
//!
//! Markdown is compared by meaning only: the Rust core parses templates with pulldown-cmark, the C++ core with md4c.
//! See `normalize_markdown` for the differences that are accepted. Fuzzed templates hit CommonMark corner cases on
//! which the two parsers disagree (mostly md4c deviations from the spec), so they are only compiled by both
//! (`MarkdownCheck::Smoke`).
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
use dashql_snapshots::corpus::{canonical_numbers, prefixes, snapshot_inputs, Rng, CATEGORIES};
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
static MARKDOWN_SPECS: AtomicUsize = AtomicUsize::new(0);
static MARKDOWN_NODES: AtomicUsize = AtomicUsize::new(0);
static INVALID_CPP_JSON: AtomicUsize = AtomicUsize::new(0);

/// Show the first difference of two dumps
fn first_difference(expected: &str, actual: &str) -> String {
    let (e, a) = (expected.as_bytes(), actual.as_bytes());
    let at = e.iter().zip(a).position(|(x, y)| x != y).unwrap_or(e.len().min(a.len()));
    let begin = at.saturating_sub(120);
    let context = |s: &[u8]| String::from_utf8_lossy(&s[begin.min(s.len())..(at + 80).min(s.len())]).into_owned();
    format!("at byte {at}\n  C++:  {:?}\n  Rust: {:?}", context(e), context(a))
}

/// A dump with canonical doubles and without the length prefixes of the JSON texts, which depend on the digits
fn comparable(dump: &str) -> String {
    let mut out = String::new();
    let mut rest = dump;
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
    canonical_numbers(&out)
}

/// Does a dump contain a JSON key or array element without a value?
fn has_value_hole(dump: &str) -> bool {
    dump.lines().any(|line| {
        let line = line.strip_suffix(',').unwrap_or(line);
        line.ends_with("\": ") || (!line.is_empty() && line.trim().is_empty())
    })
}

/// How compiled Markdown specs are compared
#[derive(Clone, Copy, PartialEq)]
enum MarkdownCheck {
    /// The normalized documents are equal
    Semantic,
    /// Both cores compile the template, to the same fields
    Smoke,
}

/// Compare the visualizations of a script
fn compare_visualizations(catalog: Option<&str>, text: &str, check: MarkdownCheck) -> Result<(), String> {
    // The Markdown specs are taken out of the dumps and compared by meaning
    let split = |dump: String| {
        let (rest, markdown) = split_markdown(&dump);
        (comparable(&rest), markdown)
    };
    let expected = dashql_oracle::visualize::visualize(catalog, text).map(split);
    let actual = analyze_scripts(catalog, text).map(|analyzed| split(dump_visualizations(&analyzed)));
    SCRIPTS.fetch_add(1, Relaxed);
    match (expected, actual) {
        // C++ writes no value for an infinite double, so its JSON is invalid. Rust writes null.
        (Ok((e, _)), Ok(_)) if has_value_hole(&e) => {
            INVALID_CPP_JSON.fetch_add(1, Relaxed);
            Ok(())
        }
        (Ok((e, e_markdown)), Ok((a, a_markdown))) if e == a => {
            SPECS.fetch_add(e.matches("\nvegalite ").count(), Relaxed);
            let roundtrips = e.lines().filter(|l| l.starts_with("roundtrip ") && !l.starts_with("roundtrip 0:"));
            ROUNDTRIPS.fetch_add(roundtrips.count(), Relaxed);
            for (e, a) in e_markdown.into_iter().zip(a_markdown) {
                compare_markdown_specs(e, a, check)
                    .map_err(|error| format!("catalog {catalog:?}\nscript {text:?}\n{error}"))?;
            }
            Ok(())
        }
        (Ok((e, _)), Ok((a, _))) => Err(format!("catalog {catalog:?}\nscript {text:?}\n{}", first_difference(&e, &a))),
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

/// A node of a Markdown dump
#[derive(Debug, PartialEq)]
struct DumpedNode {
    node_type: String,
    value: String,
    url: String,
    title: String,
    language: String,
    level: String,
    start: String,
    ordered: String,
    tight: String,
    children: Vec<DumpedNode>,
}

impl DumpedNode {
    fn write(&self, out: &mut String, depth: usize) {
        let DumpedNode { node_type, value, url, title, language, level, start, ordered, tight, .. } = self;
        out.push_str(&format!(
            "{}{node_type} value={value:?} url={url:?} title={title:?} language={language:?} level={level} \
             start={start} ordered={ordered} tight={tight}\n",
            "  ".repeat(depth)
        ));
        self.children.iter().for_each(|child| child.write(out, depth + 1));
    }
}

/// A compiled Markdown spec, read from a dump
#[derive(Debug, PartialEq)]
struct DumpedMarkdown {
    template: String,
    fields: Vec<String>,
    document: DumpedNode,
}

impl DumpedMarkdown {
    fn to_text(&self) -> String {
        let mut out = format!("template={:?} fields={:?}\n", self.template, self.fields);
        self.document.write(&mut out, 0);
        out
    }
}

/// Reads the line format of the oracle dumps (see `dashql_oracle::visualize`)
struct DumpReader<'a> {
    rest: &'a str,
}

impl<'a> DumpReader<'a> {
    fn expect(&mut self, prefix: &str) {
        self.rest = self.rest.strip_prefix(prefix).unwrap_or_else(|| panic!("expected {prefix:?} at {:?}", self.rest));
    }

    /// The text up to a delimiter, which is consumed
    fn until(&mut self, delimiter: char) -> &'a str {
        let (head, tail) = self.rest.split_once(delimiter).expect("unterminated dump");
        self.rest = tail;
        head
    }

    /// A length-prefixed string
    fn string(&mut self) -> String {
        let length: usize = self.until(':').parse().expect("string length");
        let (value, tail) = self.rest.split_at(length);
        self.rest = tail;
        value.to_string()
    }

    /// A Markdown node at a depth with its children
    fn node(&mut self, depth: usize) -> DumpedNode {
        self.expect(&"  ".repeat(depth));
        let node_type = self.until(' ').to_string();
        let [value, url, title, language] = ["value", "url", "title", "language"].map(|key| {
            self.expect(key);
            self.expect("=");
            let value = self.string();
            self.expect(" ");
            value
        });
        let [level, start, ordered, tight] = ["level", "start", "ordered", "tight"].map(|key| {
            self.expect(key);
            self.expect("=");
            self.until(if key == "tight" { '\n' } else { ' ' }).to_string()
        });
        let mut children = Vec::new();
        let child_indentation = "  ".repeat(depth + 1);
        while self.rest.starts_with(&child_indentation) && !self.rest[child_indentation.len()..].starts_with(' ') {
            children.push(self.node(depth + 1));
        }
        DumpedNode { node_type, value, url, title, language, level, start, ordered, tight, children }
    }

    /// A compiled Markdown spec, `None` for `markdown: null`
    fn markdown(&mut self) -> Option<DumpedMarkdown> {
        if let Some(rest) = self.rest.strip_prefix("markdown: null\n") {
            self.rest = rest;
            return None;
        }
        self.expect("markdown template=");
        let template = self.string();
        self.expect(" fields=");
        let count = self.rest.find([' ', '\n']).expect("field count");
        let (count, rest) = self.rest.split_at(count);
        self.rest = rest;
        let fields = (0..count.parse().expect("field count"))
            .map(|_| {
                self.expect(" ");
                self.string()
            })
            .collect();
        self.expect("\n");
        Some(DumpedMarkdown { template, fields, document: self.node(1) })
    }
}

/// Take the Markdown specs out of a visualization dump. The rest gets a `markdown` line for each of them.
fn split_markdown(dump: &str) -> (String, Vec<Option<DumpedMarkdown>>) {
    let mut reader = DumpReader { rest: dump };
    let (mut rest, mut markdown) = (String::new(), Vec::new());
    while !reader.rest.is_empty() {
        let line = reader.rest;
        if line.starts_with("markdown") {
            markdown.push(reader.markdown());
            rest.push_str("markdown\n");
            continue;
        }
        // The JSON texts are length-prefixed strings that may contain line breaks
        if let Some(prefix) = ["vegalite ", "roundtrip "].into_iter().find(|prefix| line.starts_with(prefix)) {
            reader.expect(prefix);
            reader.string();
        }
        reader.until('\n');
        rest.push_str(&line[..line.len() - reader.rest.len()]);
    }
    (rest, markdown)
}

/// Normalize a document for the comparison of md4c and pulldown-cmark:
///   - Adjacent text nodes are merged and empty ones dropped. md4c cuts text at every mark, entity and line break.
///   - Whitespace at the end of a node is dropped. md4c keeps the trailing whitespace of a paragraph at the end of
///     the document and ends the last line of a code block with a line break that is not in the template.
///   - List tightness is not compared. pulldown-cmark does not report it, the Rust core derives it from the
///     paragraphs of the items, which are compared.
fn normalize_markdown(node: &mut DumpedNode) {
    node.tight.clear();
    let mut children: Vec<DumpedNode> = Vec::new();
    for mut child in std::mem::take(&mut node.children) {
        normalize_markdown(&mut child);
        match children.last_mut() {
            _ if child.node_type == "TEXT" && child.value.is_empty() => {}
            Some(last) if last.node_type == "TEXT" && child.node_type == "TEXT" => last.value += &child.value,
            _ => children.push(child),
        }
    }
    if let Some(last) = children.last_mut().filter(|last| last.node_type == "TEXT") {
        last.value.truncate(last.value.trim_end().len());
        if last.value.is_empty() {
            children.pop();
        }
    }
    node.children = children;
}

/// Compare two compiled Markdown specs by meaning
fn compare_markdown_specs(
    expected: Option<DumpedMarkdown>,
    actual: Option<DumpedMarkdown>,
    check: MarkdownCheck,
) -> Result<(), String> {
    let (mut expected, mut actual) = match (expected, actual) {
        (None, None) => return Ok(()),
        (Some(expected), Some(actual))
            if check == MarkdownCheck::Semantic
                || (expected.template == actual.template && expected.fields == actual.fields) =>
        {
            (expected, actual)
        }
        (expected, actual) => return Err(format!("C++: {expected:?}\nRust: {actual:?}")),
    };
    if check == MarkdownCheck::Smoke {
        return Ok(());
    }
    normalize_markdown(&mut expected.document);
    normalize_markdown(&mut actual.document);
    let (e, a) = (expected.to_text(), actual.to_text());
    MARKDOWN_SPECS.fetch_add(1, Relaxed);
    MARKDOWN_NODES.fetch_add(e.lines().count() - 1, Relaxed);
    if e != a {
        return Err(format!("{}\nC++:\n{e}Rust:\n{a}", first_difference(&e, &a)));
    }
    Ok(())
}

/// Compare the Markdown compiler on a template
fn compare_markdown(template: &str, check: MarkdownCheck) -> Result<(), String> {
    let expected = dashql_oracle::visualize::compile_markdown(template)?;
    let mut actual = String::new();
    dump_markdown(&mut actual, Some(&compile_markdown_template(template)));
    MARKDOWN_TEMPLATES.fetch_add(1, Relaxed);
    let expected = DumpReader { rest: &expected }.markdown();
    let actual = DumpReader { rest: &actual }.markdown();
    compare_markdown_specs(expected, actual, check).map_err(|error| format!("template {template:?}\n{error}"))
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

/// Handcrafted templates with CommonMark corner cases. Those on which md4c deviates from the spec are left out.
const HANDCRAFTED_MARKDOWN: &[&str] = &[
    // Blank lines in list items
    "-   a\n\n\n  b",
    "- a\n\n\n  b",
    "-\n\n  b",
    // Reference definitions: duplicates, case folding, whitespace, multi-line labels and titles
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
    "```a`b\nx",
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
    "[a](b\n'c')", "[a](\n'c')", "[a]( ", "[[a](b)](c)", "![[a](b)](c)",
    "<http://a.b/c?d#e> <mailto:x> <a@b-.c> <a@-b.c> <ab:c>",
    "&#0; &#x110000; &#xD800; &#55296; &amp &ThisEntityDoesNotExist; &CounterClockwiseContourIntegral;",
    // The templates of the unit tests in dashql-core/src/visualize/markdown/tests.rs
    "{{ a }} {{b}} {{a}} {{}} {{ ",
    "`{{a}}` <b title=\"{{b}}\">x</b>",
    "a\\*b &amp; c",
    "&bogus; &#x41; &#0;",
    "a\0b",
    "a\nb <!-- c --> {{x}}",
    "# H1 #\n\nSetext\n---",
    "- a\n- b\n\n1) c",
    "- a\n\n- b",
    "```sql x\nselect\n1\n```\n\n    code",
    "<div>\nhtml\n</div>\n\n***",
    "> q\n",
    "[a][ref] ![img](/x.png \"t\") <https://x.y> <me@x.y> [bad](javascript:x)\n\n[REF]: http://r 'T'",
    "[x]({{f}} \"{{f}}\")",
    "[x](/a&amp;b\\) \"t {{f}}\")",
    "***a** b*",
    "a_b_c *x*",
    "`` a`b ``",
    "a  \nb\\\nc",
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

/// Inline content of well-formed Markdown templates
const MARKDOWN_INLINES: &[&str] = &[
    "text", "more text", "{{a}}", "{{ b }}", "*em*", "_em_", "**strong**", "__strong__", "***both***", "`code`",
    "`{{a}}`", "[link](https://x.y \"title\")", "[{{a}}](/u)", "[bad](javascript:x)", "[dynamic]({{b}})",
    "![img](/p.png)", "<https://x.y>", "<a@b.c>", "&amp;", "&copy;", "\\*", "é ü", "<b>html</b>", "a  \nb", "a\\\nb",
    "line\nbreak",
];

/// A well-formed Markdown template: common blocks separated by blank lines
fn random_markdown_blocks(rng: &mut Rng) -> String {
    let inline = |rng: &mut Rng| {
        let n = 1 + rng.below(4);
        (0..n).map(|_| *rng.pick(MARKDOWN_INLINES)).collect::<Vec<_>>().join(" ")
    };
    let list = |rng: &mut Rng, marker: &str| {
        let n = 1 + rng.below(3);
        (0..n).map(|_| format!("{marker} {}", inline(rng))).collect::<Vec<_>>().join("\n")
    };
    let n = 1 + rng.below(5);
    let blocks: Vec<String> = (0..n)
        .map(|_| match rng.below(8) {
            0 => format!("{} {}", "#".repeat(1 + rng.below(6)), inline(rng)),
            1 => list(rng, "-"),
            2 => list(rng, "1."),
            3 => format!("> {}", inline(rng)),
            4 => format!("```sql\nselect {}\n```", inline(rng)),
            5 => "---".to_string(),
            _ => inline(rng),
        })
        .collect();
    blocks.join("\n\n")
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
            compare_visualizations(catalog.as_deref(), &main, MarkdownCheck::Semantic).map_err(Failed::from)?;
            for prefix in prefixes(&main, 64) {
                compare_visualizations(catalog.as_deref(), prefix, MarkdownCheck::Semantic).map_err(Failed::from)?;
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
                    compare_visualizations(None, input, MarkdownCheck::Semantic).map_err(Failed::from)?;
                    let catalog = rng.pick(&catalogs);
                    compare_visualizations(Some(catalog), input, MarkdownCheck::Semantic).map_err(Failed::from)?;
                    for prefix in prefixes(input, 16) {
                        compare_visualizations(Some(catalog), prefix, MarkdownCheck::Semantic).map_err(Failed::from)?;
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
                compare_visualizations(catalog, &script, MarkdownCheck::Smoke).map_err(Failed::from)?;
                if rng.below(8) == 0 {
                    for prefix in prefixes(&script, 8) {
                        compare_visualizations(catalog, prefix, MarkdownCheck::Smoke).map_err(Failed::from)?;
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

    // Handcrafted Markdown templates, and the templates of the unit tests
    trials.push(Trial::test("markdown::handcrafted", || {
        for template in HANDCRAFTED_MARKDOWN {
            compare_markdown(template, MarkdownCheck::Semantic).map_err(Failed::from)?;
        }
        Ok(())
    }));

    // Well-formed Markdown templates
    for batch in 0..8u64 {
        trials.push(Trial::test(format!("fuzz::markdown_blocks::{batch}"), move || {
            let mut rng = Rng::new(0xB10C + batch);
            for _ in 0..1000 {
                compare_markdown(&random_markdown_blocks(&mut rng), MarkdownCheck::Semantic).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    // Fuzzed line-based Markdown templates
    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::markdown_lines::{batch}"), move || {
            let mut rng = Rng::new(0x11E + batch);
            for _ in 0..4000 {
                compare_markdown(&random_markdown_lines(&mut rng), MarkdownCheck::Smoke).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    // Fuzzed Markdown templates
    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::markdown::{batch}"), move || {
            let mut rng = Rng::new(0x3D + batch);
            for _ in 0..4000 {
                compare_markdown(&random_markdown(&mut rng), MarkdownCheck::Smoke).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    let conclusion = run(&args, trials);
    eprintln!(
        "compared {} scripts with {} visualizations ({} round trips), {} Vega-Lite texts ({} statements), {} Markdown \
         templates ({} specs with {} nodes by meaning), skipped {} scripts with invalid C++ JSON",
        SCRIPTS.load(Relaxed),
        SPECS.load(Relaxed),
        ROUNDTRIPS.load(Relaxed),
        VEGALITE_PARSES.load(Relaxed),
        VEGALITE_STATEMENTS.load(Relaxed),
        MARKDOWN_TEMPLATES.load(Relaxed),
        MARKDOWN_SPECS.load(Relaxed),
        MARKDOWN_NODES.load(Relaxed),
        INVALID_CPP_JSON.load(Relaxed),
    );
    conclusion.exit();
}
