//! The Rust analyzer must produce exactly the output of the C++ analyzer.
//!
//! Compares the complete analyzer snapshot encoding (errors, tables, table refs, inserts,
//! expressions, constants, visualizations, inferred tables) of the catalog and the main script on:
//!   - every analyzer snapshot case and prefixes of its main script,
//!   - every snapshot input of every category, alone and against catalog scripts of the analyzer
//!     snapshots, and prefixes of these inputs,
//!   - deterministic fuzz inputs of SQL fragments against a fuzzed catalog.

use dashql_snapshots::corpus::{prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::encode::analyzer::analyze_case;
use dashql_snapshots::{compare, load_category, parse_yaml, run, trim_input, Arguments, Failed, Trial};

/// Compare the Rust and the C++ analysis of a script
fn compare_with_oracle(catalog: Option<&str>, text: &str) -> Result<(), String> {
    let context = || format!("catalog {catalog:?}\nscript {text:?}");
    let expected = dashql_oracle::analyzer::analyze(catalog, text);
    let actual = analyze_case(catalog, text);
    let (expected, (catalog_yaml, script_yaml)) = match (expected, actual) {
        (Ok(e), Ok(a)) => (e, a),
        (Err(e), Err(a)) => {
            // Both fail, e.g. on a function name the C++ analyzer cannot read
            let _ = (e, a);
            return Ok(());
        }
        (e, a) => return Err(format!("{}\nC++: {:?}\nRust: {:?}", context(), e.err(), a.err())),
    };
    let expected = parse_yaml(&expected).map_err(|e| format!("{}\n{e}", context()))?;
    if let Some(catalog_yaml) = catalog_yaml {
        compare(&expected["catalog"], &catalog_yaml).map_err(|e| format!("{}\ncatalog: {e}", context()))?;
    }
    compare(&expected["script"], &script_yaml).map_err(|e| format!("{}\nscript: {e}", context()))
}

/// SQL fragments for catalogs
const CATALOG_FRAGMENTS: &[&str] = &[
    "create table a (x int, y int);",
    "create table b (x int, z text);",
    "create table s.c (y int, w int);",
    "create table db.s.d (x int);",
    "create table e (\"X\" int, x int, y int);",
    "create view v as select x, y from a;",
    "create table f as select z from b;",
    "create view w (p, q) as select * from a;",
    "create function fn(a int) returns int as 'select 1';",
    "create table a (q int);",
];

/// SQL fragments for scripts
const SCRIPT_FRAGMENTS: &[&str] = &[
    "select x from a",
    "select * from a, b",
    "select a.x, b.z from a join b on a.x = b.x",
    "select x from a where y = 1 and z > 2",
    "select * from s.c",
    "select * from db.s.d",
    "select * from unknown u where u.k = 1",
    "select k, l from t1, t2 where t1.m = 1",
    "with q as (select x from a) select x from q",
    "with recursive r (n) as (select 1 union all select n + 1 from r) select n from r",
    "select (select max(x) from b where b.x = a.x) from a",
    "insert into a (x, y) select x, y from b",
    "insert into unknown values (1, 2)",
    "delete from a where x in (select x from b)",
    "create table g (m int, n int)",
    "select m from g",
    "select p.x from a p, a p",
    "select x + 1, 'abc', interval '1 day', 1.5, null from a",
    "select count(*), sum(x), fn(1), s.fn(x) from a group by y",
    "select r.f.g from a r",
    "visualize select x, y from a using vegalite (mark bar, encoding (x x, y (field y, type quantitative)))",
    "select x from v",
    "select p, q from w",
    "select * from (select x from a) sub",
    "select x from a union select z from b",
    ";",
    "select 1 + 2 * 3 = 7",
    "select x from a order by x limit 10",
];

/// Join random statements
fn statements(rng: &mut Rng, fragments: &[&str], max_count: usize) -> String {
    let n = 1 + rng.below(max_count);
    (0..n).map(|_| *rng.pick(fragments)).collect::<Vec<_>>().join(";\n")
}

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();

    // The analyzer snapshot cases and the catalogs they use
    let mut catalogs: Vec<String> = Vec::new();
    for case in load_category("analyzer").expect("cannot load analyzer snapshots") {
        let main = case.node["script"]["input"].as_str().map(trim_input).unwrap_or_default();
        let catalog = case.node["catalog"]["script"]["input"].as_str().map(trim_input);
        if let Some(c) = &catalog {
            if !catalogs.contains(c) {
                catalogs.push(c.clone());
            }
        }
        trials.push(Trial::test(format!("snapshot::{}", case.trial_name()), move || {
            compare_with_oracle(catalog.as_deref(), &main).map_err(Failed::from)?;
            for prefix in prefixes(&main, 24) {
                compare_with_oracle(catalog.as_deref(), prefix).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    // All snapshot inputs, alone and against the snapshot catalogs
    for category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            let catalogs = catalogs.clone();
            trials.push(Trial::test(format!("inputs::{category}::{file}"), move || {
                let mut rng = Rng::new(inputs.len() as u64 + 1);
                for input in &inputs {
                    compare_with_oracle(None, input).map_err(Failed::from)?;
                    let catalog = rng.pick(&catalogs);
                    compare_with_oracle(Some(catalog), input).map_err(Failed::from)?;
                    for prefix in prefixes(input, 8) {
                        compare_with_oracle(Some(catalog), prefix).map_err(Failed::from)?;
                    }
                }
                Ok(())
            }));
        }
    }

    // Fuzzed scripts against fuzzed catalogs
    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::{batch}"), move || {
            let mut rng = Rng::new(0xA11CE + batch);
            for _ in 0..200 {
                let catalog = statements(&mut rng, CATALOG_FRAGMENTS, 4);
                let script = statements(&mut rng, SCRIPT_FRAGMENTS, 4);
                let catalog = (rng.below(4) != 0).then_some(catalog.as_str());
                compare_with_oracle(catalog, &script).map_err(Failed::from)?;
            }
            Ok(())
        }));
    }

    run(&args, trials).exit();
}
