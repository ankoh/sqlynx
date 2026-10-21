//! Regenerates the snapshot files `snapshots/**/<name>.yaml` from their templates `<name>.tpl.yaml`.
//!
//! `snapshotter --source_dir=<repository> [--filter=<category>]`, categories: parser, analyzer, planner,
//! completion, formatter, hyper_plan, visualize, diff. An empty filter updates all of them.
//!
//! The output is byte for byte the output of the former C++ snapshotter (`tools/snapshotter.cc` with rapidyaml):
//! - parser, formatter, diff and hyper_plan build new files from the inputs of the templates,
//! - analyzer, completion, planner and visualize write the templates back with the results appended,
//! - comments of the templates are dropped,
//! - a blank line separates the cases and no line ends with a space.

use dashql_buffers::formatting::{FormattingConfigT, FormattingMode};
use dashql_core::analyzer::{analyze, AnalyzedScript};
use dashql_core::catalog::Catalog;
use dashql_core::completion::Completion;
use dashql_core::cursor::{ScriptCursor, ScriptView};
use dashql_core::formatter::{
    formatting_mode_to_string, parse_formatting_dialect, parse_formatting_mode, Formatter,
    FORMATTING_DEFAULT_INDENTATION_WIDTH, FORMATTING_DEFAULT_MAX_WIDTH,
};
use dashql_core::script_diff::ScriptDiff;
use dashql_core::view::PlanViewModel;
use dashql_core::visualize::{
    compile_markdown_spec, compile_umap_spec, generate_vegalite_spec, parse_vegalite_to_visualize,
};
use dashql_parser::parser::{parse, ParsedScript};
use dashql_parser::scanner::{scan, ScannedScript};
use dashql_snapshots::encode::completion::encode_completion;
use dashql_snapshots::encode::plan_view_model::{encode_plan_view_model, snapshot_config};
use dashql_snapshots::encode::visualize::{encode_markdown_spec, encode_umap_spec};
use dashql_snapshots::encode::{analyzer, diff, encode_location_text, parser, planner, Map};
use dashql_snapshots::ryml::{self, Node};
use dashql_snapshots::trim_input;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

/// The template files of a directory, sorted
fn templates(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).collect(),
        Err(e) => {
            println!("cannot list {}: {e}", dir.display());
            return Vec::new();
        }
    };
    files.retain(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".tpl.yaml")));
    files.sort();
    files
}

/// Read and parse a template, `None` if it lacks the snapshots key
fn read_template(path: &Path, key: &str) -> Option<Node> {
    let file_name = path.file_name().unwrap().to_string_lossy();
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => {
            println!("[{file_name}] failed to read file");
            return None;
        }
    };
    let root = match ryml::parse(&text) {
        Ok(Some(root)) => root,
        Ok(None) => Node::map(),
        Err(e) => {
            println!("[{file_name}] {e}");
            return None;
        }
    };
    if !root.has(key) {
        println!("[{file_name}] no {key} key");
        return None;
    }
    Some(root)
}

/// The output file of a template: `name.tpl.yaml` -> `name.yaml`
fn output_path(template: &Path) -> PathBuf {
    let name = template.file_name().unwrap().to_string_lossy();
    template.with_file_name(format!("{}.yaml", name.trim_end_matches(".tpl.yaml")))
}

/// Emit the first entry of the root mapping, post-process and write the file
fn write_first_entry(path: &Path, root: &Node) {
    let Some((key, value)) = root.entries().first() else { return };
    write_snapshot(path, ryml::emit_entry(key, value));
}

fn write_snapshot(path: &Path, mut text: String) {
    ryml::inject_blank_lines(&mut text);
    if let Err(e) = fs::write(path, text) {
        println!("cannot write {}: {e}", path.display());
    }
}

/// A new snapshot file with a single key holding a sequence
fn snapshot_root(key: &str, cases: Vec<Node>) -> Node {
    let mut root = Node::map();
    root.push(key, Node::seq(cases));
    root
}

/// The text of a scalar child, empty if missing or null (`node["key"].val()`)
fn text<'a>(node: &'a Node, key: &str) -> &'a str {
    node.get(key).and_then(Node::val).unwrap_or("")
}

/// `std::atoi`: leading whitespace, an optional sign, then digits
fn atoi(text: &str) -> i64 {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let value = digits.bytes().take_while(u8::is_ascii_digit).fold(0i64, |v, d| v * 10 + (d - b'0') as i64);
    if negative {
        -value
    } else {
        value
    }
}

/// Is a flag set (`true` or `1`)?
fn is_true(node: &Node, key: &str) -> bool {
    matches!(node.get(key).and_then(Node::val), Some("true" | "1"))
}

/// Append the entries of an encoded mapping to a mapping of the template
fn append(target: &mut Node, encoded: Node) {
    if let (Some(entries), Node::Map(encoded, _)) = (target.entries_mut(), encoded) {
        entries.extend(encoded);
    }
}

fn parse_text(text: &str, external_id: u32) -> ParsedScript {
    parse(Arc::new(scan(text, 0, external_id)))
}

// ---------------------------------------------------------------------------
// Parser

fn generate_parser_snapshots(dir: &Path) {
    for path in templates(dir) {
        let Some(template) = read_template(&path, "parser-snapshots") else { continue };
        let out = output_path(&path);
        println!("FILE {}", out.display());
        let mut cases = Vec::new();
        for test in template.get("parser-snapshots").unwrap().children() {
            let name = text(test, "name");
            let input = trim_input(text(test, "input"));
            println!("  TEST {name}");
            let parsed = parse_text(&input, 1);
            let mut item = Map::new();
            item.plain("name", name);
            item.insert("input", Node::literal(input.as_str()));
            if is_true(test, "debug") {
                item.plain("debug", "true");
            }
            item.insert("expected", parser::encode_script(&parsed, &input));
            cases.push(item.into_node());
        }
        write_first_entry(&out, &snapshot_root("parser-snapshots", cases));
    }
}

// ---------------------------------------------------------------------------
// Analyzer, completion and visualize: scripts against a catalog

/// The input of a script node: the `input` of a mapping, or the scalar itself (`read_script_yml`)
fn script_input(node: &Node) -> String {
    match node {
        Node::Map(..) if node.has("input") => trim_input(text(node, "input")),
        node => trim_input(node.val().unwrap_or("")),
    }
}

/// Analyze a script against a catalog
fn analyze_script(catalog: &Catalog, input: &str) -> Option<AnalyzedScript> {
    let entry_id = catalog.allocate_entry_id();
    let parsed = Arc::new(parse(Arc::new(scan(input, 0, entry_id))));
    match analyze(parsed, catalog) {
        Ok(analyzed) => Some(analyzed),
        Err(e) => {
            println!("  ERROR {}", e.message);
            None
        }
    }
}

/// Build the catalog of a case from its `catalog.script` and append the analysis to that node (`read_catalog_yml`)
fn read_catalog(test: &mut Node) -> Catalog {
    let mut catalog = Catalog::new();
    let Some(script_node) = test.get_mut("catalog").and_then(|c| c.get_mut("script")) else { return catalog };
    if let Some(analyzed) = analyze_script(&catalog, &script_input(script_node)) {
        append(script_node, analyzer::encode_script(&analyzed, false));
        let rank = analyzed.catalog_entry_id();
        if let Err(e) = catalog.load_script(Arc::new(analyzed), rank) {
            println!("  ERROR {}", e.message);
        }
    }
    catalog
}

fn generate_analyzer_snapshots(dir: &Path) {
    for path in templates(dir) {
        let Some(mut template) = read_template(&path, "analyzer-snapshots") else { continue };
        let out = output_path(&path);
        println!("FILE {}", out.display());
        for test in template.get_mut("analyzer-snapshots").unwrap().children_mut() {
            if !test.has("name") {
                continue;
            }
            println!("  TEST {}", text(test, "name"));
            let catalog = read_catalog(test);
            let Some(script_node) = test.get_mut("script") else { continue };
            if let Some(analyzed) = analyze_script(&catalog, &script_input(script_node)) {
                append(script_node, analyzer::encode_script(&analyzed, true));
            }
        }
        write_first_entry(&out, &template);
    }
}

/// Complete at a cursor and append the encoded completion to the `completions` node
fn complete(
    completions: &mut Node,
    catalog: &Catalog,
    script: (&Arc<ScannedScript>, &Arc<ParsedScript>, &Arc<AnalyzedScript>),
    offset: usize,
    limit: usize,
) {
    let (scanned, parsed, analyzed) = script;
    let view = ScriptView { scanned: Some(scanned), parsed: Some(parsed), analyzed: Some(analyzed), catalog };
    let cursor = ScriptCursor::place(view, offset);
    if cursor.scanner_location.is_none() {
        println!("  ERROR COMPLETION_MISSES_SCANNER_TOKEN");
        return;
    }
    let completion = Completion::compute(&cursor, limit);
    let Some(loc) = completion.target_symbol.as_ref().map(|t| t.symbol.location) else {
        println!("  ERROR completion without target symbol");
        return;
    };
    let mut out = Map::new();
    encode_completion(&mut out, &completion);
    encode_location_text(&mut out, &scanned.text, loc.offset, loc.length, "text");
    append(completions, out.into_node());
}

fn generate_completion_snapshots(dir: &Path) {
    for path in templates(dir) {
        let Some(mut template) = read_template(&path, "completion-snapshots") else { continue };
        let out = output_path(&path);
        println!("FILE {}", out.display());
        for test in template.get_mut("completion-snapshots").unwrap().children_mut() {
            if !test.has("name") {
                continue;
            }
            println!("  TEST {}", text(test, "name"));
            let catalog = read_catalog(test);
            let Some(editor) = test.get_mut("editor") else { continue };
            let input = script_input(editor);
            let entry_id = catalog.allocate_entry_id();
            let scanned = Arc::new(scan(&input, 0, entry_id));
            let parsed = Arc::new(parse(scanned.clone()));
            let analyzed = match analyze(parsed.clone(), &catalog) {
                Ok(analyzed) => Arc::new(analyzed),
                Err(e) => {
                    println!("  ERROR {}", e.message);
                    continue;
                }
            };
            // The editor node becomes a mapping (`clear_val(); |= MAP`)
            if !editor.is_map() {
                *editor = Node::map();
            }
            append(editor, analyzer::encode_script(&analyzed, true));

            let search = test.get("cursor").and_then(|c| c.get("search"));
            let search_text = search.map(|s| text(s, "text")).unwrap_or("");
            let search_index = search.and_then(|s| s.get("index")).and_then(Node::val).map(atoi).unwrap_or(0) as usize;
            let Some(search_pos) = scanned.text.find(search_text) else {
                println!("  ERROR couldn't locate cursor `{search_text}`");
                continue;
            };
            let cursor_pos = search_pos + search_index;
            if cursor_pos > scanned.text.len() {
                println!("  ERROR cursor index out of bounds");
                continue;
            }
            let Some(completions) = test.get_mut("completions") else { continue };
            let limit = completions.get("limit").and_then(Node::val).map(atoi).unwrap_or(100) as usize;
            complete(completions, &catalog, (&scanned, &parsed, &analyzed), cursor_pos, limit);
        }
        write_first_entry(&out, &template);
    }
}

fn generate_visualize_snapshots(dir: &Path) {
    for path in templates(dir) {
        let Some(mut template) = read_template(&path, "visualize-snapshots") else { continue };
        let out = output_path(&path);
        println!("FILE {}", out.display());
        for test in template.get_mut("visualize-snapshots").unwrap().children_mut() {
            if !test.has("name") {
                continue;
            }
            println!("  TEST {}", text(test, "name"));
            let catalog = read_catalog(test);
            let Some(script_node) = test.get("script") else { continue };
            let Some(analyzed) = analyze_script(&catalog, &script_input(script_node)) else { continue };
            let Some(spec) = analyzed.visualization_specs.first() else { continue };
            let renderer = spec.renderer.as_deref();
            // Stale keys of either renderer are cleared, so switching the renderer leaves no output behind
            for key in ["vegalite", "roundtrip", "umap", "markdown"] {
                test.remove(key);
            }
            match renderer {
                Some("umap") => {
                    let Some(umap) = compile_umap_spec(spec, &analyzed) else { continue };
                    test.push("umap", encode_umap_spec(&umap));
                }
                Some("markdown") => {
                    let Some(markdown) = compile_markdown_spec(spec) else { continue };
                    test.push("markdown", encode_markdown_spec(&markdown));
                }
                _ => {
                    let vegalite = generate_vegalite_spec(spec, &analyzed);
                    let roundtrip = parse_vegalite_to_visualize(&vegalite);
                    test.push("vegalite", Node::literal(vegalite));
                    test.push("roundtrip", Node::literal(roundtrip));
                }
            }
        }
        write_first_entry(&out, &template);
    }
}

// ---------------------------------------------------------------------------
// Planner

fn generate_planner_snapshots(dir: &Path) -> Result<(), String> {
    for path in templates(dir) {
        let text =
            fs::read_to_string(&path).map_err(|e| format!("cannot read planner template {}: {e}", path.display()))?;
        let mut template = ryml::parse(&text)?.unwrap_or_else(Node::map);
        let out = output_path(&path);
        println!("FILE {}", out.display());
        let fixtures = template.get_mut("planner-snapshots").ok_or("missing planner-snapshots")?;
        for fixture in fixtures.children_mut() {
            println!("  TEST {}", fixture.get("name").and_then(Node::val).unwrap_or(""));
            fixture.remove("expected");
            let expected = planner::encode_planner_fixture(&planner::Fixture::from_node(fixture))?;
            fixture.push("expected", expected);
        }
        write_snapshot(&out, ryml::emit_root(&template));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Formatter

/// The index of a mode in the order the snapshots list the modes
fn mode_index(mode: FormattingMode) -> usize {
    match mode {
        FormattingMode::INLINE => 0,
        FormattingMode::PRETTY => 2,
        _ => 1,
    }
}

/// The formatted outputs of a dialect
fn format_dialect(formatter: &mut Formatter, dialect_str: &str, dialect_node: &Node) -> Node {
    let dialect = parse_formatting_dialect(dialect_str);
    let mut out = Map::new();
    if dialect_node.is_map() && is_true(dialect_node, "skip") {
        out.plain("skip", "true");
        return out.into_node();
    }
    // Only modes with settings other than the defaults are listed in the template
    let mut overrides: [Option<(usize, usize)>; 3] = [None; 3];
    if let Some(formatted) = dialect_node.get("formatted") {
        for f in formatted.children() {
            let mode = parse_formatting_mode(f.get("mode").map(|m| m.val().unwrap_or("")).unwrap_or("compact"));
            let indent = f.get("indent").map(|v| atoi(v.val().unwrap_or("")) as usize);
            let width = f.get("width").map(|v| atoi(v.val().unwrap_or("")) as usize);
            overrides[mode_index(mode)] = Some((
                indent.unwrap_or(FORMATTING_DEFAULT_INDENTATION_WIDTH),
                width.unwrap_or(FORMATTING_DEFAULT_MAX_WIDTH),
            ));
        }
    }
    let mut entries = Vec::new();
    for mode in [FormattingMode::INLINE, FormattingMode::COMPACT, FormattingMode::PRETTY] {
        let (indent, width) =
            overrides[mode_index(mode)].unwrap_or((FORMATTING_DEFAULT_INDENTATION_WIDTH, FORMATTING_DEFAULT_MAX_WIDTH));
        let mut config = FormattingConfigT::default();
        config.dialect = dialect;
        config.mode = mode;
        config.indentation_width = indent as u32;
        config.max_width = width as u32;
        let formatted = formatter.format(&config);
        let mut entry = Map::new();
        entry.plain("mode", formatting_mode_to_string(mode));
        if indent != FORMATTING_DEFAULT_INDENTATION_WIDTH {
            entry.plain("indent", &indent.to_string());
        }
        if width != FORMATTING_DEFAULT_MAX_WIDTH {
            entry.plain("width", &width.to_string());
        }
        entry.insert("expected", Node::literal(formatted));
        entries.push(entry.into_node());
    }
    out.insert("formatted", Node::seq(entries));
    if let Some(validation) = dialect_node.get("validation") {
        match validation.get("setup").filter(|_| validation.is_map()).and_then(Node::val) {
            Some(setup) => {
                let mut v = Map::new();
                v.insert("setup", Node::literal(setup));
                out.insert("validation", v.into_node());
            }
            None => {
                out.insert("validation", Node::null());
            }
        }
    }
    out.into_node()
}

fn generate_formatter_snapshots(dir: &Path) {
    for path in templates(dir) {
        let Some(template) = read_template(&path, "formatter-snapshots") else { continue };
        let out = output_path(&path);
        println!("FILE {}", out.display());
        let mut cases = Vec::new();
        for test in template.get("formatter-snapshots").unwrap().children() {
            if !test.has("name") || !test.has("input") {
                continue;
            }
            let name = text(test, "name");
            println!("  TEST {name}");
            let input = trim_input(text(test, "input"));
            let parsed = parse_text(&input, 1);
            let mut formatter = Formatter::new(&parsed);
            let mut item = Map::new();
            item.plain("name", name);
            item.insert("input", Node::literal(input.as_str()));
            if let Some(dialects) = test.get("dialects") {
                let mut out_dialects = Map::new();
                for (key, dialect_node) in dialects.entries() {
                    out_dialects.insert(key.as_str(), format_dialect(&mut formatter, key.as_str(), dialect_node));
                }
                item.insert("dialects", out_dialects.into_node());
            }
            cases.push(item.into_node());
        }
        write_first_entry(&out, &snapshot_root("formatter-snapshots", cases));
    }
}

// ---------------------------------------------------------------------------
// Hyper plans

fn generate_hyper_plan_snapshots(dir: &Path) {
    for path in templates(dir) {
        let Some(template) = read_template(&path, "plan-snapshots") else { continue };
        let out = output_path(&path);
        println!("FILE {}", out.display());
        let mut cases = Vec::new();
        for test in template.get("plan-snapshots").unwrap().children() {
            if !test.has("name") {
                continue;
            }
            let name = text(test, "name");
            println!("  TEST {name}");
            if !test.has("input") {
                continue;
            }
            // The plan is not trimmed
            let input = text(test, "input");
            let mut view_model = PlanViewModel::new();
            if let Err(e) = view_model.parse_hyper_plan(input.as_bytes()) {
                println!("  ERROR {e:?}");
                continue;
            }
            view_model.configure(&snapshot_config());
            view_model.compute_layout();
            let mut item = Map::new();
            item.plain("name", name);
            item.insert("input", Node::literal(input));
            item.0.extend(encode_plan_view_model(&view_model.pack_buffer()).0);
            cases.push(item.into_node());
        }
        write_first_entry(&out, &snapshot_root("plan-snapshots", cases));
    }
}

// ---------------------------------------------------------------------------
// Diff

fn generate_diff_snapshots(dir: &Path) {
    for path in templates(dir) {
        let Some(template) = read_template(&path, "diff-snapshots") else { continue };
        let out = output_path(&path);
        println!("FILE {}", out.display());
        let mut cases = Vec::new();
        for test in template.get("diff-snapshots").unwrap().children() {
            let name = text(test, "name");
            let source = trim_input(text(test, "source"));
            let target = trim_input(text(test, "target"));
            println!("  TEST {name}");
            let source_parsed = parse_text(&source, 1);
            let target_parsed = parse_text(&target, 2);
            let mut script_diff = ScriptDiff::new(&source_parsed, &target_parsed);
            let ops = script_diff.compute();
            let mut item = Map::new();
            item.plain("name", name);
            item.insert("source", Node::literal(source.as_str()));
            item.insert("target", Node::literal(target.as_str()));
            item.insert("expected", diff::encode_diff(ops, &source, &target));
            cases.push(item.into_node());
        }
        write_first_entry(&out, &snapshot_root("diff-snapshots", cases));
    }
}

// ---------------------------------------------------------------------------

/// The value of a flag: `--name=value`, `-name=value`, `--name value` or `-name value`
fn flag(args: &[String], name: &str) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let Some(rest) = arg.strip_prefix("--").or_else(|| arg.strip_prefix('-')) else { continue };
        if let Some(value) = rest.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
            return Some(value.to_string());
        }
        if rest == name {
            return iter.next().cloned();
        }
    }
    None
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: snapshotter --source_dir <dir> [--filter <category>]");
        println!(
            "Categories: parser, analyzer, planner, completion, formatter, hyper_plan, visualize, diff. Empty = all."
        );
        return ExitCode::SUCCESS;
    }
    let source_dir = flag(&args, "source_dir").unwrap_or_default();
    let filter = flag(&args, "filter").unwrap_or_default();
    if source_dir.is_empty() || !Path::new(&source_dir).exists() {
        println!("Invalid source directory: {source_dir}");
        return ExitCode::FAILURE;
    }
    let snapshots = Path::new(&source_dir).join("snapshots");
    let selected = |category: &str| filter.is_empty() || filter == category;
    if selected("parser") {
        generate_parser_snapshots(&snapshots.join("parser"));
    }
    if selected("analyzer") {
        generate_analyzer_snapshots(&snapshots.join("analyzer"));
    }
    if selected("planner") {
        if let Err(e) = generate_planner_snapshots(&snapshots.join("planner")) {
            println!("ERROR {e}");
            return ExitCode::FAILURE;
        }
    }
    if selected("completion") {
        generate_completion_snapshots(&snapshots.join("completion"));
    }
    if selected("formatter") {
        generate_formatter_snapshots(&snapshots.join("formatter"));
    }
    if selected("hyper_plan") {
        generate_hyper_plan_snapshots(&snapshots.join("plans").join("hyper").join("tests"));
    }
    if selected("visualize") {
        generate_visualize_snapshots(&snapshots.join("visualize"));
    }
    if selected("diff") {
        generate_diff_snapshots(&snapshots.join("diff"));
    }
    ExitCode::SUCCESS
}
