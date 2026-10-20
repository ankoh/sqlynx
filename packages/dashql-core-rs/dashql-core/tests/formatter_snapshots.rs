//! The formatter snapshots (`snapshots/formatter/*.yaml`), produced by the Rust formatter.
//!
//! Reads the snapshots like the C++ suite (`src/testing/formatter_snapshot_test.cc`,
//! `test/formatter_snapshot_test_suite.cc`): every case formats its input for every expectation of
//! every dialect that is not skipped. Cases named `coverage_*` must also be fully formattable, and
//! their formatted output must scan and parse without errors.

use dashql_buffers::formatting::FormattingConfigT;
use dashql_core::formatter::{
    formatting_mode_to_string, parse_formatting_dialect, parse_formatting_mode, Formatter,
    FORMATTING_DEFAULT_INDENTATION_WIDTH, FORMATTING_DEFAULT_MAX_WIDTH,
};
use dashql_grammar::parser::parse;
use dashql_grammar::scanner::scan;
use dashql_snapshots::{load_category, run, Arguments, Failed, Trial, Yaml};
use std::sync::Arc;

/// One (config, expected output) pair
struct Expectation {
    config: FormattingConfigT,
    formatted: String,
}

/// The expectations of a dialect
struct DialectExpectations {
    dialect: String,
    skip: bool,
    expectations: Vec<Expectation>,
}

/// Trim spaces and newlines on both ends (`trim_view(..., is_no_space)`)
fn trim_no_space(text: &str) -> String {
    text.trim_matches([' ', '\n']).to_string()
}

/// A scalar as text, like ryml's `val()`
fn scalar(node: &Yaml) -> Option<String> {
    match node {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Real(r) => Some(r.clone()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

/// `std::atoi`: leading whitespace, an optional sign, then digits
fn atoi(text: &str) -> usize {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let value: i64 = digits.bytes().take_while(u8::is_ascii_digit).fold(0, |v, d| v * 10 + (d - b'0') as i64);
    (if negative { -value } else { value }) as usize
}

fn read_dialects(case: &Yaml) -> Vec<DialectExpectations> {
    let mut dialects = Vec::new();
    let Some(entries) = case["dialects"].as_hash() else { return dialects };
    for (key, dialect_node) in entries {
        let dialect = scalar(key).unwrap_or_default();
        let parsed_dialect = parse_formatting_dialect(&dialect);
        let skip = scalar(&dialect_node["skip"]).is_some_and(|v| v == "true" || v == "1");
        let mut expectations = Vec::new();
        for formatted in dialect_node["formatted"].as_vec().into_iter().flatten() {
            let mut config = FormattingConfigT::default();
            config.dialect = parsed_dialect;
            config.mode = parse_formatting_mode(&scalar(&formatted["mode"]).unwrap_or_else(|| "compact".into()));
            config.indentation_width =
                scalar(&formatted["indent"]).map(|v| atoi(&v)).unwrap_or(FORMATTING_DEFAULT_INDENTATION_WIDTH) as u32;
            config.max_width =
                scalar(&formatted["width"]).map(|v| atoi(&v)).unwrap_or(FORMATTING_DEFAULT_MAX_WIDTH) as u32;
            let formatted = scalar(&formatted["expected"]).map(|v| trim_no_space(&v)).unwrap_or_default();
            expectations.push(Expectation { config, formatted });
        }
        if skip || !expectations.is_empty() {
            dialects.push(DialectExpectations { dialect, skip, expectations });
        }
    }
    dialects
}

fn check(name: &str, input: &str, dialects: &[DialectExpectations]) -> Result<(), String> {
    let parsed = parse(Arc::new(scan(input, 0, 2)));
    let mut formatter = Formatter::new(&parsed);
    let require_fully_formatted = name.starts_with("coverage_");
    for dialect in dialects.iter().filter(|d| !d.skip) {
        for (i, expectation) in dialect.expectations.iter().enumerate() {
            let label = format!(
                "dialect {} expectation {} (mode={} indent={})",
                dialect.dialect,
                i,
                formatting_mode_to_string(expectation.config.mode),
                expectation.config.indentation_width
            );
            let formatted = formatter.format(&expectation.config);
            if formatted.is_empty() {
                return Err(format!("{label}: output must not be empty"));
            }
            if formatted != expectation.formatted {
                return Err(format!("{label}\nexpected:\n{}\nactual:\n{formatted}", expectation.formatted));
            }
            if require_fully_formatted {
                if let Some(&node_id) = formatter.unformattable_nodes().first() {
                    let node = &parsed.nodes[node_id as usize];
                    return Err(format!(
                        "{label} has unformattable AST node {}/{}",
                        node.node_type().variant_name().unwrap_or(""),
                        node.attribute_key().variant_name().unwrap_or("")
                    ));
                }
                let reparsed = parse(Arc::new(scan(&formatted, 0, 2)));
                if !reparsed.scanned.errors.is_empty() {
                    return Err(format!("{label} produced scanner errors after formatting"));
                }
                if !reparsed.errors.is_empty() {
                    return Err(format!("{label} produced parser errors after formatting"));
                }
            }
        }
    }
    Ok(())
}

fn main() {
    let args = Arguments::from_args();
    let cases = load_category("formatter").unwrap_or_else(|e| panic!("cannot load formatter snapshots: {e}"));
    let mut trials = Vec::new();
    let mut expectations = 0;
    for case in cases {
        let dialects = read_dialects(&case.node);
        // Like the C++ suite, cases without dialect expectations are not tests
        if dialects.is_empty() {
            continue;
        }
        expectations += dialects.iter().filter(|d| !d.skip).map(|d| d.expectations.len()).sum::<usize>();
        let input = scalar(&case.node["input"]).map(|v| trim_no_space(&v)).unwrap_or_default();
        let name = case.name.clone();
        trials.push(Trial::test(case.trial_name(), move || check(&name, &input, &dialects).map_err(Failed::from)));
    }
    println!("{} formatter cases, {expectations} expectations", trials.len());
    run(&args, trials).exit();
}
