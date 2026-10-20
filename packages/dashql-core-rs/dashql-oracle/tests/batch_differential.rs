//! Batch processing must produce exactly the BatchResult of the C++ core. Catalog scripts of the
//! snapshots are processed into descriptors first, then the snapshot inputs are processed against
//! them. The nested FlatBuffers are unpacked into the object API and compared.

use dashql_buffers::analyzer::AnalyzedScript;
use dashql_buffers::batch::{BatchRequestT, BatchResult, BatchScriptInputT, DescriptorBufferT};
use dashql_buffers::catalog::CatalogDescriptor;
use dashql_buffers::parser::{ParsedScript, ScannedScript};
use dashql_snapshots::corpus::{snapshot_inputs, CATEGORIES};
use dashql_snapshots::{load_category, run, trim_input, Arguments, Failed, Trial};

fn request(descriptors: &[Vec<u8>], scripts: &[(String, String, u32)]) -> Vec<u8> {
    let mut r = BatchRequestT::default();
    r.catalog_descriptors = Some(
        descriptors
            .iter()
            .map(|d| {
                let mut b = DescriptorBufferT::default();
                b.data = Some(d.clone());
                b
            })
            .collect(),
    );
    r.scripts = Some(
        scripts
            .iter()
            .map(|(id, text, outputs)| {
                let mut s = BatchScriptInputT::default();
                s.id = Some(id.clone());
                s.text = Some(text.clone());
                s.outputs = *outputs;
                s
            })
            .collect(),
    );
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = r.pack(&mut builder);
    builder.finish(packed, None);
    builder.finished_data().to_vec()
}

/// A comparable dump of a batch result with the nested buffers unpacked
fn dump(bytes: &[u8]) -> String {
    let result = flatbuffers::root::<BatchResult>(bytes).expect("BatchResult").unpack();
    let mut out = String::new();
    for script in result.scripts.iter().flatten() {
        out += &format!("id {:?} failure {:?}\n", script.id, script.failure);
        out += &format!("diagnostics {:#?}\n", script.diagnostics);
        if let Some(b) = &script.scanned {
            out += &format!("scanned {:#?}\n", flatbuffers::root::<ScannedScript>(b).unwrap().unpack());
        }
        if let Some(b) = &script.parsed {
            out += &format!("parsed {:#?}\n", flatbuffers::root::<ParsedScript>(b).unwrap().unpack());
        }
        if let Some(b) = &script.analyzed {
            out += &format!("analyzed {:#?}\n", flatbuffers::root::<AnalyzedScript>(b).unwrap().unpack());
        }
        if let Some(b) = &script.catalog_descriptor {
            out += &format!("descriptor {:#?}\n", flatbuffers::root::<CatalogDescriptor>(b).unwrap().unpack());
        }
    }
    out
}

/// The descriptors of a batch result
fn descriptors(bytes: &[u8]) -> Vec<Vec<u8>> {
    let result = flatbuffers::root::<BatchResult>(bytes).expect("BatchResult").unpack();
    result.scripts.iter().flatten().filter_map(|s| s.catalog_descriptor.clone()).collect()
}

fn compare(request: &[u8]) -> Result<Vec<u8>, String> {
    let expected = dashql_oracle::batch::process_batch(request);
    let actual = dashql_core::batch::process_batch(request).map_err(|e| e.message);
    match (expected, actual) {
        (Ok(e), Ok(a)) => {
            let (de, da) = (dump(&e), dump(&a));
            if de != da {
                let line = de.lines().zip(da.lines()).position(|(x, y)| x != y).unwrap_or(0);
                let show = |s: &str| s.lines().skip(line.saturating_sub(8)).take(14).collect::<Vec<_>>().join("\n");
                return Err(format!("C++:\n{}\nRust:\n{}", show(&de), show(&da)));
            }
            Ok(e)
        }
        (Err(e), Err(a)) if e == a => Ok(Vec::new()),
        (e, a) => Err(format!("C++: {:?}\nRust: {:?}", e.err(), a.err())),
    }
}

fn main() {
    let args = Arguments::from_args();
    // Catalog scripts become descriptors
    let mut catalog_scripts = Vec::new();
    for category in ["analyzer", "completion"] {
        for case in load_category(category).expect("cannot load snapshots") {
            if let Some(c) = case.node["catalog"]["script"]["input"].as_str().map(trim_input) {
                if !catalog_scripts.contains(&c) {
                    catalog_scripts.push(c);
                }
            }
        }
    }
    let mut trials = Vec::new();
    for category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            let catalog_scripts = catalog_scripts.clone();
            trials.push(Trial::test(format!("{category}::{file}"), move || {
                let seed = file.len() % catalog_scripts.len();
                let catalogs: Vec<(String, String, u32)> = catalog_scripts
                    .iter()
                    .cycle()
                    .skip(seed)
                    .take(2)
                    .enumerate()
                    .map(|(i, c)| (format!("catalog{i}"), c.clone(), 15))
                    .collect();
                let first = compare(&request(&[], &catalogs)).map_err(|e| Failed::from(format!("catalog batch\n{e}")))?;
                let descriptors = if first.is_empty() { Vec::new() } else { descriptors(&first) };
                let scripts: Vec<(String, String, u32)> =
                    inputs.iter().enumerate().map(|(i, text)| (format!("{file}{i}"), text.clone(), (i % 16) as u32 | 1)).collect();
                compare(&request(&descriptors, &scripts)).map_err(Failed::from)?;
                Ok(())
            }));
        }
    }
    run(&args, trials).exit();
}
