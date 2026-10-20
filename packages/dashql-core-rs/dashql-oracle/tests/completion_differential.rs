//! The Rust completion must produce exactly the output of the C++ completion.
//!
//! Compares the complete completion encoding of the snapshots on:
//!   - every cursor position of every completion snapshot case, against its catalog,
//!   - cursor positions in all snapshot inputs of the other categories, alone and against the
//!     completion snapshot catalogs,
//!   - the end of prefixes of these inputs (the write front).

use dashql_snapshots::corpus::{prefixes, snapshot_inputs, Rng};
use dashql_snapshots::encode::completion::{complete_case, CursorOffset};
use dashql_snapshots::{compare, load_category, parse_yaml, run, trim_input, Arguments, Failed, Trial};

/// The number of candidates
const LIMIT: usize = 10;

fn compare_with_oracle(catalog: Option<&str>, text: &str, offset: usize) -> Result<(), String> {
    let context = || format!("catalog {catalog:?}\nscript {text:?}\ncursor {offset} ({:?}|{:?})", &text[..offset], &text[offset..]);
    let expected = dashql_oracle::completion::complete(catalog, text, offset, LIMIT);
    let actual = complete_case(catalog, text, CursorOffset::Offset(offset), LIMIT);
    match (expected, actual) {
        (Ok(expected), Ok(actual)) => {
            let expected = parse_yaml(&expected).map_err(|e| format!("{}\n{e}", context()))?;
            compare(&expected, &actual.completions).map_err(|e| format!("{}\n{e}", context()))
        }
        (Err(_), Err(_)) => Ok(()),
        (e, a) => Err(format!("{}\nC++: {:?}\nRust: {:?}", context(), e.err(), a.err().map(|_| ()))),
    }
}

/// The cursor offsets of a text: every char boundary
fn offsets(text: &str) -> impl Iterator<Item = usize> + '_ {
    (0..=text.len()).filter(|&i| text.is_char_boundary(i))
}

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();

    let mut catalogs: Vec<String> = Vec::new();
    for case in load_category("completion").expect("cannot load completion snapshots") {
        let catalog = case.node["catalog"]["script"]["input"].as_str().map(trim_input);
        let editor = case.node["editor"]["input"].as_str().map(trim_input).unwrap_or_default();
        if let Some(c) = &catalog {
            if !catalogs.contains(c) {
                catalogs.push(c.clone());
            }
        }
        trials.push(Trial::test(format!("snapshot::{}", case.trial_name()), move || {
            for offset in offsets(&editor) {
                compare_with_oracle(catalog.as_deref(), &editor, offset).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    for category in ["analyzer", "formatter", "parser", "visualize", "planner"] {
        for (file, inputs) in snapshot_inputs(category) {
            let catalogs = catalogs.clone();
            trials.push(Trial::test(format!("inputs::{category}::{file}"), move || {
                let mut rng = Rng::new(inputs.len() as u64 + 7);
                // A budget of completions per file keeps large files (TPC-DS) fast
                let budget = 1500usize;
                let per_input = (budget / inputs.len().max(1)).max(4);
                for input in &inputs {
                    let catalog = (rng.below(2) == 0).then(|| rng.pick(&catalogs).as_str());
                    let positions: Vec<usize> = offsets(input).collect();
                    let step = (positions.len() / per_input).max(1);
                    for &offset in positions.iter().step_by(step) {
                        compare_with_oracle(catalog, input, offset).map_err(Failed::from)?;
                    }
                    for prefix in prefixes(input, 4) {
                        compare_with_oracle(catalog, prefix, prefix.len()).map_err(Failed::from)?;
                    }
                }
                Ok(())
            }));
        }
    }
    run(&args, trials).exit();
}
