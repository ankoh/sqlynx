//! Script signatures are persisted cache keys: the Rust signature must equal the C++ signature on
//! every snapshot input, prefixes of these inputs, and fuzz inputs.

use dashql_core::signature::compute_signature;
use dashql_grammar::parser::parse;
use dashql_grammar::scanner::scan;
use dashql_snapshots::corpus::{fragments, prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::{run, Arguments, Failed, Trial};
use std::sync::Arc;

fn compare_with_oracle(text: &str) -> Result<bool, String> {
    let expected = dashql_oracle::signature::signature(text);
    let parsed = parse(Arc::new(scan(text, 0, 1)));
    let actual = compute_signature(&parsed).map_err(|e| e.message);
    if expected != actual {
        return Err(format!("script {text:?}\nC++: {expected:?}\nRust: {actual:?}"));
    }
    Ok(expected.is_ok())
}

const FRAGMENTS: &[&str] = &[
    "select 1", "select a, b from t where x = 'y'", ";", "visualize select a from t using vegalite (mark bar)",
    "create table t (a int)", "insert into t values (1.5, interval '1 day')", " true", " null", "\n",
    "with q as (select 1) select * from q", "select f(a => 1)", "-- comment\n", "visualize t using markdown",
];

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();
    for category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            trials.push(Trial::test(format!("{category}::{file}"), move || {
                for input in &inputs {
                    compare_with_oracle(input).map_err(Failed::from)?;
                    for prefix in prefixes(input, 16) {
                        compare_with_oracle(prefix).map_err(Failed::from)?;
                    }
                }
                Ok(())
            }));
        }
    }
    trials.push(Trial::test("fuzz", || {
        let mut rng = Rng::new(0x5167);
        let mut signed = 0;
        for _ in 0..4000 {
            let text = fragments(&mut rng, FRAGMENTS, 6);
            signed += compare_with_oracle(&text).map_err(Failed::from)? as usize;
        }
        if signed < 500 {
            return Err(Failed::from(format!("only {signed} fuzz inputs could be signed")));
        }
        Ok(())
    }));
    run(&args, trials).exit();
}
