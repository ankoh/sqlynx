//! The analyzer snapshots (snapshots/analyzer/*.yaml), compared on the keys of the C++
//! `AnalyzerSnapshotTest`.

use dashql_snapshots::encode::analyzer::{analyze_case, compare_script};
use dashql_snapshots::{load_category, run, trim_input, Arguments, Failed, Trial};

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();
    for case in load_category("analyzer").expect("cannot load analyzer snapshots") {
        trials.push(Trial::test(case.trial_name(), move || {
            let main = &case.node["script"];
            let catalog = &case.node["catalog"]["script"];
            let main_input = main["input"].as_str().map(trim_input).unwrap_or_default();
            let catalog_input = catalog["input"].as_str().map(trim_input);
            let (catalog_yaml, main_yaml) = analyze_case(catalog_input.as_deref(), &main_input).map_err(Failed::from)?;
            if let Some(catalog_yaml) = catalog_yaml {
                compare_script(catalog, &catalog_yaml).map_err(|e| Failed::from(format!("catalog: {e}")))?;
            }
            compare_script(main, &main_yaml).map_err(|e| Failed::from(format!("script: {e}")))
        }));
    }
    run(&args, trials).exit();
}
