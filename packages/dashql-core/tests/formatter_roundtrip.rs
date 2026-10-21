//! Formats the scripts of the parser snapshots and checks the output against the parser.
//!
//! Every script of the parser snapshots that parses without errors must be fully formattable, and its
//! formatted output must parse without errors again. Without comments the output must also be stable
//! when it is formatted a second time.

use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode};
use dashql_core::formatter::Formatter;
use dashql_parser::parser::{parse, ParsedScript};
use dashql_parser::scanner::scan;
use dashql_snapshots::load_category;
use std::sync::Arc;

/// Scripts that the formatter rejects on purpose
const UNFORMATTABLE: &[&str] = &[
    // DEFAULT is only formatted as a value of an INSERT
    "select somefunc(default);",
];

/// Does the script parse without scanner and parser errors?
fn is_valid(parsed: &ParsedScript) -> bool {
    parsed.errors.is_empty() && parsed.scanned.errors.is_empty()
}

/// The config of the formatter runs
fn config(mode: FormattingMode) -> FormattingConfigT {
    let mut config = FormattingConfigT::default();
    config.dialect = FormattingDialect::HYPER;
    config.mode = mode;
    config.max_width = 120;
    config.indentation_width = 2;
    config
}

#[test]
fn formatted_parser_snapshots_parse_again() {
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in load_category("parser").unwrap() {
        let Some(input) = case.input() else { continue };
        let parsed = parse(Arc::new(scan(&input, 0, 2)));
        if !is_valid(&parsed) || UNFORMATTABLE.contains(&input.trim()) {
            continue;
        }
        for mode in [FormattingMode::INLINE, FormattingMode::COMPACT, FormattingMode::PRETTY] {
            checked += 1;
            let config = config(mode);
            let mut formatter = Formatter::new(&parsed);
            let formatted = formatter.format(&config);
            if !formatter.is_fully_formatted() {
                let nodes: Vec<_> = formatter
                    .unformattable_nodes()
                    .iter()
                    .map(|&n| format!("{:?}", parsed.nodes[n as usize].node_type().variant_name()))
                    .collect();
                failures.push(format!("{}: unformattable {nodes:?} in {input:?}", case.trial_name()));
                continue;
            }
            let reparsed = parse(Arc::new(scan(&formatted, 0, 2)));
            if !is_valid(&reparsed) {
                failures.push(format!("{}: output does not parse: {formatted:?} of {input:?}", case.trial_name()));
                continue;
            }
            if parsed.scanned.comments.is_empty() {
                let again = Formatter::new(&reparsed).format(&config);
                if again != formatted {
                    failures.push(format!("{}: unstable output {formatted:?} then {again:?}", case.trial_name()));
                }
            }
        }
    }
    assert!(checked > 1000, "only {checked} formatter runs");
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
}
