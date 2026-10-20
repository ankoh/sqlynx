//! The Rust plan view model must produce exactly the output of the C++ plan view model.
//!
//! Both sides configure a view model, load a Hyper plan (`ParseHyperPlan` + `ComputeLayout`) and pack it. The
//! packed flatbuffers are decoded and dumped field by field (doubles by their bits) and compared. Inputs:
//! - all plans of the snapshots (snapshots/plans/hyper/tests) under several layout configs
//! - prefixes of these plans
//! - deterministic mutations of these plans and of handwritten plans that exercise the JSON dialect
//! - random operator trees with random attributes
//!
//! Inputs that make the C++ core hit a rapidjson assertion (`GetUint` and `GetUint64` on numbers of another type)
//! are skipped, the native oracle is a fastbuild without NDEBUG and would abort. The Rust port implements the
//! release behavior (the raw 64 bit storage of the number), which an optimized oracle checks:
//!
//!   bazel test -c opt --test_env=PLAN_DIFFERENTIAL_NO_SKIP=1 \
//!       //packages/dashql-core-rs:plan_view_model_differential_test

use dashql_buffers::view as fb;
use dashql_core::view::json::{c_str, Document, Number, Value, ValueId};
use dashql_core::view::PlanViewModel;
use dashql_oracle::view::{load_hyper_plan, PlanLayoutConfig};
use dashql_snapshots::{load_category_from, run, snapshot_root, Arguments, Failed, Trial};
use flatbuffers::{ForwardsUOffset, Vector};
use std::fmt::Write as _;
use std::sync::Arc;

/// The layout configs to compare under
fn configs() -> Vec<PlanLayoutConfig> {
    let base = PlanLayoutConfig::default();
    vec![
        // HyperPlanSnapshotTestSuite
        PlanLayoutConfig {
            level_height: 64.0,
            node_height: 32.0,
            node_margin_horizontal: 20.0,
            node_padding_left: 8.0,
            node_padding_right: 8.0,
            icon_width: 14.0,
            icon_margin_right: 8.0,
            max_label_chars: 20,
            width_per_label_char: 8.5,
            node_min_width: 0.0,
        },
        // PackPlan in hyper_plan_test.cc
        PlanLayoutConfig {
            level_height: 64.0,
            node_height: 32.0,
            node_padding_left: 8.0,
            node_padding_right: 8.0,
            max_label_chars: 20,
            width_per_label_char: 8.5,
            ..base
        },
        // MakeLayoutConfig(0.25)
        PlanLayoutConfig {
            level_height: 20.0,
            node_height: 8.0,
            node_margin_horizontal: 0.25,
            node_padding_left: 0.25,
            node_padding_right: 0.25,
            max_label_chars: 20,
            width_per_label_char: 1.25,
            ..base
        },
        // The TPC-H tests
        PlanLayoutConfig {
            level_height: 20.0,
            node_height: 8.0,
            node_padding_left: 2.0,
            node_padding_right: 2.0,
            max_label_chars: 20,
            width_per_label_char: 2.0,
            node_min_width: 8.0,
            ..base
        },
        // All zero
        base,
        // Odd values
        PlanLayoutConfig {
            level_height: 1.5,
            node_height: 0.1,
            node_margin_horizontal: -5.0,
            node_padding_left: 0.3,
            node_padding_right: 1e-3,
            icon_width: 14.0,
            icon_margin_right: 0.7,
            max_label_chars: 3,
            width_per_label_char: 0.1,
            node_min_width: 100.0,
        },
        PlanLayoutConfig {
            level_height: 33.3,
            node_height: 17.0,
            node_margin_horizontal: 0.1,
            node_padding_left: 1.0 / 3.0,
            node_padding_right: 2.0 / 3.0,
            icon_width: 9.9,
            icon_margin_right: 0.01,
            max_label_chars: u32::MAX,
            width_per_label_char: 7.25,
            node_min_width: 13.7,
        },
        PlanLayoutConfig { node_margin_horizontal: f64::NAN, width_per_label_char: 3.0, max_label_chars: 5, ..base },
    ]
}

/// Convert a layout config to the flatbuffer struct
fn to_fb(config: &PlanLayoutConfig) -> fb::PlanLayoutConfig {
    fb::PlanLayoutConfig::new(
        config.level_height,
        config.node_height,
        config.node_margin_horizontal,
        config.node_padding_left,
        config.node_padding_right,
        config.icon_width,
        config.icon_margin_right,
        config.max_label_chars,
        config.width_per_label_char,
        config.node_min_width,
    )
}

/// A double by its bits, all NaNs are equal (NaN payloads depend on operand order)
fn f(v: f64) -> String {
    if v.is_nan() {
        "NaN".to_string()
    } else {
        format!("{v:?}/{:x}", v.to_bits())
    }
}

fn bytes(s: &[u8]) -> String {
    s.escape_ascii().to_string()
}

fn dump_statistics(out: &mut String, s: &fb::PlanExecutionStatistics) {
    let _ = write!(
        out,
        " stats({} {} {} {} {} {} {})",
        s.started_at(),
        s.finished_at(),
        f(s.input_cardinality_estimated()),
        s.input_cardinality_consumed(),
        f(s.output_cardinality_estimated()),
        s.output_cardinality_produced(),
        s.memory_bytes()
    );
}

fn dump_rect(out: &mut String, r: &fb::PlanLayoutRect) {
    let _ = write!(out, " rect({} {} {} {})", f(r.x()), f(r.y()), f(r.width()), f(r.height()));
}

fn dump_u32s(out: &mut String, name: &str, v: Option<Vector<u32>>) {
    let _ = writeln!(out, "{name}: {:?}", v.map(|v| v.iter().collect::<Vec<_>>()));
}

/// Dump every field of a packed plan view model
fn dump(buffer: &[u8]) -> String {
    // SAFETY: both buffers come from FlatBufferBuilders. Strings may be invalid UTF-8 and are read as bytes.
    let vm = unsafe { flatbuffers::root_unchecked::<fb::PlanViewModel>(buffer) };
    let mut out = String::new();

    match vm.layout_config() {
        Some(c) => {
            let i = c.input();
            let _ = writeln!(
                out,
                "layout_config: {} {} {} {} {} {} {} {} {} {} computed {}",
                f(i.level_height()),
                f(i.node_height()),
                f(i.node_margin_horizontal()),
                f(i.node_padding_left()),
                f(i.node_padding_right()),
                f(i.icon_width()),
                f(i.icon_margin_right()),
                i.max_label_chars(),
                f(i.width_per_label_char()),
                f(i.node_min_width()),
                f(c.computed_node_width())
            );
        }
        None => out.push_str("layout_config: none\n"),
    }

    // SAFETY: the slot holds a vector of strings, read as byte strings
    let strings = unsafe {
        vm._tab.get::<ForwardsUOffset<Vector<ForwardsUOffset<&[u8]>>>>(fb::PlanViewModel::VT_STRING_DICTIONARY, None)
    };
    match strings {
        Some(strings) => {
            for (i, s) in strings.iter().enumerate() {
                let _ = writeln!(out, "string {i}: {}", bytes(s));
            }
        }
        None => out.push_str("strings: none\n"),
    }

    let _ = writeln!(out, "fragments: {}", vm.fragments().map(|v| v.len() as i64).unwrap_or(-1));
    for x in vm.fragments().iter().flat_map(|v| v.iter()) {
        let _ = write!(
            out,
            "fragment {} anchor {} status {} attrs {}+{} ops {}+{}",
            x.fragment_id(),
            x.anchor_operator(),
            x.execution_status().0,
            x.attributes_begin(),
            x.attribute_count(),
            x.operators_begin(),
            x.operator_count()
        );
        dump_statistics(&mut out, x.execution_statistics());
        out.push('\n');
    }
    dump_u32s(&mut out, "fragment_operators", vm.fragment_operators());

    let _ = writeln!(out, "pipelines: {}", vm.pipelines().map(|v| v.len() as i64).unwrap_or(-1));
    for x in vm.pipelines().iter().flat_map(|v| v.iter()) {
        let _ = write!(
            out,
            "pipeline {} status {} edges {}+{} ops {}+{} attrs {}+{}",
            x.pipeline_id(),
            x.execution_status().0,
            x.edges_begin(),
            x.edge_count(),
            x.operators_begin(),
            x.operator_count(),
            x.attributes_begin(),
            x.attribute_count()
        );
        dump_statistics(&mut out, x.execution_statistics());
        out.push('\n');
    }
    let _ = writeln!(out, "pipeline_edges: {}", vm.pipeline_edges().map(|v| v.len() as i64).unwrap_or(-1));
    for x in vm.pipeline_edges().iter().flat_map(|v| v.iter()) {
        let _ = writeln!(
            out,
            "pipeline_edge {} pipeline {} child {} parent {} breaks {}",
            x.edge_id(),
            x.pipeline_id(),
            x.child_operator(),
            x.parent_operator(),
            x.parent_breaks_pipeline()
        );
    }
    dump_u32s(&mut out, "pipeline_operators", vm.pipeline_operators());
    dump_u32s(&mut out, "root_operators", vm.root_operators());

    let _ = writeln!(out, "operators: {}", vm.operators().map(|v| v.len() as i64).unwrap_or(-1));
    for x in vm.operators().iter().flat_map(|v| v.iter()) {
        let _ = write!(
            out,
            "operator {} type {} label {} parent {} path {} loc {}+{} children {}+{} cross {}+{} attrs {}+{} status {}",
            x.operator_id(),
            x.operator_type_name(),
            x.operator_label(),
            x.parent_operator_id(),
            x.parent_path(),
            x.source_location().offset(),
            x.source_location().length(),
            x.children_begin(),
            x.children_count(),
            x.cross_edges_begin(),
            x.cross_edge_count(),
            x.attributes_begin(),
            x.attribute_count(),
            x.execution_status().0
        );
        dump_statistics(&mut out, x.execution_statistics());
        dump_rect(&mut out, x.layout_rect());
        out.push('\n');
    }
    dump_u32s(&mut out, "operator_pipelines", vm.operator_pipelines());

    let _ = writeln!(out, "operator_edges: {}", vm.operator_edges().map(|v| v.len() as i64).unwrap_or(-1));
    for x in vm.operator_edges().iter().flat_map(|v| v.iter()) {
        let _ = write!(
            out,
            "operator_edge {} child {} parent {} ports {}/{} pipeline {} status {}",
            x.edge_id(),
            x.child_operator(),
            x.parent_operator(),
            x.parent_operator_port_index(),
            x.parent_operator_port_count(),
            x.pipeline_id(),
            x.execution_status().0
        );
        dump_statistics(&mut out, x.execution_statistics());
        out.push('\n');
    }

    let _ = writeln!(out, "cross_edges: {}", vm.operator_cross_edges().map(|v| v.len() as i64).unwrap_or(-1));
    for x in vm.operator_cross_edges().iter().flat_map(|v| v.iter()) {
        let _ = write!(
            out,
            "cross_edge {} source {} target {} pipeline {} attrs {}+{} status {}",
            x.edge_id(),
            x.source_node(),
            x.target_node(),
            x.pipeline_id(),
            x.attributes_begin(),
            x.attribute_count(),
            x.execution_status().0
        );
        dump_statistics(&mut out, x.execution_statistics());
        out.push('\n');
    }

    let _ = writeln!(out, "attributes: {}", vm.attributes().map(|v| v.len() as i64).unwrap_or(-1));
    for x in vm.attributes().iter().flat_map(|v| v.iter()) {
        let _ = writeln!(out, "attribute {} name {} value {}", x.attribute_id(), x.name(), x.value_json());
    }

    match vm.layout_rect() {
        Some(r) => {
            out.push_str("layout_rect:");
            dump_rect(&mut out, r);
            out.push('\n');
        }
        None => out.push_str("layout_rect: none\n"),
    }
    out
}

/// Load a plan with the Rust view model, like the oracle does
fn load_rust(plan: &[u8], config: &PlanLayoutConfig) -> (Option<String>, Vec<u8>) {
    let mut view_model = PlanViewModel::new();
    view_model.configure(&to_fb(config));
    let error = match view_model.parse_hyper_plan(plan) {
        Ok(()) => {
            view_model.compute_layout();
            None
        }
        Err(code) => Some(format!("{code:?}")),
    };
    (error, view_model.pack_buffer())
}

/// Would the C++ core hit a rapidjson assertion on this plan?
///
/// `GetUint` on `sqlpos` entries and `GetUint64` on the runtime statistics assert the number type. The check is
/// conservative: it looks at all objects, not only at the ones the C++ code visits.
fn hits_cpp_assertion(plan: &[u8]) -> bool {
    let Some(doc) = Document::parse(plan) else {
        return false;
    };
    fn is_uint(n: Number) -> bool {
        matches!(n, Number::Uint(_)) || matches!(n, Number::Int(i) if i >= 0)
    }
    fn visit(doc: &Document, id: ValueId) -> bool {
        match doc.get(id) {
            Value::Object(members) => members.iter().any(|m| {
                let name = c_str(&m.name);
                let bad = match name {
                    b"sqlpos" => match doc.get(m.value) {
                        Value::Array(entries) => match entries.first().map(|e| doc.get(*e)) {
                            Some(Value::Array(pos)) if pos.len() == 2 => {
                                pos.iter().any(|p| doc.number(*p).is_some_and(|n| !is_uint(n)))
                            }
                            _ => false,
                        },
                        _ => false,
                    },
                    b"processed-rows" | b"processedRows" | b"output-rows" | b"outputRows" | b"memory-bytes"
                    | b"memoryBytes" => doc.number(m.value).is_some_and(|n| !n.is_uint64()),
                    _ => false,
                };
                bad || visit(doc, m.value)
            }),
            Value::Array(elements) => elements.iter().any(|e| visit(doc, *e)),
            _ => false,
        }
    }
    visit(&doc, doc.root())
}

/// The outcome of comparing one input
enum Outcome {
    Same,
    Skipped,
    Different(String),
}

/// Compare the Rust and the C++ view model on one plan
fn compare_plan(plan: &[u8], config: &PlanLayoutConfig) -> Outcome {
    if std::env::var_os("PLAN_DIFFERENTIAL_NO_SKIP").is_none() && hits_cpp_assertion(plan) {
        return Outcome::Skipped;
    }
    let cpp = match load_hyper_plan(plan, config) {
        Ok(cpp) => cpp,
        Err(e) => return Outcome::Different(format!("oracle failed: {e}")),
    };
    let (rust_error, rust_buffer) = load_rust(plan, config);
    if cpp.error != rust_error {
        return Outcome::Different(format!("errors differ: C++ {:?}, Rust {:?}", cpp.error, rust_error));
    }
    let (expected, actual) = (dump(&cpp.buffer), dump(&rust_buffer));
    if expected == actual {
        return Outcome::Same;
    }
    let (e, a) = expected.lines().zip(actual.lines()).find(|(e, a)| e != a).unwrap_or(("<end>", "<end>"));
    Outcome::Different(format!("first difference:\n  C++:  {e}\n  Rust: {a}"))
}

/// Compare a list of plans under some configs, fail with the first differences
fn compare_all(plans: &[Vec<u8>], configs: &[PlanLayoutConfig]) -> Result<(), Failed> {
    let (mut same, mut skipped, mut failures) = (0usize, 0usize, Vec::new());
    for plan in plans {
        for (c, config) in configs.iter().enumerate() {
            match compare_plan(plan, config) {
                Outcome::Same => same += 1,
                Outcome::Skipped => skipped += 1,
                Outcome::Different(d) => {
                    failures.push(format!("config {c}, plan {:?}:\n{d}", String::from_utf8_lossy(plan)));
                }
            }
        }
    }
    eprintln!("{same} same, {skipped} skipped, {} different", failures.len());
    if failures.is_empty() {
        Ok(())
    } else {
        let mut message = format!("{} of {} comparisons differ\n", failures.len(), same + failures.len());
        for failure in failures.iter().take(5) {
            let _ = writeln!(message, "{}", truncate(failure, 3000));
        }
        Err(message.into())
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut end = n;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &s[..end])
    }
}

/// A deterministic random number generator (SplitMix64)
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
}

/// Plans that exercise the JSON dialect and the special cases of the view model
const HANDWRITTEN: &[&str] = &[
    // These hit rapidjson assertions in the C++ core, they are only compared against an optimized oracle
    r#"{"operator":"scan","sqlpos":[[1.5,-2]],"statistics":{"processed-rows":-1,"output-rows":2.5,"memory-bytes":1e30}}"#,
    r#"{"operator":"scan","sqlpos":[[4294967301,-4294967296]],"processedRows":NaN,"outputRows":-Infinity,"memoryBytes":-0.0}"#,
    r#"{"operator":"scan","sqlpos":[[-1,7]],"x":{"sqlpos":[[3.25e9,1e300]]},"statistics":{"processed-rows":-9223372036854775809}}"#,
    r#"{"operator":"scan"}"#,
    r#"[{"operator":"tablescan","debugName":{"value":"first_table"}},{"operator":"tablescan","debugName":{"value":"second_table_is_wider"}}]"#,
    r#"{"plan":{"a":{"operator":"scan","operator-id":1},"b":[{"operator":"map","input":{"operator":"scan"}}]},"operator":7}"#,
    r#"/* leading */ {"operator":"join", // line comment
        "left":{"operator":"scan",},"right":{"operator":"scan","x":[1,2,],},}"#,
    r#"{"operator":"map","values":[NaN, -Infinity, Inf, -0, -0.0, 0.1, 1e-7, 1e21, 1e20, 123456789012345678901234567890, 1.7976931348623157e308, 5e-324, 2.2250738585072014e-308, 18446744073709551616, -9223372036854775809, 4.35, 0.30000000000000004, 1.5e300, 123.456e-310]}"#,
    r#"{"operator":"map","a":1e-400,"b":-1e-330,"c":12345678901234567890.123456789,"d":0.000001,"e":1234567.8,"f":-79.39773355813419}"#,
    r#"{"operator":"sc\u0000an","debugName":{"value":"lab\u0000el"},"na\u0000me":1,"x":"\u00e9\u20ac\ud83d\ude00\udc00\/\b\f\n\r\t"}"#,
    r#"{"operator\u0000x":"scan","attributes":[{"defines":{"id":"r\u0000s.a"}},{"defines":{"id":"r\u0000s.b"}}]}"#,
    r#"{"operator":"scan","attributes":[{"defines":{"id":"lineitem.a"}},{"defines":{"id":"orders.b"}}]}"#,
    r#"{"operator":"scan","attributes":[{"defines":{"id":".a"}},{"defines":{"id":"x"}},{"defines":{"id":"a.b.c"}},{"defines":{"id":3}},"x",{"defines":7}]}"#,
    r#"{"operator":"scan","operator":"map","operator":3,"operatorId":1,"operatorId":2,"debugName":{"value":"a"},"debug-name":{"value":"b"}}"#,
    r#"{"operator":"scan","debugName":{"value":7},"debug-name":"x","operatorId":-1,"operator-id":1.5}"#,
    r#"{"operator":"scan","sqlpos":[[5,3]],"input":{"operator":"map","sqlpos":[[1,4],[7,9]]},"x":{"sqlpos":[[2,"a"]]}}"#,
    r#"{"operator":"scan","sqlpos":[],"y":{"operator":"map","sqlpos":[[1]]},"z":{"operator":"map","sqlpos":[[1,2,3]]},"w":{"operator":"map","sqlpos":["x"]}}"#,
    r#"[{"operator":"a"},{"operator":"b"},{"operator":"c"}]"#,
    r#"[{"operator":"a","input":{"operator":"x"}},{"operator":"b"},{"operator":"c","inputs":[{"operator":"y"},{"operator":"z"}]},{"operator":"d"},{"operator":"e"},{"operator":"f"}]"#,
    r#"[{"operator":"r1"},{"operator":"r2","inputs":[{"operator":"scan0"},{"operator":"scan1"},{"operator":"scan2"},{"operator":"scan3"},{"operator":"scan4"},{"operator":"scan5"},{"operator":"scan6"},{"operator":"scan7"},{"operator":"scan8"},{"operator":"scan9"},{"operator":"scan10"},{"operator":"scan11"},{"operator":"scan12"},{"operator":"scan13"},{"operator":"scan14"},{"operator":"scan15"},{"operator":"scan16"},{"operator":"scan17"},{"operator":"scan18"},{"operator":"scan19"}]},{"operator":"r3"}]"#,
    r#"{"operator":"federate","inputs":[{"operator":"executiontarget","input":{"operator":"federate","inputs":[{"operator":"scan"},{"operator":"federate"}]}}]}"#,
    r#"[{"operator":"executiontarget","input":{"operator":"scan"}},{"operator":"executiontarget","input":{"operator":"federate","inputs":[{"operator":"scan"}]}}]"#,
    r#"{"operator":"executiontarget","operatorId":1,"input":{"operator":"unionall","operatorId":2,"input":[
        {"operator":"explicitscan","operatorId":3,"input":{"operator":"groupby","operatorId":4,"input":{"operator":"tablescan","operatorId":5}}},
        {"operator":"explicitscan","operatorId":6,"input":4},
        {"operator":"leftouterjoin","operatorId":7,"magic":4,"left":{"operator":"tablescan","operatorId":8,"earlyProbes":[
            {"builder":7,"attributes":[0],"type":"lookup","kind":"x","passOnNulls":NaN},{"builder":4,"attributes":[1],"type":"minmaxonly"},{"builder":99},3,{"builder":-1}]},
         "right":{"operator":"earlyprobe","operatorId":9,"builder":7}},
        {"operator":"iteration","operator-id":10,"input":{"operator":"iterationincrement","operator-id":11,"source":10}},
        {"operator":"rightmarkjoin","operatorId":12,"magic":5,"early-probes":[{"builder":5,"b\u0000uilder":1}],"earlyProbes":7},
        {"operator":"explicit-scan","operatorId":13,"input":1},{"operator":"tablescan","operatorId":4}]}}"#,
    r#"{"operator":"executiontarget","operatorId":1,"input":{"operator":"join","operatorId":2,"left":{"operator":"scan","operatorId":3},"right":{"operator":"scan","operatorId":4}},
        "pipelines":[{"pipelineId":10,"operators":[3,2,1,3,99,-1,"x"]},{"pipelineId":-1,"operators":[4,2]},{"operators":7},"x",{"operators":[]},{"pipelineId":3}]}"#,
    r#"{"pipelines":[{"operators":[1]}],"operator":"scan","operatorId":1}"#,
    r#"[{"operator":"scan","operatorId":1}],"#,
    r#"{"operator":"scan","estimated-rows":10000.5,"estimated-rows-in-table":12000.25,"statistics":{"memory-bytes":4294967297,"output-rows":1987,"processed-rows":10000}}"#,
    r#"{"operator":"scan","estimatedRows":"x","cardinality":3,"statistics":{"estimated-rows":4.8375,"estimatedRowsInTable":25,"memoryBytes":2048,"processedRows":1,"outputRows":2}}"#,
    r#"{"operator":"scan","statistics":7,"estimated-rows-in-table":NaN,"processed-rows":5,"output-rows":6,"memory-bytes":7}"#,
    r#"{"operator":"ünïcödé_operator_with_a_very_long_name","debugName":{"value":"日本語のラベルはとても長いです日本語のラベル"}}"#,
    r#"{"operator":"a","input":[{"operator":"b","input":[{"operator":"c"},{"operator":"d","input":[{"operator":"e"},{"operator":"f"},{"operator":"g"}]}]},{"operator":"h"},{"operator":"i","input":[{"operator":"j","input":[{"operator":"k","input":[{"operator":"l"},{"operator":"m"}]}]}]}]}"#,
    r#"{"operator":"x","input":{"wrap":[{"deep":{"operator":"y"}},[{"operator":"z"}]]},"other":{"operator":"w"}}"#,
    "{\"operator\":\"scan\"}\u{0}{garbage",
    "\u{feff}{\"operator\":\"scan\"}",
    "{\"operator\":\"scan\",\"x\":\"\u{1}\"}",
    "  \n\t\r{\"operator\" : \"scan\" } \n ",
    "{\"operator\":\"scan\",\"bad\":\"\\ud800x\"}",
    "{\"operator\":\"scan\",\"bad\":\"\\ud800\\u0041\"}",
    "{\"operator\":\"scan\",\"bad\":\"\\uZZZZ\"}",
    "[1,2,3]",
    "\"just a string\"",
    "null",
    "-",
    "01",
    "1.",
    "1e",
    "1e+",
    "[1e309]",
    "[-1e309]",
    "[1e308, 1e-308, 2e-400, 0.0000000000000000000000000000001e-300]",
    "[NaN, Infinity, -NaN, Infinit, Infx, Na]",
    "[tru, nul, fals]",
    "{\"a\" 1}",
    "{\"a\":1 \"b\":2}",
    "{1:2}",
    "[1 2]",
    "/ {}",
    "{} /* unterminated",
    "{} // trailing",
    "{,}",
    "[,]",
];

/// Snippets the mutator inserts
const SNIPPETS: &[&str] = &[
    "{", "}", "[", "]", ",", ":", "\"", "\\", "/", "*", "-", ".", "e", "0", "9", " ", "\n", "\u{0}", "N", "I",
    "NaN", "-Infinity", "Inf", "1e400", "1e-400", "/*c*/", "//c\n", "\\u0000", "\\ud800\\udc00", "\\udc00", "\\ud800",
    "\u{e9}", "\u{20ac}", "\u{1f600}",
    "\"operator\":\"scan\",", "\"operator\":\"federate\",", "\"operator\":\"executiontarget\",",
    "\"operator\":\"explicitscan\",\"input\":1,", "\"operator-id\":3,", "\"operatorId\":1,", "\"magic\":2,",
    "\"sqlpos\":[[1,2]],", "\"debugName\":{\"value\":\"x\"},", "\"pipelines\":[{\"operators\":[1,2,3]}],",
    "\"earlyProbes\":[{\"builder\":1,\"a\":2}],", "\"statistics\":{\"memory-bytes\":5},",
    "{\"operator\":\"federate\",\"inputs\":[{\"operator\":\"scan\"}]}", "{\"operator\":\"map\"},",
    "\"input\":{\"operator\":\"scan\",\"operatorId\":2},", "123456789012345678901", "0.30000000000000004",
];

/// Raw bytes the mutator inserts
const RAW_BYTES: &[u8] = &[0x80, 0xBF, 0xC0, 0xC3, 0xE0, 0xED, 0xF0, 0xF4, 0xF5, 0xFF, 0x01, 0x1F, b'\t', b'\r'];

/// Mutate a plan
fn mutate(rng: &mut Rng, plan: &[u8]) -> Vec<u8> {
    let mut out = plan.to_vec();
    for _ in 0..1 + rng.below(3) {
        let pos = rng.below(out.len() + 1);
        match rng.below(6) {
            0 => {
                // Delete a few bytes
                let n = (1 + rng.below(4)).min(out.len() - pos.min(out.len()));
                out.drain(pos..pos + n);
            }
            1 => out.insert(pos, *rng.pick(RAW_BYTES)),
            2 | 3 => {
                let snippet = rng.pick(SNIPPETS).as_bytes();
                out.splice(pos..pos, snippet.iter().copied());
            }
            4 => {
                // Replace a byte with a structural character
                if pos < out.len() {
                    out[pos] = *rng.pick(b"{}[],:\"0-.eE \\");
                }
            }
            _ => {
                // Duplicate a range
                let end = (pos + rng.below(40)).min(out.len());
                let copy = out[pos..end].to_vec();
                let at = rng.below(out.len() + 1);
                out.splice(at..at, copy);
            }
        }
    }
    out
}

/// Generate a random operator tree with random attributes
fn random_plan(rng: &mut Rng, depth: usize, next_id: &mut u64, out: &mut String) {
    const TYPES: &[&str] = &[
        "scan", "tablescan", "map", "select", "join", "leftsemijoin", "groupby", "sort", "federate",
        "executiontarget", "explicitscan", "earlyprobe", "iteration", "iterationincrement", "unionall",
        "a_rather_long_operator_type_name", "ü",
    ];
    let id = *next_id;
    *next_id += 1;
    let _ = write!(out, "{{\"operator\":\"{}\"", rng.pick(TYPES));
    if rng.chance(80) {
        let _ = write!(out, ",\"operatorId\":{id}");
    }
    if rng.chance(30) {
        let label_len = rng.below(30);
        let label: String = (0..label_len).map(|_| *rng.pick(&['a', 'b', '_', 'é', '日'])).collect();
        let _ = write!(out, ",\"debugName\":{{\"value\":\"{label}\"}}");
    }
    if rng.chance(30) {
        let _ = write!(out, ",\"sqlpos\":[[{},{}]]", rng.below(500), rng.below(500));
    }
    if rng.chance(40) {
        let value = match rng.below(5) {
            0 => format!("{}", rng.next() >> rng.below(64)),
            1 => format!("{:e}", f64::from_bits(rng.next() >> 2)),
            2 => format!("{}.{}", rng.below(100000), rng.next() % 1_000_000_000_000),
            3 => format!("{}e{}", rng.below(1000), rng.below(40) as i64 - 20),
            _ => format!("-{}", rng.next() >> rng.below(64)),
        };
        let _ = write!(out, ",\"cardinality\":{value}");
    }
    if rng.chance(20) {
        let _ = write!(out, ",\"input\":{}", rng.below(*next_id as usize + 2));
    }
    if rng.chance(15) {
        let builder = rng.below(*next_id as usize + 2);
        let _ = write!(out, ",\"earlyProbes\":[{{\"builder\":{builder},\"attributes\":[0]}}]");
    }
    if depth > 0 && *next_id < 300 {
        let children = match rng.below(10) {
            0..=2 => 0,
            3..=6 => 1,
            7..=8 => 2,
            _ => 3 + rng.below(4),
        };
        if children == 1 && rng.chance(50) {
            out.push_str(",\"input\":");
            random_plan(rng, depth - 1, next_id, out);
        } else if children == 2 && rng.chance(50) {
            out.push_str(",\"left\":");
            random_plan(rng, depth - 1, next_id, out);
            out.push_str(",\"right\":");
            random_plan(rng, depth - 1, next_id, out);
        } else if children > 0 {
            out.push_str(",\"inputs\":[");
            for i in 0..children {
                if i > 0 {
                    out.push(',');
                }
                random_plan(rng, depth - 1, next_id, out);
            }
            out.push(']');
        }
    }
    out.push('}');
}

fn main() {
    let args = Arguments::from_args();
    let dir = snapshot_root().join("plans").join("hyper").join("tests");
    let cases = load_category_from(&dir, "plan").expect("cannot load plan snapshots");
    let snapshot_plans: Arc<Vec<Vec<u8>>> = Arc::new(
        cases.iter().map(|case| case.node["input"].as_str().expect("case without input").as_bytes().to_vec()).collect(),
    );
    let handwritten: Arc<Vec<Vec<u8>>> = Arc::new(HANDWRITTEN.iter().map(|p| p.as_bytes().to_vec()).collect());
    let configs = Arc::new(configs());

    let mut trials = Vec::new();
    {
        let (plans, configs) = (snapshot_plans.clone(), configs.clone());
        trials.push(Trial::test("snapshots", move || compare_all(&plans, &configs)));
    }
    {
        let (plans, configs) = (handwritten.clone(), configs.clone());
        trials.push(Trial::test("handwritten", move || compare_all(&plans, &configs)));
    }
    {
        // Prefixes: all of the handwritten plans, 150 per snapshot plan
        let (snapshots, handwritten, configs) = (snapshot_plans.clone(), handwritten.clone(), configs.clone());
        trials.push(Trial::test("prefixes", move || {
            let mut prefixes = Vec::new();
            for plan in handwritten.iter() {
                prefixes.extend((0..plan.len()).map(|n| plan[..n].to_vec()));
            }
            for plan in snapshots.iter() {
                let step = (plan.len() / 150).max(1);
                prefixes.extend((0..plan.len()).step_by(step).map(|n| plan[..n].to_vec()));
            }
            compare_all(&prefixes, &configs[..1])
        }));
    }
    let mutation_sources = [("mutations_snapshots", 1u64, snapshot_plans.clone()), ("mutations_handwritten", 2, handwritten.clone())];
    for (name, seed, sources) in mutation_sources {
        let configs = configs.clone();
        trials.push(Trial::test(name, move || {
            let mut rng = Rng(seed);
            let per_plan = if sources.len() > 40 { 60 } else { 300 };
            let mut mutated = Vec::new();
            for plan in sources.iter() {
                for _ in 0..per_plan {
                    mutated.push(mutate(&mut rng, plan));
                }
            }
            compare_all(&mutated, &configs[..2])
        }));
    }
    {
        let configs = configs.clone();
        trials.push(Trial::test("random_plans", move || {
            let mut rng = Rng(3);
            let mut plans = Vec::new();
            for i in 0..1500 {
                let mut plan = String::new();
                let mut next_id = 1;
                random_plan(&mut rng, 2 + i % 9, &mut next_id, &mut plan);
                plans.push(plan.into_bytes());
            }
            compare_all(&plans, &configs)
        }));
    }
    run(&args, trials).exit();
}
