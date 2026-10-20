//! Inputs for differential tests: snapshot inputs, their prefixes, and deterministic fuzz inputs.

use crate::{load_category, Yaml};

/// All snapshot categories with scripts
pub const CATEGORIES: &[&str] = &["analyzer", "completion", "diff", "formatter", "parser", "planner", "visualize"];

/// Collect all `input` strings of a YAML tree.
pub fn collect_inputs(node: &Yaml, out: &mut Vec<String>) {
    match node {
        Yaml::Hash(hash) => {
            for (key, value) in hash {
                if key.as_str() == Some("input") {
                    if let Some(s) = value.as_str() {
                        out.push(s.to_string());
                    }
                }
                collect_inputs(value, out);
            }
        }
        Yaml::Array(items) => items.iter().for_each(|item| collect_inputs(item, out)),
        _ => {}
    }
}

/// The inputs of all snapshot files of a category, grouped by file
pub fn snapshot_inputs(category: &str) -> Vec<(String, Vec<String>)> {
    let cases = load_category(category).unwrap_or_else(|e| panic!("cannot load {category} snapshots: {e}"));
    let mut by_file: Vec<(String, Vec<String>)> = Vec::new();
    for case in cases {
        let mut inputs = Vec::new();
        collect_inputs(&case.node, &mut inputs);
        match by_file.last_mut() {
            Some((file, all)) if *file == case.file => all.extend(inputs),
            _ => by_file.push((case.file.clone(), inputs)),
        }
    }
    by_file
}

/// Prefixes of an input at char boundaries: all of them for short inputs, at most `max` otherwise.
pub fn prefixes(input: &str, max: usize) -> Vec<&str> {
    let boundaries: Vec<usize> = (0..input.len()).filter(|&i| input.is_char_boundary(i)).collect();
    let step = (boundaries.len() / max.max(1)).max(1);
    boundaries.iter().step_by(step).map(|&i| &input[..i]).collect()
}

/// A xorshift64* generator, deterministic across runs and platforms.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// A number in `0..n`
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// Pick an element
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// A random concatenation of fragments
pub fn fragments(rng: &mut Rng, fragments: &[&str], max_count: usize) -> String {
    let n = rng.below(max_count + 1);
    (0..n).map(|_| *rng.pick(fragments)).collect()
}
