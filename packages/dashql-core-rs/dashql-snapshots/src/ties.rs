//! Tie-insensitive comparison of ranked and sorted outputs.
//!
//! The C++ core sorts with the unstable `std::sort`, so elements that compare equal come out in an order that is an
//! artifact of libstdc++'s introsort. The Rust core breaks such ties explicitly. Differential tests bring both sides
//! into one canonical order before comparing them, so that they compare the ranking but not the order of ties.

use dashql_buffers::analyzer::AnalyzedScriptT;
use dashql_buffers::completion::CompletionT;
use dashql_buffers::editor::EditorUpdateT;
use std::cmp::Reverse;
use yaml_rust2::Yaml;

/// Order the candidates by score and name, and their catalog objects by score and id
pub fn completion(completion: &mut CompletionT) {
    let Some(candidates) = completion.candidates.as_mut() else {
        return;
    };
    for candidate in candidates.iter_mut() {
        if let Some(objects) = candidate.catalog_objects.as_mut() {
            objects.sort_by_cached_key(|o| (Reverse(o.score), format!("{o:?}")));
        }
    }
    candidates.sort_by_cached_key(|c| (Reverse(c.score), c.completion_text.clone(), format!("{c:?}")));
}

/// [`completion`] for the snapshot encoding: `entries` with `score`, `value` and `objects`
pub fn completion_yaml(completion: &mut Yaml) {
    fn sort(nodes: &mut [Yaml], value_key: &str) {
        nodes.sort_by_cached_key(|n| {
            (
                Reverse(n["score"].as_i64().unwrap_or(0)),
                n[value_key].as_str().unwrap_or("").to_string(),
                format!("{n:?}"),
            )
        });
    }
    fn array<'a>(node: &'a mut Yaml, key: &str) -> Option<&'a mut Vec<Yaml>> {
        match node {
            Yaml::Hash(map) => match map.get_mut(&Yaml::String(key.into())) {
                Some(Yaml::Array(nodes)) => Some(nodes),
                _ => None,
            },
            _ => None,
        }
    }
    let Some(entries) = array(completion, "entries") else {
        return;
    };
    for entry in entries.iter_mut() {
        if let Some(objects) = array(entry, "objects") {
            sort(objects, "id");
        }
    }
    sort(entries, "value");
}

/// Order the resolved table and column references by their complete key
pub fn analyzed_script(script: &mut AnalyzedScriptT) {
    if let Some(refs) = script.resolved_table_references_by_id.as_mut() {
        refs.sort_by_key(|r| (r.catalog_database_id, r.catalog_schema_id, r.catalog_table_id, r.table_reference_id));
    }
    if let Some(refs) = script.resolved_column_references_by_id.as_mut() {
        refs.sort_by_key(|r| {
            (r.catalog_database_id, r.catalog_schema_id, r.catalog_table_id, r.table_column_id, r.expression_id)
        });
    }
}

/// Order the table definitions of the script annotations by name and statement
pub fn editor_update(update: &mut EditorUpdateT) {
    if let Some(definitions) = update.script_annotations.as_mut().and_then(|a| a.table_definitions.as_mut()) {
        definitions.sort_by(|l, r| (&l.name, l.statement_id).cmp(&(&r.name, r.statement_id)));
    }
}
