//! The parser snapshots (snapshots/parser/*.yaml), produced by the Rust scanner and parser.

use dashql_grammar::parser::parse;
use dashql_grammar::scanner::scan;
use dashql_snapshots::encode::parser::encode_script;
use dashql_snapshots::{compare, load_category, run, Arguments, Failed, Trial};
use std::sync::Arc;

fn main() {
    let args = Arguments::from_args();
    let cases = load_category("parser").expect("cannot load parser snapshots");
    let trials = cases
        .into_iter()
        .filter(|case| case.expected().is_some())
        .map(|case| {
            Trial::test(case.trial_name(), move || {
                let input = case.input().ok_or("case without input")?;
                let parsed = parse(Arc::new(scan(&input, 0, 2)));
                let produced = encode_script(&parsed, &input).to_yaml();
                compare(case.expected().unwrap(), &produced).map_err(Failed::from)
            })
        })
        .collect();
    run(&args, trials).exit();
}
