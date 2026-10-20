//! The shared YAML snapshot tests (`//snapshots/<category>/*.yaml`) for the Rust core.
//!
//! The C++ and the Rust core run against the very same snapshot files. This crate loads them,
//! turns every case into a libtest-mimic trial, and compares produced YAML structurally against
//! the `expected` node of a case.

pub mod corpus;
pub mod encode;
pub mod formatter;
pub mod ryml;

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

pub use libtest_mimic::{run, Arguments, Failed, Trial};
pub use yaml_rust2::{Yaml, YamlLoader};

/// One entry of a `<category>-snapshots` list.
#[derive(Clone, Debug)]
pub struct SnapshotCase {
    /// The snapshot category (e.g. `parser`)
    pub category: String,
    /// The file stem (e.g. `sql_select`)
    pub file: String,
    /// The case name
    pub name: String,
    /// The YAML node of the case
    pub node: Yaml,
}

impl SnapshotCase {
    /// The test name, unique within a category
    pub fn trial_name(&self) -> String {
        format!("{}::{}::{}", self.category, self.file, self.name)
    }

    /// The input script, trimmed like the C++ snapshot tests do (leading spaces and newlines,
    /// trailing newlines).
    pub fn input(&self) -> Option<String> {
        self.node["input"].as_str().map(trim_input)
    }

    /// The expected output, `None` for template-only entries
    pub fn expected(&self) -> Option<&Yaml> {
        match &self.node["expected"] {
            Yaml::BadValue => None,
            expected => Some(expected),
        }
    }
}

/// Trim an input the same way the C++ snapshot tests do.
pub fn trim_input(input: &str) -> String {
    input.trim_start_matches([' ', '\n']).trim_end_matches(['\n', '\r']).to_string()
}

/// The directory holding the snapshot categories.
///
/// Tests find `snapshots/` in their runfiles. `DASHQL_SNAPSHOT_ROOT` overrides the location,
/// e.g. for `bazel run` against the source tree.
pub fn snapshot_root() -> PathBuf {
    match std::env::var_os("DASHQL_SNAPSHOT_ROOT") {
        Some(root) => PathBuf::from(root),
        None => PathBuf::from("snapshots"),
    }
}

/// Load all cases of a category, ordered by file name. Template files (`*.tpl.yaml`) are skipped.
pub fn load_category(category: &str) -> Result<Vec<SnapshotCase>, String> {
    load_category_from(&snapshot_root().join(category), category)
}

/// Load all cases of a category from a directory.
pub fn load_category_from(dir: &Path, category: &str) -> Result<Vec<SnapshotCase>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("cannot list {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            name.ends_with(".yaml") && !name.ends_with(".tpl.yaml")
        })
        .collect();
    files.sort();

    let key = format!("{category}-snapshots");
    let mut cases = Vec::new();
    for path in files {
        let text = fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let docs = YamlLoader::load_from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let file = path.file_stem().unwrap().to_string_lossy().to_string();
        let Some(entries) = docs.first().and_then(|doc| doc[key.as_str()].as_vec()) else {
            return Err(format!("{}: missing key {key}", path.display()));
        };
        for entry in entries {
            let name = entry["name"].as_str().ok_or_else(|| format!("{}: case without name", path.display()))?;
            cases.push(SnapshotCase {
                category: category.to_string(),
                file: file.clone(),
                name: name.to_string(),
                node: entry.clone(),
            });
        }
    }
    Ok(cases)
}

/// Parse a YAML document produced by an encoder.
pub fn parse_yaml(text: &str) -> Result<Yaml, String> {
    let mut docs = YamlLoader::load_from_str(text).map_err(|e| format!("invalid YAML: {e}"))?;
    match docs.len() {
        1 => Ok(docs.remove(0)),
        n => Err(format!("expected one YAML document, found {n}")),
    }
}

/// Compare two YAML trees and describe the first difference.
///
/// Mappings must have the same keys in the same order: the snapshot files are emitted in encoder
/// order, and the Rust encoders must reproduce them byte for byte eventually.
pub fn compare(expected: &Yaml, actual: &Yaml) -> Result<(), String> {
    let mut path = String::new();
    compare_at(&mut path, expected, actual)
}

fn compare_at(path: &mut String, expected: &Yaml, actual: &Yaml) -> Result<(), String> {
    match (expected, actual) {
        (Yaml::Hash(e), Yaml::Hash(a)) => {
            let e_keys: Vec<&Yaml> = e.keys().collect();
            let a_keys: Vec<&Yaml> = a.keys().collect();
            if e_keys != a_keys {
                return Err(format!(
                    "{}: keys differ\n  expected: {}\n  actual:   {}",
                    location(path),
                    describe_keys(&e_keys),
                    describe_keys(&a_keys)
                ));
            }
            for (key, e_value) in e {
                let len = path.len();
                let _ = write!(path, ".{}", describe_key(key));
                compare_at(path, e_value, &a[key])?;
                path.truncate(len);
            }
            Ok(())
        }
        (Yaml::Array(e), Yaml::Array(a)) => {
            for (i, (e_value, a_value)) in e.iter().zip(a).enumerate() {
                let len = path.len();
                let _ = write!(path, "[{i}]");
                compare_at(path, e_value, a_value)?;
                path.truncate(len);
            }
            if e.len() != a.len() {
                return Err(format!("{}: expected {} entries, got {}", location(path), e.len(), a.len()));
            }
            Ok(())
        }
        (e, a) if e == a => Ok(()),
        (e, a) => Err(format!("{}: expected {}, got {}", location(path), describe(e), describe(a))),
    }
}

fn location(path: &str) -> &str {
    if path.is_empty() {
        "<root>"
    } else {
        path
    }
}

fn describe_key(key: &Yaml) -> String {
    match key {
        Yaml::String(s) => s.clone(),
        other => describe(other),
    }
}

fn describe_keys(keys: &[&Yaml]) -> String {
    keys.iter().map(|k| describe_key(k)).collect::<Vec<_>>().join(", ")
}

fn describe(value: &Yaml) -> String {
    match value {
        Yaml::String(s) => format!("{s:?}"),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Real(r) => r.clone(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Null => "null".to_string(),
        Yaml::Array(a) => format!("<list of {}>", a.len()),
        Yaml::Hash(h) => format!("<map of {}>", h.len()),
        Yaml::Alias(a) => format!("<alias {a}>"),
        Yaml::BadValue => "<missing>".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yaml(text: &str) -> Yaml {
        parse_yaml(text).unwrap()
    }

    #[test]
    fn trims_like_cxx() {
        assert_eq!(trim_input("\n  select 1\n\r\n"), "select 1");
        assert_eq!(trim_input("select 1  "), "select 1  ");
        assert_eq!(trim_input("\tselect 1"), "\tselect 1");
    }

    #[test]
    fn compares_structurally() {
        assert!(compare(&yaml("a: 1\nb: [x, y]"), &yaml("a: 1\nb: [x, y]")).is_ok());
        assert_eq!(compare(&yaml("a: 1"), &yaml("a: 2")), Err(".a: expected 1, got 2".to_string()));
        assert_eq!(
            compare(&yaml("a: {b: [1, 2]}"), &yaml("a: {b: [1, 3]}")),
            Err(".a.b[1]: expected 2, got 3".to_string())
        );
        assert_eq!(compare(&yaml("a: [1, 2]"), &yaml("a: [1]")), Err(".a: expected 2 entries, got 1".to_string()));
        assert!(compare(&yaml("a: 1\nb: 2"), &yaml("b: 2\na: 1")).unwrap_err().contains("keys differ"));
    }

    #[test]
    fn loads_categories() {
        let dir = std::env::temp_dir().join(format!("dashql-snapshots-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("a.yaml"),
            "parser-snapshots:\n  - name: one\n    input: |-\n      select 1\n    expected: {statements: []}\n",
        )
        .unwrap();
        fs::write(dir.join("a.tpl.yaml"), "parser-snapshots:\n  - name: one\n    input: select 1\n").unwrap();
        let cases = load_category_from(&dir, "parser").unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(cases.len(), 1);
        assert_eq!(cases[0].trial_name(), "parser::a::one");
        assert_eq!(cases[0].input().as_deref(), Some("select 1"));
        assert!(cases[0].expected().is_some());
    }
}
