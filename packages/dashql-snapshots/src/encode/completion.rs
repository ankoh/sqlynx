//! A port of `CompletionSnapshotTest::EncodeCompletion` and the flow of
//! `test/completion_snapshot_test_suite.cc`.

use super::{encode_location_text, plain, Map};
use crate::encode::analyzer::encode_script;
use crate::ryml::Node;
use dashql_buffers::analyzer::NameTag;
use dashql_buffers::completion::CandidateTag;
use dashql_core::catalog::Catalog;
use dashql_core::completion::{CandidateObjectRef, Completion};
use dashql_core::cursor::{ScriptCursor, ScriptView};
use dashql_core::utils::quote_identifier;
use dashql_parser::parser::parse;
use dashql_parser::scanner::scan;
use std::sync::Arc;
use yaml_rust2::Yaml;

/// The names of the set bits of a tag bitset, in bit order (`EnumBitset::ForEach`)
fn tag_names(value: u32, bits: u32, name: impl Fn(u32) -> Option<&'static str>) -> Vec<Node> {
    (0..bits).map(|b| 1u32 << b).filter(|tag| value & tag != 0).map(|tag| plain(name(tag).unwrap_or(""))).collect()
}

fn insert_tags(map: &mut Map, key: &str, tags: Vec<Node>) {
    if !tags.is_empty() {
        map.insert(key, Node::flow_seq(tags));
    }
}

fn candidate_tag_names(value: u32) -> Vec<Node> {
    tag_names(value, 32, |t| CandidateTag(t).variant_name())
}

/// Encode a completion (`CompletionSnapshotTest::EncodeCompletion`), without the limit and text keys
pub fn encode_completion(out: &mut Map, completion: &Completion) {
    let cursor = completion.cursor;
    let text = &cursor.script.scanned.unwrap().text;
    out.plain("strategy", completion.strategy.variant_name().unwrap_or(""));
    if completion.dot_completion {
        out.int("dot", 1);
    }
    if let (Some(node_id), Some(parsed)) = (cursor.ast_node_id, cursor.script.parsed) {
        out.plain("symbol", parsed.nodes[node_id as usize].node_type().variant_name().unwrap_or(""));
        let relative = completion.target_symbol.map(|t| t.relative_pos.variant_name().unwrap_or("")).unwrap_or("");
        out.plain("relative", relative);
    }
    let entries = completion
        .top_candidates
        .iter()
        .map(|candidate| {
            let mut m = Map::new();
            m.int("score", candidate.score as i64);
            m.plain("value", &candidate.completion_text);
            if let Some(continuation) = candidate.keyword_continuation {
                m.plain("keyword-continuation", continuation);
            }
            insert_tags(
                &mut m,
                "name-tags",
                tag_names(candidate.coarse_name_tags as u32, 8, |t| NameTag(t as u8).variant_name()),
            );
            insert_tags(&mut m, "candidate-tags", candidate_tag_names(candidate.candidate_tags));
            let loc = candidate.target_location;
            encode_location_text(&mut m, text, loc.offset(), loc.length(), "location");
            let qualified = candidate.target_location_qualified;
            if qualified.offset() != 0 || qualified.length() != 0 {
                encode_location_text(&mut m, text, qualified.offset(), qualified.length(), "location-qualified");
            }
            let objects = candidate
                .catalog_objects
                .iter()
                .map(|&co| {
                    let object = &completion.candidate_objects[co];
                    let mut o = Map::new();
                    o.int("score", object.score as i64);
                    let (kind, id) = match object.object {
                        CandidateObjectRef::Database(id) => ("database", format!("{}", id.unpack_database_id())),
                        CandidateObjectRef::Schema(id) => {
                            let (db, schema) = id.unpack_schema_id();
                            ("schema", format!("{db}.{schema}"))
                        }
                        CandidateObjectRef::Table(loc) => {
                            let table = completion.table(loc).expect("table");
                            let (db, schema) = table.catalog_schema_id.unpack_schema_id();
                            ("table", format!("{db}.{schema}.{}", table.table_id().pack()))
                        }
                        CandidateObjectRef::Column(loc) => {
                            let table = completion.table(loc.table).expect("table");
                            let (db, schema) = table.catalog_schema_id.unpack_schema_id();
                            let (table_id, column) =
                                table.table_columns[loc.column as usize].object_id.unpack_table_column_id();
                            ("column", format!("{db}.{schema}.{}.{column}", table_id.pack()))
                        }
                        CandidateObjectRef::Function(loc) => {
                            let function = &completion.entry_data(loc.entry).expect("entry").function_declarations
                                [loc.index as usize];
                            let (db, schema) = function.catalog_schema_id.unpack_schema_id();
                            ("function", format!("{db}.{schema}.{}", function.function_id().pack()))
                        }
                    };
                    o.plain("type", kind);
                    o.quoted("id", &id);
                    insert_tags(&mut o, "candidate-tags", candidate_tag_names(object.candidate_tags));
                    if !object.qualified_name.is_empty() {
                        let name: Vec<String> = object.qualified_name.iter().map(|n| quote_identifier(n)).collect();
                        o.plain("qualified", &name.join("."));
                        o.int("qualified-idx", object.qualified_name_target_idx as i64);
                        o.int("prefer-qualified", object.prefer_qualified as i64);
                    }
                    o.into_node()
                })
                .collect();
            m.insert("objects", Node::seq(objects));
            m.into_node()
        })
        .collect();
    out.insert("entries", Node::seq(entries));
}

/// The output of a completion snapshot case
pub struct CompletionCase {
    /// The encoded catalog script, if the case has one
    pub catalog: Option<Yaml>,
    /// The encoded editor script
    pub editor: Yaml,
    /// The encoded completion at the cursor
    pub completions: Yaml,
}

/// Run a completion snapshot case: analyze the catalog script and the editor script like the
/// analyzer snapshots, place the cursor after the search text plus `index`, and complete.
pub fn complete_case(
    catalog_input: Option<&str>,
    editor_input: &str,
    cursor_offset: CursorOffset,
    limit: usize,
) -> Result<CompletionCase, String> {
    let mut catalog = Catalog::new();
    let mut catalog_yaml = None;
    if let Some(input) = catalog_input {
        let entry_id = catalog.allocate_entry_id();
        let parsed = Arc::new(parse(Arc::new(scan(input, 0, entry_id))));
        let analyzed = dashql_core::analyzer::analyze(parsed, &catalog).map_err(|e| e.message)?;
        catalog_yaml = Some(encode_script(&analyzed, false, None).to_yaml());
        let rank = analyzed.catalog_entry_id();
        catalog.load_script(Arc::new(analyzed), rank).map_err(|e| e.message)?;
    }
    let entry_id = catalog.allocate_entry_id();
    let scanned = Arc::new(scan(editor_input, 0, entry_id));
    let parsed = Arc::new(parse(scanned.clone()));
    let analyzed = Arc::new(dashql_core::analyzer::analyze(parsed.clone(), &catalog).map_err(|e| e.message)?);
    let editor_yaml = encode_script(&analyzed, true, None).to_yaml();

    let offset = match cursor_offset {
        CursorOffset::Search { text, index } => {
            let pos = editor_input.find(text).ok_or_else(|| format!("cursor search text {text:?} not found"))?;
            pos + index
        }
        CursorOffset::Offset(offset) => offset,
    };
    if offset > editor_input.len() {
        return Err("cursor out of bounds".into());
    }
    let view =
        ScriptView { scanned: Some(&scanned), parsed: Some(&parsed), analyzed: Some(&analyzed), catalog: &catalog };
    let cursor = ScriptCursor::place(view, offset);
    if cursor.scanner_location.is_none() {
        return Err("COMPLETION_MISSES_SCANNER_TOKEN".into());
    }
    let completion = Completion::compute(&cursor, limit);
    let mut out = Map::new();
    out.int("limit", limit as i64);
    // Completions inside comments have no target symbol, the C++ encoder cannot encode them
    if completion.target_symbol.is_none() {
        out.int("no-target", 1);
        return Ok(CompletionCase { catalog: catalog_yaml, editor: editor_yaml, completions: out.into_yaml() });
    }
    encode_completion(&mut out, &completion);
    if let Some(target) = completion.target_symbol {
        let loc = target.symbol.location;
        encode_location_text(&mut out, editor_input, loc.offset, loc.length, "text");
    }
    Ok(CompletionCase { catalog: catalog_yaml, editor: editor_yaml, completions: out.into_yaml() })
}

/// Where to place the cursor
#[derive(Clone, Copy, Debug)]
pub enum CursorOffset<'a> {
    /// After the first occurrence of a text, plus an index
    Search { text: &'a str, index: usize },
    /// At a byte offset
    Offset(usize),
}

/// Complete like [`complete_case`] and return the packed cursor and completion
pub fn complete_packed(
    catalog_input: Option<&str>,
    editor_input: &str,
    offset: usize,
    limit: usize,
    upper_case: bool,
) -> Result<(dashql_buffers::cursor::ScriptCursorT, dashql_buffers::completion::CompletionT), String> {
    let mut catalog = Catalog::new();
    if let Some(input) = catalog_input {
        let entry_id = catalog.allocate_entry_id();
        let parsed = Arc::new(parse(Arc::new(scan(input, 0, entry_id))));
        let analyzed = dashql_core::analyzer::analyze(parsed, &catalog).map_err(|e| e.message)?;
        let rank = analyzed.catalog_entry_id();
        catalog.load_script(Arc::new(analyzed), rank).map_err(|e| e.message)?;
    }
    let entry_id = catalog.allocate_entry_id();
    let scanned = Arc::new(scan(editor_input, 0, entry_id));
    let parsed = Arc::new(parse(scanned.clone()));
    let analyzed = Arc::new(dashql_core::analyzer::analyze(parsed.clone(), &catalog).map_err(|e| e.message)?);
    let view =
        ScriptView { scanned: Some(&scanned), parsed: Some(&parsed), analyzed: Some(&analyzed), catalog: &catalog };
    let cursor = ScriptCursor::place(view, offset);
    let packed_cursor = dashql_core::pack::pack_cursor(&cursor);
    let completion = Completion::compute(&cursor, limit);
    Ok((packed_cursor, dashql_core::pack::pack_completion(&completion, upper_case)))
}
