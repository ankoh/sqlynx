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

/// Rewrite every decimal or exponent number literal of a text in one canonical form.
///
/// The Rust core writes doubles with the shortest round-trip digits, the C++ core with rapidjson's Grisu2 and its
/// own notation (`12345678901234568000.0` vs `1.2345678901234567e+19`). Differential tests compare texts that embed
/// such numbers after canonicalizing both sides, so they compare the values. Integers and digits that are part of
/// identifiers or hex literals stay as they are.
pub fn canonical_numbers(text: &str) -> String {
    let bytes = text.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'.';
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() || (i > 0 && is_word(bytes[i - 1])) {
            i += 1;
            continue;
        }
        // An optional sign belongs to the number
        let begin = if i > 0 && bytes[i - 1] == b'-' { i - 1 } else { i };
        let mut end = i;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let mut is_double = false;
        if end + 1 < bytes.len() && bytes[end] == b'.' && bytes[end + 1].is_ascii_digit() {
            is_double = true;
            end += 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
        }
        if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
            let mut exp = end + 1;
            if exp < bytes.len() && (bytes[exp] == b'+' || bytes[exp] == b'-') {
                exp += 1;
            }
            if exp < bytes.len() && bytes[exp].is_ascii_digit() {
                is_double = true;
                end = exp;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
            }
        }
        let followed_by_word = end < bytes.len() && is_word(bytes[end]);
        if is_double && !followed_by_word {
            if let Ok(value) = text[begin..end].parse::<f64>() {
                out.push_str(&text[copied..begin]);
                out.push_str(&format!("{value:e}"));
                copied = end;
            }
        }
        i = end.max(i + 1);
    }
    out.push_str(&text[copied..]);
    out
}

/// Does a JSON text have an object with the same key twice?
///
/// JSON leaves the meaning of duplicate keys open: the C++ core (rapidjson) keeps all members and looks up the
/// first one, the Rust core (serde_json) keeps the last value. Differential tests skip such inputs. Keys are
/// compared as written, the text should be valid JSON.
pub fn has_duplicate_keys(json: &[u8]) -> bool {
    // The keys of the enclosing containers, `None` for arrays
    let mut containers: Vec<Option<Vec<&[u8]>>> = Vec::new();
    let mut expect_key = false;
    let mut i = 0;
    while i < json.len() {
        match json[i] {
            b'{' => {
                containers.push(Some(Vec::new()));
                expect_key = true;
            }
            b'[' => containers.push(None),
            b'}' | b']' => {
                containers.pop();
            }
            b',' => expect_key = matches!(containers.last(), Some(Some(_))),
            b'"' => {
                let begin = i + 1;
                i += 1;
                while i < json.len() && json[i] != b'"' {
                    i += if json[i] == b'\\' { 2 } else { 1 };
                }
                if let (true, Some(Some(keys))) = (expect_key, containers.last_mut()) {
                    let key = &json[begin..i.min(json.len())];
                    if keys.contains(&key) {
                        return true;
                    }
                    keys.push(key);
                }
                expect_key = false;
            }
            _ => {}
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{canonical_numbers, has_duplicate_keys};

    #[test]
    fn finds_duplicate_keys() {
        assert!(has_duplicate_keys(br#"{"a":1,"b":{"a":2},"a":3}"#));
        assert!(has_duplicate_keys(br#"[{"x":[1,{"k\"":1,"k\"":2}]}]"#));
        assert!(!has_duplicate_keys(br#"{"a":"a","b":{"a":["a","a"]},"c":{"a":1}}"#));
        assert!(!has_duplicate_keys(br#"[{"a":1},{"a":2}]"#));
    }

    #[test]
    fn canonicalizes_doubles() {
        assert_eq!(
            canonical_numbers("string 9: 12345678901234568000.0"),
            canonical_numbers("string 9: 1.2345678901234567e+19")
        );
        assert_eq!(canonical_numbers("[0.5,-1e-7]"), "[5e-1,-1e-7]");
        assert_eq!(canonical_numbers("{\"a\":1e21}"), canonical_numbers("{\"a\":1000000000000000000000.0}"));
        // Integers, identifiers and hex literals stay
        assert_eq!(canonical_numbers("id 42 x1.5 0x3e5 v2 a_1e5"), "id 42 x1.5 0x3e5 v2 a_1e5");
    }
}
