//! Editor sessions and script executions must behave exactly like the C++ core.
//!
//! Both cores are driven with the same deterministic random sequences of operations, seeded from
//! every snapshot input: editor events (inserts, deletes and replacements with multi-byte UTF-8 and
//! surrogate pairs, stale versions, invalid offsets and ranges, selections), cursor moves, analysis,
//! completion, compilation, formatting, dashboard rewrites, diffs, statement texts, catalog loads
//! and drops, sessions created and destroyed on a shared catalog, and executions driven with random
//! results and cancellations. Sessions use both offset units.
//!
//! Every packed result is unpacked into the FlatBuffers object API and compared including field
//! presence. Timings are masked, and so are the memory statistics that measure implementation data
//! structures (see `Script::memory_statistics`). After every operation the texts, versions,
//! revisions and entry ids of all sessions and the catalog version must agree.

use dashql_buffers::completion::Completion;
use dashql_buffers::diff::ScriptDiff;
use dashql_buffers::editor::{
    EditorEventAction, EditorEventIntent, EditorEventOrigin, EditorEventT, EditorOffsetUnit, EditorSelectionT,
    EditorTextChangeT, EditorUpdate, EditorUpdateT,
};
use dashql_buffers::execution::{
    ScriptCompilationResult, ScriptExecutionUpdate, ScriptExecutionUpdateT, StatementResultStatus, StatementResultT,
};
use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode, KeywordCase};
use dashql_core::catalog::Catalog;
use dashql_core::error::Error;
use dashql_core::script::Script;
use dashql_core::script_execution::ScriptExecution;
use dashql_core::script_session::{CatalogHandle, ScriptSession};
use dashql_oracle::session::{OracleCatalog, OracleSession};
use dashql_snapshots::corpus::{collect_inputs, Rng, CATEGORIES};
use dashql_snapshots::{load_category, run, trim_input, Arguments, Failed, Trial};
use std::cell::RefCell;
use std::fmt::Debug;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The number of compared results
static COMPARISONS: AtomicUsize = AtomicUsize::new(0);

/// How often interesting outcomes occurred, to see that the random operations reach them
static OUTCOMES: std::sync::Mutex<std::collections::BTreeMap<String, usize>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

fn count(outcome: impl Into<String>) {
    *OUTCOMES.lock().unwrap().entry(outcome.into()).or_default() += 1;
}

/// Count the outcomes of an update
fn count_update(what: &str, update: &EditorUpdateT) {
    let unit = if update.offset_unit == EditorOffsetUnit::UTF16_CODE_UNITS { "utf16" } else { "utf8" };
    count(format!("{what} {unit} status {:?}", update.status));
    if update.text_changed {
        count(format!("{what} {unit} text changed"));
    }
    if update.analysis_updated {
        count(format!("{what} {unit} analysis updated"));
    }
    if update.primary_cursor_state.is_some() {
        count(format!("{what} {unit} cursor state"));
    }
    if let Some(context) = &update.primary_cursor_context {
        count(format!("{what} {unit} cursor context {:?} resolved {}", context.kind, context.resolved));
    }
    if update
        .semantic_spans
        .as_ref()
        .is_some_and(|s| s.iter().any(|s| s.resolution == dashql_buffers::editor::EditorSemanticResolution::RESOLVED))
    {
        count(format!("{what} {unit} resolved semantic spans"));
    }
}

/// Log an operation, and print it if `DASHQL_SESSION_TRACE` is set (to find operations that crash
/// the C++ core)
fn note(log: &mut Vec<String>, line: String) {
    if std::env::var_os("DASHQL_SESSION_TRACE").is_some() {
        eprintln!("{}", line.chars().take(2000).collect::<String>());
    }
    log.push(line);
}

/// Pack an object API value and unpack it again, like the C++ results are read
macro_rules! roundtrip {
    ($value:expr, $table:ty) => {{
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = $value.pack(&mut builder);
        builder.finish(packed, None);
        flatbuffers::root::<$table>(builder.finished_data()).unwrap().unpack()
    }};
}

/// Unpack a packed C++ result
macro_rules! unpack {
    ($bytes:expr, $table:ty) => {
        flatbuffers::root::<$table>(&$bytes).map(|t| t.unpack()).map_err(|e| format!("cannot read the C++ result: {e}"))
    };
}

/// Pack an object API value
macro_rules! pack {
    ($value:expr) => {{
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = $value.pack(&mut builder);
        builder.finish(packed, None);
        builder.finished_data().to_vec()
    }};
}

/// Compare two values by their debug output and show the first difference
fn same<T: Debug>(what: &str, expected: &T, actual: &T) -> Result<(), String> {
    COMPARISONS.fetch_add(1, Ordering::Relaxed);
    let (e, a) = (format!("{expected:#?}"), format!("{actual:#?}"));
    if e == a {
        return Ok(());
    }
    let line = e.lines().zip(a.lines()).position(|(x, y)| x != y).unwrap_or(e.lines().count().min(a.lines().count()));
    let show = |s: &str| s.lines().skip(line.saturating_sub(8)).take(16).collect::<Vec<_>>().join("\n");
    Err(format!("{what} differs at line {line}\nC++:\n{}\nRust:\n{}", show(&e), show(&a)))
}

/// The class of an error: the status code of a dashql::Exception, or any other error
fn rust_error(error: &Error) -> String {
    match error.status {
        Some(status) => format!("status:{}", status.variant_name().unwrap_or("")),
        None => "error".to_string(),
    }
}

fn cpp_error(error: &str) -> String {
    if error.starts_with("status:") {
        error.to_string()
    } else {
        "error".to_string()
    }
}

/// Compare two results, errors by class
fn same_result<T: Debug>(what: &str, expected: Result<T, String>, actual: Result<T, Error>) -> Result<(), String> {
    count(match &actual {
        Ok(_) => format!("{what} ok"),
        Err(e) => format!("{what} {}", rust_error(e)),
    });
    match (expected, actual) {
        (Ok(e), Ok(a)) => same(what, &e, &a),
        (Err(e), Err(a)) => same(what, &cpp_error(&e), &rust_error(&a)),
        (Ok(e), Err(a)) => Err(format!("{what}: C++ succeeded with {e:?}, Rust failed with {a:?}")),
        (Err(e), Ok(a)) => Err(format!("{what}: C++ failed with {e}, Rust succeeded with {a:?}")),
    }
}

/// Mask timings and the memory statistics of implementation data structures
fn mask_update(mut update: EditorUpdateT) -> EditorUpdateT {
    if let Some(s) = update.processing_statistics.as_mut() {
        s.scanner_last_elapsed_ns = 0.0;
        s.parser_last_elapsed_ns = 0.0;
        s.analyzer_last_elapsed_ns = 0.0;
        s.scanner_symbol_bytes = 0;
        s.scanner_name_dictionary_bytes = 0;
        s.analyzer_description_bytes = 0;
        s.analyzer_name_index_bytes = 0;
    }
    update
}

fn compare_update(what: &str, expected: Result<Vec<u8>, String>, actual: EditorUpdateT) -> Result<(), String> {
    count_update(what, &actual);
    let expected = unpack!(expected?, EditorUpdate)?;
    let actual = roundtrip!(actual, EditorUpdate);
    same(what, &mask_update(expected), &mask_update(actual))
}

fn compare_execution(
    what: &str,
    expected: Result<Vec<u8>, String>,
    actual: &ScriptExecutionUpdateT,
) -> Result<(), String> {
    count(format!(
        "{what} protocol {:?} phase {:?} pending {}",
        actual.protocol_error,
        actual.snapshot.as_ref().map(|s| s.phase),
        actual.pending_statement.is_some()
    ));
    let expected = unpack!(expected?, ScriptExecutionUpdate)?;
    same(what, &expected, &roundtrip!(actual, ScriptExecutionUpdate))
}

/// Characters that are 1, 2, 3 and 4 bytes in UTF-8 and 1 or 2 code units in UTF-16
const CHARS: &[&str] = &["a", "\u{e9}", "\u{2603}", "\u{1F600}", "\u{1D538}", " ", "\n", "'", "\""];

/// Fragments for inserts
const FRAGMENTS: &[&str] = &[
    "",
    "select ",
    "from ",
    "where ",
    "1",
    ", ",
    ";",
    "(",
    ")",
    "'",
    "--",
    "/*",
    "*/",
    "x.",
    "t.",
    "caf\u{e9}",
    "\u{1F600}",
    "a\u{1F600}b",
    "\u{2603} ",
    "\n",
    "-- \u{1F4CA} note\n",
    " visualize using table ()",
    " visualize using vegalite (mark => bar, dashboard => (row => 1, width => 4))",
    "create table t (a int);",
    "select * from t",
];

/// The offset of a byte offset in a unit
fn in_unit(text: &str, byte: usize, utf16: bool) -> u64 {
    if utf16 {
        text[..byte].encode_utf16().count() as u64
    } else {
        byte as u64
    }
}

/// The length of a text in a unit
fn unit_len(text: &str, utf16: bool) -> u64 {
    in_unit(text, text.len(), utf16)
}

/// A random char boundary
fn random_boundary(rng: &mut Rng, text: &str) -> usize {
    let mut b = rng.below(text.len() + 1);
    while !text.is_char_boundary(b) {
        b -= 1;
    }
    b
}

/// A random offset in a unit: mostly valid, sometimes inside a character or past the end
fn random_offset(rng: &mut Rng, text: &str, utf16: bool) -> u64 {
    let len = unit_len(text, utf16);
    match rng.below(12) {
        0 => rng.below(len as usize + 4) as u64,
        1 => len + rng.below(4) as u64,
        _ => in_unit(text, random_boundary(rng, text), utf16),
    }
}

/// A random text to insert
fn random_insert(rng: &mut Rng, inputs: &[String]) -> String {
    match rng.below(6) {
        0 => {
            // A piece of a snapshot input
            let input = rng.pick(inputs).clone();
            let begin = random_boundary(rng, &input);
            let rest = &input[begin..];
            let mut end = rest.len().min(rng.below(48) + 1);
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            rest[..end].to_string()
        }
        1 => (0..rng.below(4) + 1).map(|_| *rng.pick(CHARS)).collect(),
        _ => rng.pick(FRAGMENTS).to_string(),
    }
}

/// A text with random multi-byte characters inserted
fn sprinkle(rng: &mut Rng, text: &str) -> String {
    let mut out = text.to_string();
    for _ in 0..rng.below(3) {
        let at = random_boundary(rng, &out);
        out.insert_str(at, CHARS[1 + rng.below(4)]);
    }
    out
}

fn random_selection(rng: &mut Rng, text_after: &str, utf16: bool) -> Option<Box<EditorSelectionT>> {
    if rng.below(2) == 0 {
        return None;
    }
    let mut selection = EditorSelectionT::default();
    selection.head = random_offset(rng, text_after, utf16);
    selection.anchor = if rng.below(3) == 0 { random_offset(rng, text_after, utf16) } else { selection.head };
    Some(Box::new(selection))
}

/// A random editor event
fn random_event(rng: &mut Rng, session: &ScriptSession, inputs: &[String]) -> EditorEventT {
    let text = session.text();
    let utf16 = session.offset_unit() == EditorOffsetUnit::UTF16_CODE_UNITS;
    let mut event = EditorEventT::default();
    event.expected_text_version = match rng.below(14) {
        0 => session.text_version().wrapping_sub(1),
        1 => session.text_version() + 1,
        _ => session.text_version(),
    };
    let mut changes = Vec::new();
    for _ in 0..[0, 1, 1, 1, 2, 3][rng.below(6)] {
        let mut change = EditorTextChangeT::default();
        change.from = random_offset(rng, &text, utf16);
        change.to = match rng.below(5) {
            0 => change.from,
            1 => random_offset(rng, &text, utf16),
            _ => {
                // A short deletion that respects boundaries if the begin does
                let from_byte = if utf16 { None } else { Some(change.from as usize) };
                match from_byte.filter(|&b| b <= text.len() && text.is_char_boundary(b)) {
                    Some(b) => {
                        let n = rng.below(4);
                        let end = text[b..].char_indices().nth(n).map_or(text.len(), |(i, _)| b + i);
                        end as u64
                    }
                    None => change.from + rng.below(3) as u64,
                }
            }
        };
        change.insert = (rng.below(8) != 0).then(|| random_insert(rng, inputs));
        changes.push(change);
    }
    event.changes = (rng.below(10) != 0).then_some(changes);
    // The selection uses post-change offsets, guess them from the text before the change
    event.primary_selection = random_selection(rng, &text, utf16);
    event.origin = EditorEventOrigin(rng.below(6) as u8);
    event.intent = EditorEventIntent(rng.below(6) as u8);
    event.action = EditorEventAction(rng.below(9) as u8);
    event.analyze = rng.below(2) == 0;
    event
}

fn random_config(rng: &mut Rng) -> FormattingConfigT {
    let mut config = FormattingConfigT::default();
    config.dialect = *rng.pick(&[FormattingDialect::HYPER, FormattingDialect::TRINO]);
    config.mode = *rng.pick(&[FormattingMode::INLINE, FormattingMode::COMPACT, FormattingMode::PRETTY]);
    config.max_width = *rng.pick(&[0, 20, 80, 120]);
    config.indentation_width = *rng.pick(&[0, 2, 4]);
    config.debug_mode = rng.below(6) == 0;
    config.keyword_case = *rng.pick(&[KeywordCase::LOWER, KeywordCase::UPPER]);
    config
}

/// A pair of sessions, one per core
struct Pair<'c> {
    cpp: OracleSession<'c>,
    rust: ScriptSession,
}

/// Compare the observable state of all sessions and the catalogs
fn compare_state(pairs: &[Pair], cpp_catalog: &OracleCatalog, rust_catalog: &CatalogHandle) -> Result<(), String> {
    for (i, pair) in pairs.iter().enumerate() {
        let state = pair.cpp.state();
        let rust = &pair.rust;
        same(
            &format!("state of session {i}"),
            &(
                state.text_version,
                state.state_revision,
                state.catalog_entry_id,
                String::from_utf8_lossy(&state.text).into_owned(),
            ),
            &(rust.text_version(), rust.state_revision(), rust.catalog_entry_id(), rust.text()),
        )?;
    }
    same("catalog version", &cpp_catalog.version(), &(rust_catalog.borrow().version() as u64))
}

/// Drive an execution of a session in both cores
fn run_execution(rng: &mut Rng, pair: &mut Pair, log: &mut Vec<String>) -> Result<(), String> {
    let config = random_config(rng);
    let config_bytes = pack!(config);
    let Some(mut cpp) = pair.cpp.execution(&config_bytes) else {
        return Err("C++ execution failed".into());
    };
    let mut rust = ScriptExecution::new(&mut pair.rust, config);
    let mut pending: Option<u64> = None;
    for step in 0..rng.below(8) + 1 {
        let (what, expected, actual) = match rng.below(6) {
            0 | 1 if step == 0 || rng.below(4) == 0 => ("start", cpp.start(), rust.start()),
            0 => ("cancel", cpp.cancel(), rust.cancel()),
            _ => {
                let mut result = StatementResultT::default();
                result.pending_statement_id = match (pending, rng.below(8)) {
                    (Some(id), 0) => id + 1,
                    (Some(id), _) => id,
                    (None, _) => rng.below(3) as u64,
                };
                result.status = match rng.below(10) {
                    0 => StatementResultStatus(3 + rng.below(5) as u8),
                    1 => StatementResultStatus::FAILED,
                    2 => StatementResultStatus::CANCELLED,
                    _ => StatementResultStatus::SUCCEEDED,
                };
                result.error = match rng.below(3) {
                    0 => None,
                    1 => Some(String::new()),
                    _ => Some("boom \u{1F600}".to_string()),
                };
                let bytes = pack!(result);
                ("resume", cpp.resume(&bytes), rust.resume(&result))
            }
        };
        note(log, format!("execution {what}"));
        compare_execution(&format!("execution {what}"), expected, &actual)?;
        if let Some(statement) = &actual.pending_statement {
            pending = Some(statement.id);
        }
    }
    Ok(())
}

/// Run one episode of random operations
fn episode(
    seed: u64,
    input: &str,
    own_catalog: Option<&str>,
    inputs: &[String],
    catalogs: &[String],
    steps: usize,
) -> Result<(), String> {
    let mut rng = Rng::new(seed);
    let mut log: Vec<String> = Vec::new();
    let result = (|| -> Result<(), String> {
        let cpp_catalog = OracleCatalog::new();
        let rust_catalog: CatalogHandle = Rc::new(RefCell::new(Catalog::new()));
        let new_pair = |rng: &mut Rng| {
            let unit = rng.below(2) as u8;
            Pair {
                cpp: cpp_catalog.session(unit),
                rust: ScriptSession::new(rust_catalog.clone(), EditorOffsetUnit(unit)).unwrap(),
            }
        };
        let mut pairs = vec![new_pair(&mut rng)];
        // A schema session, published into the catalog
        if own_catalog.is_some() || (!catalogs.is_empty() && rng.below(2) == 0) {
            let mut schema = new_pair(&mut rng);
            let text = match own_catalog {
                Some(c) if rng.below(4) != 0 => c.to_string(),
                _ => rng.pick(catalogs).clone(),
            };
            compare_update("schema replace", schema.cpp.replace_text(0, &text), schema.rust.replace_text(0, &text))?;
            compare_update("schema analyze", schema.cpp.analyze(), schema.rust.analyze())?;
            same_result("schema load", schema.cpp.load_into_catalog(1), schema.rust.load_into_catalog(1))?;
            pairs.push(schema);
        }
        let text = if rng.below(2) == 0 { sprinkle(&mut rng, input) } else { input.to_string() };
        note(&mut log, format!("replace {text:?}"));
        compare_update("initial replace", pairs[0].cpp.replace_text(0, &text), pairs[0].rust.replace_text(0, &text))?;
        compare_state(&pairs, &cpp_catalog, &rust_catalog)?;
        // Walk the cursor through the unedited script, before random edits break its references
        if rng.below(2) == 0 {
            let pair = &mut pairs[0];
            note(&mut log, "analyze".into());
            compare_update("walk analyze", pair.cpp.analyze(), pair.rust.analyze())?;
            let utf16 = pair.rust.offset_unit() == EditorOffsetUnit::UTF16_CODE_UNITS;
            for _ in 0..6 {
                let offset = in_unit(&text, random_boundary(&mut rng, &text), utf16);
                note(&mut log, format!("cursor {offset}"));
                let version = pair.rust.text_version();
                compare_update(
                    "walk cursor",
                    pair.cpp.set_primary_cursor(version, offset),
                    pair.rust.set_primary_cursor(version, offset),
                )?;
                let keyword_case = rng.below(2) as u8;
                let expected = pair.cpp.complete(8, keyword_case).and_then(|b| unpack!(b, Completion));
                let actual = pair.rust.complete(8, KeywordCase(keyword_case)).map(|c| roundtrip!(c, Completion));
                same_result("walk complete", expected, actual)?;
            }
        }

        for _ in 0..steps {
            // Mostly the editor session, so that the schema session stays published
            let i = if rng.below(4) == 0 { rng.below(pairs.len()) } else { 0 };
            let op = rng.below(40);
            if op == 38 {
                // Open another session, or close one (the C++ destructor drops it from the catalog)
                if pairs.len() < 4 && rng.below(2) == 0 {
                    note(&mut log, "new session".into());
                    let mut pair = new_pair(&mut rng);
                    let text = rng.pick(inputs).clone();
                    compare_update("new session", pair.cpp.replace_text(0, &text), pair.rust.replace_text(0, &text))?;
                    pairs.push(pair);
                } else if pairs.len() > 1 {
                    note(&mut log, format!("close session {i}"));
                    pairs.remove(i);
                }
                compare_state(&pairs, &cpp_catalog, &rust_catalog)?;
                continue;
            }
            let pair = &mut pairs[i];
            match op {
                0..=11 => {
                    let event = random_event(&mut rng, &pair.rust, inputs);
                    note(&mut log, format!("{i}: apply {event:?}"));
                    let bytes = pack!(event);
                    compare_update("apply", pair.cpp.apply(&bytes), pair.rust.apply_buffer(&bytes))?;
                }
                12..=13 => {
                    let text = if rng.below(2) == 0 {
                        let picked = rng.pick(inputs).clone();
                        sprinkle(&mut rng, &picked)
                    } else {
                        pair.rust.text()
                    };
                    let expected =
                        if rng.below(8) == 0 { pair.rust.text_version() + 1 } else { pair.rust.text_version() };
                    note(&mut log, format!("{i}: replace {expected} {text:?}"));
                    compare_update(
                        "replace",
                        pair.cpp.replace_text(expected, &text),
                        pair.rust.replace_text(expected, &text),
                    )?;
                }
                14..=17 => {
                    let utf16 = pair.rust.offset_unit() == EditorOffsetUnit::UTF16_CODE_UNITS;
                    let offset = random_offset(&mut rng, &pair.rust.text(), utf16);
                    let expected = if rng.below(10) == 0 {
                        pair.rust.text_version().wrapping_sub(1)
                    } else {
                        pair.rust.text_version()
                    };
                    note(&mut log, format!("{i}: cursor {expected} {offset}"));
                    compare_update(
                        "cursor",
                        pair.cpp.set_primary_cursor(expected, offset),
                        pair.rust.set_primary_cursor(expected, offset),
                    )?;
                }
                18..=20 => {
                    note(&mut log, format!("{i}: analyze"));
                    compare_update("analyze", pair.cpp.analyze(), pair.rust.analyze())?;
                }
                21..=23 => {
                    let limit = rng.below(20) + 1;
                    let keyword_case = rng.below(2) as u8;
                    note(&mut log, format!("{i}: complete {limit} {keyword_case}"));
                    let expected = pair.cpp.complete(limit, keyword_case).and_then(|b| unpack!(b, Completion));
                    let actual =
                        pair.rust.complete(limit, KeywordCase(keyword_case)).map(|c| roundtrip!(c, Completion));
                    if let Ok(c) = &actual {
                        let n = c.candidates.as_ref().map_or(0, |c| c.len());
                        count(format!(
                            "complete {:?} candidates {}",
                            pair.rust.offset_unit(),
                            if n == 0 { "none" } else { "some" }
                        ));
                    }
                    same_result("complete", expected, actual)?;
                }
                24..=25 => {
                    let config = random_config(&mut rng);
                    let (allow_extensions, parse_if_outdated) = (rng.below(4) != 0, rng.below(3) != 0);
                    note(&mut log, format!("{i}: compile {allow_extensions} {parse_if_outdated}"));
                    let expected = pair
                        .cpp
                        .compile(&pack!(config), allow_extensions, parse_if_outdated)
                        .and_then(|b| unpack!(b, ScriptCompilationResult));
                    let actual = roundtrip!(
                        pair.rust.compile_query(&config, allow_extensions, parse_if_outdated),
                        ScriptCompilationResult
                    );
                    same_result::<_>("compile", expected, Ok(actual))?;
                }
                26..=27 => {
                    let config = random_config(&mut rng);
                    let parse_if_outdated = rng.below(3) != 0;
                    note(&mut log, format!("{i}: format {parse_if_outdated}"));
                    let expected = pair
                        .cpp
                        .format(&pack!(config), parse_if_outdated)
                        .map(|(id, text)| (id, String::from_utf8_lossy(&text).into_owned()));
                    let actual =
                        pair.rust.format(&config, parse_if_outdated, None).map(|s| (s.catalog_entry_id(), s.to_text()));
                    same_result("format", expected, actual)?;
                }
                28 => {
                    let config = random_config(&mut rng);
                    let parse_if_outdated = rng.below(3) != 0;
                    note(&mut log, format!("{i}: formattable {parse_if_outdated}"));
                    same_result(
                        "formattable",
                        pair.cpp.is_fully_formattable(&pack!(config), parse_if_outdated),
                        pair.rust.is_fully_formattable(&config, parse_if_outdated),
                    )?;
                }
                29..=30 => {
                    let row = (rng.below(3) != 0).then(|| rng.below(16) as i32 - 2);
                    let column = (rng.below(3) != 0).then(|| rng.below(16) as i32 - 2);
                    let (width, height) = (rng.below(18) as i32 - 2, rng.below(8) as i32 - 2);
                    let parse_if_outdated = rng.below(4) != 0;
                    // The C API passes negative rows and columns as none
                    let (row, column) = (row.filter(|&r| r >= 0), column.filter(|&c| c >= 0));
                    note(&mut log, format!("{i}: dashboard {row:?} {column:?} {width} {height} {parse_if_outdated}"));
                    let expected = pair
                        .cpp
                        .rewrite_dashboard(row, column, width, height, parse_if_outdated)
                        .map(|t| String::from_utf8_lossy(&t).into_owned());
                    let actual = pair.rust.rewrite_dashboard(row, column, width, height, parse_if_outdated);
                    same_result("dashboard", expected, actual)?;
                }
                31..=32 => {
                    let target = match rng.below(3) {
                        0 => rng.pick(inputs).clone(),
                        1 => sprinkle(&mut rng, &pair.rust.text()),
                        _ => {
                            let mut text = pair.rust.text();
                            let at = random_boundary(&mut rng, &text);
                            text.insert_str(at, &random_insert(&mut rng, inputs));
                            text
                        }
                    };
                    note(&mut log, format!("{i}: diff {target:?}"));
                    let expected = pair.cpp.diff(&target).and_then(|b| unpack!(b, ScriptDiff));
                    let mut target_script = Script::new(&rust_catalog.borrow());
                    target_script.replace_text(&target);
                    target_script.parse();
                    let actual = pair.rust.diff(&target_script).map(|d| roundtrip!(d, ScriptDiff));
                    let what = format!("diff {:?}", pair.rust.offset_unit());
                    same_result(&what, expected, actual)?;
                }
                33 => {
                    let rank = rng.below(4) as u32;
                    note(&mut log, format!("{i}: load {rank}"));
                    same_result("load", pair.cpp.load_into_catalog(rank), pair.rust.load_into_catalog(rank))?;
                }
                34 => {
                    note(&mut log, format!("{i}: drop"));
                    pair.cpp.drop_from_catalog();
                    pair.rust.drop_from_catalog();
                }
                35 => {
                    let parse_if_outdated = rng.below(3) != 0;
                    note(&mut log, format!("{i}: statement text {parse_if_outdated}"));
                    let expected =
                        pair.cpp.statement_text(parse_if_outdated).map(|t| String::from_utf8_lossy(&t).into_owned());
                    same_result("statement text", expected, pair.rust.script_mut().statement_text(parse_if_outdated))?;
                }
                36..=37 => {
                    note(&mut log, format!("{i}: execution"));
                    run_execution(&mut rng, pair, &mut log)?;
                }
                _ => {
                    note(&mut log, format!("{i}: replace and analyze"));
                    let picked = rng.pick(inputs).clone();
                    let text = sprinkle(&mut rng, &picked);
                    let expected = pair.rust.text_version();
                    compare_update(
                        "replace",
                        pair.cpp.replace_text(expected, &text),
                        pair.rust.replace_text(expected, &text),
                    )?;
                    compare_update("analyze", pair.cpp.analyze(), pair.rust.analyze())?;
                }
            }
            compare_state(&pairs, &cpp_catalog, &rust_catalog)?;
        }
        // Closing all sessions drops their scripts
        drop(pairs);
        let rust_version = rust_catalog.borrow().version() as u64;
        same("catalog version after closing", &cpp_catalog.version(), &rust_version)
    })();
    result.map_err(|e| {
        let tail: Vec<&String> = log.iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
        let tail: Vec<String> = tail.iter().map(|l| l.chars().take(600).collect()).collect();
        format!("seed {seed}, input {input:?}\nlast operations:\n  {}\n{e}", tail.join("\n  "))
    })
}

fn main() {
    let args = Arguments::from_args();
    let mut catalogs: Vec<String> = Vec::new();
    for category in ["analyzer", "completion", "visualize"] {
        for case in load_category(category).expect("cannot load snapshots") {
            if let Some(c) = case.node["catalog"]["script"]["input"].as_str().map(trim_input) {
                if !catalogs.contains(&c) {
                    catalogs.push(c);
                }
            }
        }
    }
    let catalogs = std::sync::Arc::new(catalogs);
    let mut trials = Vec::new();
    for category in CATEGORIES {
        // The inputs of a file, each with the catalog script of its case
        let mut files: Vec<(String, Vec<(String, Option<String>)>)> = Vec::new();
        for case in load_category(category).expect("cannot load snapshots") {
            let catalog = case.node["catalog"]["script"]["input"].as_str().map(trim_input);
            let mut inputs = Vec::new();
            collect_inputs(&case.node, &mut inputs);
            let inputs = inputs.into_iter().map(|i| (i, catalog.clone()));
            match files.last_mut() {
                Some((file, all)) if *file == case.file => all.extend(inputs),
                _ => files.push((case.file.clone(), inputs.collect())),
            }
        }
        for (file, cases) in files {
            if cases.is_empty() {
                continue;
            }
            let catalogs = catalogs.clone();
            trials.push(Trial::test(format!("{category}::{file}"), move || {
                let inputs: Vec<String> = cases.iter().map(|(i, _)| i.clone()).collect();
                for (i, (input, catalog)) in cases.iter().enumerate() {
                    // Fewer steps for long inputs, which are slow to analyze and complete
                    let steps = if input.len() > 2000 { 12 } else { 40 };
                    let seed = (i as u64 + 1) * 7919 + input.len() as u64;
                    episode(seed, input, catalog.as_deref(), &inputs, &catalogs, steps).map_err(Failed::from)?;
                }
                Ok(())
            }));
        }
    }
    let conclusion = run(&args, trials);
    eprintln!("session differential: {} comparisons", COMPARISONS.load(Ordering::Relaxed));
    for (outcome, n) in OUTCOMES.lock().unwrap().iter() {
        eprintln!("  {n:>8}  {outcome}");
    }
    conclusion.exit();
}
