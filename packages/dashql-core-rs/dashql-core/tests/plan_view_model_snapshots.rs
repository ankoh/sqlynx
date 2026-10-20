//! The Hyper plan view model snapshots (snapshots/plans/hyper/tests/*.yaml), produced by the Rust view model.
//!
//! The encoder (`dashql_snapshots::encode::plan_view_model`) ports `PlanViewModelSnapshotTest::EncodePlanViewModel`.

use dashql_core::view::PlanViewModel;
use dashql_snapshots::encode::plan_view_model::{encode_plan_view_model, snapshot_config};
use dashql_snapshots::{compare, load_category_from, run, snapshot_root, Arguments, Failed, Trial, Yaml};

fn main() {
    let args = Arguments::from_args();
    let dir = snapshot_root().join("plans").join("hyper").join("tests");
    let cases = load_category_from(&dir, "plan").expect("cannot load plan snapshots");
    let trials = cases
        .into_iter()
        .map(|case| {
            Trial::test(case.trial_name(), move || {
                // The C++ suite passes the input untrimmed
                let input = case.node["input"].as_str().ok_or("case without input")?;
                let mut view_model = PlanViewModel::new();
                view_model.parse_hyper_plan(input.as_bytes()).map_err(|e| format!("cannot parse plan: {e:?}"))?;
                view_model.configure(&snapshot_config());
                view_model.compute_layout();
                let produced = encode_plan_view_model(&view_model.pack_buffer()).into_yaml();

                // Compare every section the snapshot has
                for key in ["fragments", "operators", "operator-edges", "pipelines"] {
                    let expected = &case.node[key];
                    if matches!(expected, Yaml::BadValue) {
                        continue;
                    }
                    compare(expected, &produced[key]).map_err(|e| Failed::from(format!("{key}: {e}")))?;
                }
                Ok(())
            })
        })
        .collect();
    run(&args, trials).exit();
}
