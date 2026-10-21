//! The formatter snapshots (`snapshots/formatter/*.yaml`), produced by the Rust formatter.
//!
//! Reads the snapshots like the C++ suite (`src/testing/formatter_snapshot_test.cc`,
//! `test/formatter_snapshot_test_suite.cc`): every case formats its input for every expectation of
//! every dialect that is not skipped. Cases named `coverage_*` must also be fully formattable, and
//! their formatted output must scan and parse without errors.

use dashql_core::formatter::{formatting_mode_to_string, Formatter};
use dashql_parser::parser::parse;
use dashql_parser::scanner::scan;
use dashql_snapshots::formatter::{load_formatter_cases, DialectExpectations};
use dashql_snapshots::{run, Arguments, Failed, Trial};
use std::sync::Arc;

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
    let cases = load_formatter_cases().unwrap_or_else(|e| panic!("cannot load formatter snapshots: {e}"));
    let mut trials = Vec::new();
    let mut expectations = 0;
    for case in cases {
        expectations += case.dialects.iter().filter(|d| !d.skip).map(|d| d.expectations.len()).sum::<usize>();
        let name = case.case.trial_name();
        trials
            .push(Trial::test(name, move || check(&case.case.name, &case.input, &case.dialects).map_err(Failed::from)));
    }
    println!("{} formatter cases, {expectations} expectations", trials.len());
    run(&args, trials).exit();
}
