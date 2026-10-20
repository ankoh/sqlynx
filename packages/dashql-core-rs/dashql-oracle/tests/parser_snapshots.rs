//! Replays every parser snapshot through the C++ oracle.
//!
//! This validates the two pieces the Rust parser will be measured with: the snapshot harness
//! (loading, input trimming, structural comparison) and the oracle (which must reproduce the
//! checked-in snapshots exactly). It also catches snapshot files that the C++ test suite does
//! not register and that went stale.

use dashql_snapshots::{compare, load_category, parse_yaml, run, Arguments, Failed, Trial};

fn main() {
    let args = Arguments::from_args();
    let cases = load_category("parser").expect("cannot load parser snapshots");
    assert!(!cases.is_empty(), "no parser snapshots found");

    let trials = cases
        .into_iter()
        .filter(|case| case.expected().is_some())
        .map(|case| {
            Trial::test(case.trial_name(), move || {
                let input = case.input().ok_or("case without input")?;
                let produced = dashql_oracle::parse(&input).map_err(|e| format!("oracle failed: {e}"))?;
                let produced = parse_yaml(&produced)?;
                compare(case.expected().unwrap(), &produced).map_err(Failed::from)
            })
        })
        .collect();
    run(&args, trials).exit();
}
