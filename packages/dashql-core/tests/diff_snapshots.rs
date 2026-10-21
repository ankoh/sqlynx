//! The diff snapshots (snapshots/diff/*.yaml).

use dashql_core::script_diff::ScriptDiff;
use dashql_parser::parser::{parse, ParsedScript};
use dashql_parser::scanner::scan;
use dashql_snapshots::encode::diff::encode_diff;
use dashql_snapshots::{compare, load_category, run, trim_input, Arguments, Failed, Trial};
use std::sync::Arc;

fn parse_text(text: &str, external_id: u32) -> ParsedScript {
    parse(Arc::new(scan(text, 0, external_id)))
}

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();

    for case in load_category("diff").expect("cannot load diff snapshots") {
        if case.expected().is_none() {
            continue;
        }
        trials.push(Trial::test(case.trial_name(), move || {
            let source = case.node["source"].as_str().map(trim_input).unwrap_or_default();
            let target = case.node["target"].as_str().map(trim_input).unwrap_or_default();
            let source_parsed = parse_text(&source, 1);
            let target_parsed = parse_text(&target, 2);
            let mut diff = ScriptDiff::new(&source_parsed, &target_parsed);
            let produced = encode_diff(diff.compute(), &source, &target).to_yaml();
            compare(case.expected().unwrap(), &produced).map_err(Failed::from)
        }));
    }

    run(&args, trials).exit();
}
