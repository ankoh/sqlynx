//! The script compiler must produce exactly the ScriptCompilationResult of the C++ core, on all
//! snapshot inputs and their prefixes, with and without catalog scripts, prior analysis and
//! extensions.

use dashql_buffers::execution::{ScriptCompilationResult, ScriptCompilationResultT};
use dashql_buffers::formatting::FormattingConfigT;
use dashql_core::catalog::Catalog;
use dashql_core::compiler::{compile, CompilationOptions};
use dashql_core::script::Script;
use dashql_snapshots::corpus::{prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::{load_category, run, trim_input, Arguments, Failed, Trial};

fn compile_rust(catalog_text: Option<&str>, text: &str, analyze: bool, allow_extensions: bool) -> Result<ScriptCompilationResultT, String> {
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
    if analyze {
        script.analyze(&catalog, true).map_err(|e| e.message)?;
    }
    let options = CompilationOptions {
        allow_extensions,
        ..Default::default()
    };
    let result = compile(&mut script, &catalog, &FormattingConfigT::default(), options);
    // Round trip through a FlatBuffer, so that field presence is compared
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = result.pack(&mut builder);
    builder.finish(packed, None);
    Ok(flatbuffers::root::<ScriptCompilationResult>(builder.finished_data()).unwrap().unpack())
}

fn compare_with_oracle(catalog: Option<&str>, text: &str, analyze: bool, allow_extensions: bool) -> Result<(), String> {
    let context = || format!("catalog {catalog:?}\nscript {text:?}\nanalyze {analyze} extensions {allow_extensions}");
    let expected = dashql_oracle::compiler::compile(catalog, text, analyze, allow_extensions);
    let actual = compile_rust(catalog, text, analyze, allow_extensions);
    match (expected, actual) {
        (Ok(bytes), Ok(actual)) => {
            let expected = flatbuffers::root::<ScriptCompilationResult>(&bytes).unwrap().unpack();
            let (e, a) = (format!("{expected:#?}"), format!("{actual:#?}"));
            if e != a {
                let line = e.lines().zip(a.lines()).position(|(x, y)| x != y).unwrap_or(0);
                let show = |s: &str| s.lines().skip(line.saturating_sub(6)).take(12).collect::<Vec<_>>().join("\n");
                return Err(format!("{}\nC++:\n{}\nRust:\n{}", context(), show(&e), show(&a)));
            }
            Ok(())
        }
        (Err(_), Err(_)) => Ok(()),
        (e, a) => Err(format!("{}\nC++: {:?}\nRust: {:?}", context(), e.err(), a.err())),
    }
}

fn main() {
    let args = Arguments::from_args();
    let mut catalogs: Vec<String> = Vec::new();
    for category in ["analyzer", "completion", "visualize"] {
        for case in load_category(category).expect("cannot load snapshots") {
            if let Some(c) = case.node["catalog"]["script"]["input"].as_str().map(trim_input) {
                if !catalogs.contains(&c) {
                    catalogs.push(c);
                }
            }
        }
    }
    let mut trials = Vec::new();
    for category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            let catalogs = catalogs.clone();
            trials.push(Trial::test(format!("{category}::{file}"), move || {
                let mut rng = Rng::new(inputs.len() as u64 + 11);
                for input in &inputs {
                    let catalog = (!catalogs.is_empty() && rng.below(2) == 0).then(|| rng.pick(&catalogs).as_str());
                    for (analyze, extensions) in [(false, true), (true, true), (true, false)] {
                        compare_with_oracle(catalog, input, analyze, extensions).map_err(Failed::from)?;
                    }
                    for prefix in prefixes(input, 6) {
                        compare_with_oracle(catalog, prefix, rng.below(2) == 0, true).map_err(Failed::from)?;
                    }
                }
                Ok(())
            }));
        }
    }
    run(&args, trials).exit();
}
