//! The diff snapshots (snapshots/diff/*.yaml), and a differential test of the script diff against the
//! C++ core on pairs of snapshot inputs and their edits.

use dashql_buffers::diff::ScriptDiffOpCode;
use dashql_core::script_diff::{DiffOp, ScriptDiff};
use dashql_grammar::parser::{parse, ParsedScript};
use dashql_grammar::scanner::scan;
use dashql_snapshots::corpus::{snapshot_inputs, Rng};
use dashql_snapshots::encode::{encode_location_text, Map};
use dashql_snapshots::{compare, load_category, run, trim_input, Arguments, Failed, Trial, Yaml};
use std::fmt::Write as _;
use std::sync::Arc;

fn parse_text(text: &str, external_id: u32) -> ParsedScript {
    parse(Arc::new(scan(text, 0, external_id)))
}

/// `DiffSnapshotTest::EncodeDiff`
fn encode_diff(ops: &[DiffOp], source_text: &str, target_text: &str) -> Yaml {
    let items = ops
        .iter()
        .map(|op| {
            let mut m = Map::new();
            m.plain("code", op.code.variant_name().unwrap_or(""));
            if let Some(s) = op.source_statement {
                m.int("source-statement", s as i64);
            }
            if let Some(t) = op.target_statement {
                m.int("target-statement", t as i64);
            }
            match op.code {
                ScriptDiffOpCode::UPDATE => {
                    let changes = op
                        .target_changes
                        .iter()
                        .map(|c| {
                            let mut cm = Map::new();
                            encode_location_text(&mut cm, target_text, c.offset, c.length, "text");
                            cm.into_yaml()
                        })
                        .collect();
                    m.insert("target-changes", Yaml::Array(changes));
                }
                ScriptDiffOpCode::DELETE => {
                    encode_location_text(&mut m, source_text, op.source_span.offset, op.source_span.length, "source-span")
                }
                _ => encode_location_text(&mut m, target_text, op.target_span.offset, op.target_span.length, "target-span"),
            }
            m.into_yaml()
        })
        .collect();
    let mut root = Map::new();
    root.insert("ops", Yaml::Array(items));
    root.into_yaml()
}

/// Dump ops in the format of `dashql_oracle_script_diff`
fn dump(ops: &[DiffOp]) -> String {
    let mut out = String::new();
    for op in ops {
        let _ = write!(
            out,
            "{} {} {} {} {} {} {} {}",
            op.code.0,
            op.source_statement.unwrap_or(u32::MAX),
            op.target_statement.unwrap_or(u32::MAX),
            op.source_span.offset,
            op.source_span.length,
            op.target_span.offset,
            op.target_span.length,
            op.target_changes.len()
        );
        for c in &op.target_changes {
            let _ = write!(out, " {} {}", c.offset, c.length);
        }
        out.push('\n');
    }
    out
}

fn compare_with_oracle(source: &str, target: &str) -> Result<(), String> {
    let expected = dashql_oracle::script_diff::script_diff(source, target)?;
    let source_parsed = parse_text(source, 1);
    let target_parsed = parse_text(target, 2);
    let actual = dump(ScriptDiff::new(&source_parsed, &target_parsed).compute());
    if expected != actual {
        return Err(format!("source {source:?}\ntarget {target:?}\nC++:\n{expected}\nRust:\n{actual}"));
    }
    Ok(())
}

/// Edit a script: drop, duplicate, swap, or alter statements
fn edit(rng: &mut Rng, text: &str) -> String {
    let mut statements: Vec<String> = text.split(';').map(|s| s.to_string()).collect();
    for _ in 0..1 + rng.below(3) {
        if statements.is_empty() {
            break;
        }
        let i = rng.below(statements.len());
        match rng.below(5) {
            0 => {
                statements.remove(i);
            }
            1 => {
                let s = statements[i].clone();
                statements.insert(rng.below(statements.len() + 1), s);
            }
            2 => {
                let j = rng.below(statements.len());
                statements.swap(i, j);
            }
            3 => statements[i] = statements[i].replacen(' ', " 1 + ", 1),
            _ => statements[i] = statements[i].replace("a", "b"),
        }
    }
    statements.join(";")
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
            let produced = encode_diff(diff.compute(), &source, &target);
            compare(case.expected().unwrap(), &produced).map_err(Failed::from)
        }));
    }

    for category in ["analyzer", "formatter", "parser"] {
        for (file, inputs) in snapshot_inputs(category) {
            trials.push(Trial::test(format!("differential::{category}::{file}"), move || {
                let mut rng = Rng::new(inputs.len() as u64);
                for (i, source) in inputs.iter().enumerate() {
                    let target = edit(&mut rng, source);
                    compare_with_oracle(source, &target)?;
                    compare_with_oracle(&target, source)?;
                    let other = &inputs[(i + 1) % inputs.len()];
                    compare_with_oracle(source, other)?;
                }
                Ok::<(), Failed>(())
            }));
        }
    }
    run(&args, trials).exit();
}
