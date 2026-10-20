//! The Rust formatter must produce exactly the output of the C++ formatter.
//!
//! Compares the formatted text and the unformattable nodes (`Formatter::Format`), and single nodes
//! formatted with executable literals (`Formatter::FormatNodeAt` after `ReplaceObfuscatedLiterals`)
//! on:
//!   - every `input` of every snapshot file, across all modes, dialects and keyword cases and a few
//!     widths, indentations and the debug mode,
//!   - prefixes of these inputs,
//!   - deterministic fuzz inputs of SQL fragments and comments.

use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode, KeywordCase};
use dashql_core::formatter::Formatter;
use dashql_grammar::parser::{parse, ParsedScript};
use dashql_grammar::scanner::scan;
use dashql_oracle::formatter::{self as oracle, FormattingConfig};
use dashql_snapshots::corpus::{fragments, prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::{run, Arguments, Failed, Trial};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Statistics: formatted scripts, formatted nodes, outputs with unformattable nodes, non-empty outputs
static SCRIPTS: AtomicUsize = AtomicUsize::new(0);
static NODES: AtomicUsize = AtomicUsize::new(0);
static UNFORMATTABLE: AtomicUsize = AtomicUsize::new(0);
static NON_EMPTY: AtomicUsize = AtomicUsize::new(0);

fn count(formatted: &oracle::Formatted, counter: &AtomicUsize) {
    counter.fetch_add(1, Ordering::Relaxed);
    if !formatted.unformattable_nodes.is_empty() {
        UNFORMATTABLE.fetch_add(1, Ordering::Relaxed);
    }
    if !formatted.text.is_empty() {
        NON_EMPTY.fetch_add(1, Ordering::Relaxed);
    }
}

fn config(mode: FormattingMode, dialect: FormattingDialect, keyword_case: KeywordCase) -> FormattingConfig {
    FormattingConfig {
        dialect: dialect.0,
        mode: mode.0,
        keyword_case: keyword_case.0,
        debug_mode: 0,
        max_width: 120,
        indentation_width: 2,
    }
}

/// All modes, dialects and keyword cases, plus other widths, indentations and the debug mode
fn all_configs() -> Vec<FormattingConfig> {
    let mut configs = Vec::new();
    for mode in [FormattingMode::INLINE, FormattingMode::COMPACT, FormattingMode::PRETTY] {
        for dialect in [FormattingDialect::HYPER, FormattingDialect::TRINO] {
            for keyword_case in [KeywordCase::LOWER, KeywordCase::UPPER] {
                configs.push(config(mode, dialect, keyword_case));
            }
        }
    }
    let narrow = |mode: FormattingMode, max_width, indentation_width, debug_mode| FormattingConfig {
        max_width,
        indentation_width,
        debug_mode,
        ..config(mode, FormattingDialect::HYPER, KeywordCase::LOWER)
    };
    configs.push(narrow(FormattingMode::COMPACT, 40, 4, 0));
    configs.push(narrow(FormattingMode::PRETTY, 20, 2, 0));
    configs.push(narrow(FormattingMode::COMPACT, 3, 0, 1));
    configs.push(narrow(FormattingMode::PRETTY, 60, 3, 1));
    configs
}

/// A smaller set for prefixes and fuzz inputs
fn some_configs() -> Vec<FormattingConfig> {
    let all = all_configs();
    vec![all[0], all[3], all[8], all[13], all[14]]
}

fn to_config(c: &FormattingConfig) -> FormattingConfigT {
    let mut config = FormattingConfigT::default();
    config.dialect = FormattingDialect(c.dialect);
    config.mode = FormattingMode(c.mode);
    config.keyword_case = KeywordCase(c.keyword_case);
    config.debug_mode = c.debug_mode != 0;
    config.max_width = c.max_width;
    config.indentation_width = c.indentation_width;
    config
}

fn difference(
    input: &str,
    what: &str,
    config: &FormattingConfig,
    expected: &oracle::Formatted,
    actual: &oracle::Formatted,
) -> String {
    format!(
        "input {input:?}\n{what} with {config:?}\n\
         C++ unformattable: {:?}\nRust unformattable: {:?}\nC++:\n{}\nRust:\n{}",
        expected.unformattable_nodes, actual.unformattable_nodes, expected.text, actual.text
    )
}

/// Nodes to format on their own: the statement roots and a sample of the other nodes
fn sample_nodes(parsed: &ParsedScript) -> Vec<u32> {
    let mut nodes: Vec<u32> = parsed.statements.iter().map(|s| s.root).collect();
    let step = (parsed.nodes.len() / 8).max(1);
    nodes.extend((0..parsed.nodes.len() as u32).step_by(step).take(8));
    nodes
}

fn compare(input: &str, configs: &[FormattingConfig], format_nodes: bool) -> Result<(), String> {
    let parsed = parse(Arc::new(scan(input, 0, 2)));
    let mut formatter = Formatter::new(&parsed);
    for config in configs {
        let expected = oracle::format(input, config).map_err(|e| format!("oracle failed on {input:?}: {e}"))?;
        let text = formatter.format(&to_config(config));
        let actual = oracle::Formatted { unformattable_nodes: formatter.unformattable_nodes(), text };
        if expected != actual {
            return Err(difference(input, "format", config, &expected, &actual));
        }
        count(&actual, &SCRIPTS);
    }
    if !format_nodes {
        return Ok(());
    }
    let config = &configs[configs.len().min(2) - 1];
    let mut node_formatter = Formatter::new(&parsed);
    node_formatter.replace_obfuscated_literals();
    for node_id in sample_nodes(&parsed) {
        let expected =
            oracle::format_node(input, node_id, config).map_err(|e| format!("oracle failed on {input:?}: {e}"))?;
        let text = node_formatter.format_node_at(node_id as usize, &to_config(config));
        let actual = oracle::Formatted { unformattable_nodes: node_formatter.unformattable_nodes(), text };
        if expected != actual {
            return Err(difference(input, &format!("format_node {node_id}"), config, &expected, &actual));
        }
        count(&actual, &NODES);
    }
    Ok(())
}

/// SQL fragments and comments for fuzz inputs that are mostly invalid
const FRAGMENTS: &[&str] = &[
    "select ",
    "from ",
    "where ",
    "group by ",
    "order by ",
    "having ",
    "limit ",
    "union ",
    "with ",
    "as ",
    "join ",
    "on ",
    "and ",
    "or ",
    "not ",
    "in ",
    "between ",
    "like ",
    "is ",
    "null ",
    "case ",
    "when ",
    "then ",
    "else ",
    "end ",
    "create table ",
    "insert into ",
    "values ",
    "delete from ",
    "visualize ",
    "using ",
    "vegalite ",
    "default ",
    "explain ",
    "a",
    "b.c",
    "\"q\"",
    "'s'",
    "1",
    "2.5",
    "(",
    ")",
    ",",
    ";",
    "*",
    "+",
    "-",
    "=",
    "<",
    ".",
    "::",
    "?",
    "$1",
    "x ",
    "mark ",
    "encoding ",
    "{",
    "}",
    ":",
    "[",
    "]",
    "/*Integer(1A2B)*/",
    "/*String(00FF)*/",
    "\n",
    "\n\n",
    "-- c\n",
    "--\n",
    "-- a long comment with some words\n",
    "-- @dashql:meta\n",
    "-- @dashql:end\n",
    "-- {\"k\":  1}\n",
    "/* block */",
    "-- ünïcödé wörds\n",
    "--xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n",
    "\t",
    "\r\n",
];

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();

    for &category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            trials.push(Trial::test(format!("{category}::{file}"), move || {
                let all = all_configs();
                let some = some_configs();
                for input in &inputs {
                    compare(input, &all, true)?;
                }
                for input in &inputs {
                    for prefix in prefixes(input, 24) {
                        compare(prefix, &some, false)?;
                    }
                }
                Ok::<(), Failed>(())
            }));
        }
    }

    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::batch_{batch:02}"), move || {
            let mut rng = Rng::new(3000 + batch);
            let some = some_configs();
            for _ in 0..300 {
                compare(&fragments(&mut rng, FRAGMENTS, 20), &some, true)?;
            }
            Ok::<(), Failed>(())
        }));
    }

    let conclusion = run(&args, trials);
    println!(
        "{} scripts and {} nodes formatted identically ({} non-empty, {} with unformattable nodes)",
        SCRIPTS.load(Ordering::Relaxed),
        NODES.load(Ordering::Relaxed),
        NON_EMPTY.load(Ordering::Relaxed),
        UNFORMATTABLE.load(Ordering::Relaxed)
    );
    conclusion.exit();
}
