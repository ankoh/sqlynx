//! The FlatBuffers of scanned, parsed and analyzed scripts must equal those of the C++ core.
//!
//! Both sides are unpacked into the object API and compared, so field presence counts but the
//! byte layout of the builders does not, including the generated visualization specs. Runs over all snapshot inputs and their prefixes, alone
//! and against catalog scripts, through the `Script` facade.

use dashql_buffers::analyzer::AnalyzedScriptT;
use dashql_buffers::parser::{ParsedScriptT, ScannedScriptT};
use dashql_core::catalog::Catalog;
use dashql_core::pack::{pack_analyzed_script, pack_parsed_script, pack_scanned_script, pack_visualization};
use dashql_core::script::Script;
use dashql_oracle::pack::{pack, Packed};
use dashql_snapshots::corpus::{prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::{load_category, run, trim_input, Arguments, Failed, Trial};
use std::sync::Arc;

/// Analyze a script with the Rust core like the oracle does
fn analyze(catalog_text: Option<&str>, text: &str) -> Result<Script, String> {
    let mut catalog = Catalog::new();
    if let Some(c) = catalog_text {
        let mut script = Script::new(&catalog);
        script.insert_text_at(0, c);
        script.analyze(&catalog, true).map_err(|e| e.message)?;
        let analyzed = script.analyzed.clone().unwrap();
        catalog.load_script(analyzed, script.catalog_entry_id()).map_err(|e| e.message)?;
    }
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, text);
    script.analyze(&catalog, true).map_err(|e| e.message)?;
    // The catalog is dropped here, the analyzed script keeps its dependencies alive
    let _ = Arc::strong_count(script.analyzed.as_ref().unwrap());
    Ok(script)
}

fn first_difference(expected: &str, actual: &str) -> String {
    let lines: Vec<&str> = expected.lines().collect();
    for (i, (e, a)) in expected.lines().zip(actual.lines()).enumerate() {
        if e != a {
            let context = lines[i.saturating_sub(8)..i].join("\n");
            let after_e = lines[i..(i + 12).min(lines.len())].join("\n");
            let actual_lines: Vec<&str> = actual.lines().collect();
            let after_a = actual_lines[i..(i + 12).min(actual_lines.len())].join("\n");
            return format!("line {i}:\n{context}\n  C++:\n{after_e}\n  Rust:\n{after_a}");
        }
    }
    format!("length differs: {} vs {} lines", expected.lines().count(), actual.lines().count())
}

fn compare_with_oracle(catalog: Option<&str>, text: &str) -> Result<(), String> {
    let context = || format!("catalog {catalog:?}\nscript {text:?}");
    let script = match analyze(catalog, text) {
        Ok(s) => s,
        Err(_) => {
            return match pack(catalog, text, Packed::ScannedScript) {
                Err(_) => Ok(()),
                Ok(_) => Err(format!("{}\nC++ analyzes, Rust fails", context())),
            }
        }
    };
    for what in [Packed::ScannedScript, Packed::ParsedScript, Packed::AnalyzedScript] {
        let bytes = pack(catalog, text, what).map_err(|e| format!("{}\nC++ fails: {e}", context()))?;
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let (expected, actual) = match what {
            Packed::ScannedScript => {
                let expected = flatbuffers::root::<dashql_buffers::parser::ScannedScript>(&bytes).unwrap().unpack();
                let packed = pack_scanned_script(script.scanned.as_ref().unwrap()).pack(&mut builder);
                builder.finish(packed, None);
                let actual: ScannedScriptT = flatbuffers::root::<dashql_buffers::parser::ScannedScript>(builder.finished_data()).unwrap().unpack();
                (format!("{expected:#?}"), format!("{actual:#?}"))
            }
            Packed::ParsedScript => {
                let expected = flatbuffers::root::<dashql_buffers::parser::ParsedScript>(&bytes).unwrap().unpack();
                let packed = pack_parsed_script(script.parsed.as_ref().unwrap()).pack(&mut builder);
                builder.finish(packed, None);
                let actual: ParsedScriptT = flatbuffers::root::<dashql_buffers::parser::ParsedScript>(builder.finished_data()).unwrap().unpack();
                (format!("{expected:#?}"), format!("{actual:#?}"))
            }
            Packed::AnalyzedScript => {
                let mut expected = flatbuffers::root::<dashql_buffers::analyzer::AnalyzedScript>(&bytes).unwrap().unpack();
                let packed = pack_analyzed_script(script.analyzed.as_ref().unwrap(), &pack_visualization).pack(&mut builder);
                builder.finish(packed, None);
                let mut actual: AnalyzedScriptT =
                    flatbuffers::root::<dashql_buffers::analyzer::AnalyzedScript>(builder.finished_data()).unwrap().unpack();
                (format!("{expected:#?}"), format!("{actual:#?}"))
            }
        };
        if expected != actual {
            return Err(format!("{}\n{what:?}: {}", context(), first_difference(&expected, &actual)));
        }
    }
    Ok(())
}

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();
    let mut catalogs: Vec<String> = Vec::new();
    for category in ["analyzer", "completion"] {
        for case in load_category(category).expect("cannot load snapshots") {
            if let Some(c) = case.node["catalog"]["script"]["input"].as_str().map(trim_input) {
                if !catalogs.contains(&c) {
                    catalogs.push(c);
                }
            }
        }
    }
    for category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            let catalogs = catalogs.clone();
            trials.push(Trial::test(format!("{category}::{file}"), move || {
                let mut rng = Rng::new(inputs.len() as u64 + 3);
                for input in &inputs {
                    compare_with_oracle(None, input).map_err(Failed::from)?;
                    let catalog = rng.pick(&catalogs);
                    compare_with_oracle(Some(catalog), input).map_err(Failed::from)?;
                    for prefix in prefixes(input, 6) {
                        compare_with_oracle(Some(catalog), prefix).map_err(Failed::from)?;
                    }
                }
                Ok(())
            }));
        }
    }
    run(&args, trials).exit();
}
