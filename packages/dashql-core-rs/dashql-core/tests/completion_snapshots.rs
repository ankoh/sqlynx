//! The completion snapshots (snapshots/completion/*.yaml): the analysis of the catalog and editor
//! scripts on the keys of the analyzer snapshots, and the complete completion encoding.

use dashql_snapshots::encode::analyzer::compare_script;
use dashql_snapshots::encode::completion::{complete_case, CursorOffset};
use dashql_snapshots::{compare, load_category, run, trim_input, Arguments, Failed, Trial};

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();
    for case in load_category("completion").expect("cannot load completion snapshots") {
        trials.push(Trial::test(case.trial_name(), move || {
            let node = &case.node;
            let catalog = &node["catalog"]["script"];
            let editor = &node["editor"];
            let catalog_input = catalog["input"].as_str().map(trim_input);
            let editor_input = editor["input"].as_str().map(trim_input).unwrap_or_default();
            let search = &node["cursor"]["search"];
            let text = search["text"].as_str().unwrap_or("");
            let index = search["index"].as_i64().unwrap_or(0) as usize;
            let limit = node["completions"]["limit"].as_i64().unwrap_or(100) as usize;
            let out = complete_case(catalog_input.as_deref(), &editor_input, CursorOffset::Search { text, index }, limit)
                .map_err(Failed::from)?;
            if let Some(catalog_yaml) = out.catalog {
                compare_script(catalog, &catalog_yaml).map_err(|e| Failed::from(format!("catalog: {e}")))?;
            }
            compare_script(editor, &out.editor).map_err(|e| Failed::from(format!("editor: {e}")))?;
            compare(&node["completions"], &out.completions).map_err(|e| Failed::from(format!("completions: {e}")))
        }));
    }
    run(&args, trials).exit();
}
