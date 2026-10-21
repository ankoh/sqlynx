//! A port of `PlannerSnapshotTest::Encode` (`src/testing/planner_snapshot_test.cc`).

use super::{plain, Map};
use crate::ryml::Node;
use dashql_buffers::execution::{ExecutionGraphEntityType, ExecutionGraphT};
use dashql_core::catalog::Catalog;
use dashql_core::script::Script;
use dashql_core::utils::quote_identifier;
use dashql_grammar::keywords::Keyword;
use yaml_rust2::Yaml;

/// Does `identifier_requires_quotes` hold?
fn requires_quotes(text: &str) -> bool {
    quote_identifier(text) != text
}

/// The qualified name of an entity: keywords are quoted, as are names with upper-case letters
fn qualified_name(database: &Option<String>, schema: &Option<String>, name: &Option<String>) -> String {
    let mut out = String::new();
    for component in [database, schema, name] {
        let component = component.as_deref().unwrap_or("");
        if component.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('.');
        }
        if Keyword::find(component.as_bytes()).is_some() && !requires_quotes(component) {
            out.push('"');
            out.push_str(component);
            out.push('"');
        } else {
            out.push_str(&quote_identifier(component));
        }
    }
    out
}

fn publishable(script: &Script) -> bool {
    let (Some(scanned), Some(parsed), Some(analyzed)) = (&script.scanned, &script.parsed, &script.analyzed) else {
        return false;
    };
    scanned.errors.is_empty()
        && parsed.errors.is_empty()
        && analyzed.errors.iter().all(|e| e.severity != dashql_buffers::analyzer::AnalyzerErrorSeverity::ERROR)
}

fn prepare(catalog: &Catalog, text: &str) -> Result<Script, String> {
    let mut script = Script::new(catalog);
    script.replace_text(text);
    script.scan();
    script.parse();
    script.analyze(catalog, false).map_err(|e| e.message)?;
    Ok(script)
}

/// The texts of a planner fixture
pub struct Fixture {
    /// The catalog script
    pub catalog: Option<String>,
    /// The scripts: name, input and the text to prepend after the analysis (`stale-prepend`)
    pub scripts: Vec<(String, String, Option<String>)>,
}

impl Fixture {
    /// Read a fixture of a snapshot file
    pub fn from_yaml(fixture: &Yaml) -> Self {
        let text = |node: &Yaml| node.as_str().unwrap_or("").to_string();
        Self {
            catalog: (!matches!(fixture["catalog"], Yaml::BadValue)).then(|| text(&fixture["catalog"])),
            scripts: fixture["scripts"]
                .as_vec()
                .into_iter()
                .flatten()
                .map(|s| (text(&s["name"]), text(&s["input"]), s["stale-prepend"].as_str().map(str::to_string)))
                .collect(),
        }
    }

    /// Read a fixture of a template
    pub fn from_node(fixture: &Node) -> Self {
        let text = |node: Option<&Node>| node.and_then(Node::val).unwrap_or("").to_string();
        Self {
            catalog: fixture.get("catalog").map(|c| text(Some(c))),
            scripts: fixture
                .get("scripts")
                .map(Node::children)
                .unwrap_or_default()
                .into_iter()
                .map(|s| {
                    let prepend = s.get("stale-prepend").map(|p| text(Some(p)));
                    (text(s.get("name")), text(s.get("input")), prepend)
                })
                .collect(),
        }
    }
}

/// Plan a fixture and encode the execution graph (`PlannerSnapshotTest::Encode`)
pub fn encode_fixture(fixture: &Yaml) -> Result<Yaml, String> {
    encode_planner_fixture(&Fixture::from_yaml(fixture)).map(|node| node.to_yaml())
}

/// Plan a fixture and encode the execution graph as a styled tree
pub fn encode_planner_fixture(fixture: &Fixture) -> Result<Node, String> {
    let mut catalog = Catalog::new();
    let mut catalog_script = None;
    if let Some(text) = &fixture.catalog {
        let script = prepare(&catalog, &crate::trim_input(text))?;
        if !publishable(&script) {
            return Err("invalid planner fixture catalog".into());
        }
        catalog.load_script(script.analyzed.clone().unwrap(), 0).map_err(|e| e.message)?;
        catalog_script = Some(script);
    }
    let mut names = Vec::new();
    let mut scripts = Vec::new();
    for (name, input, prepend) in &fixture.scripts {
        if name.is_empty() || names.contains(name) {
            return Err("planner fixture script names must be nonempty and unique".into());
        }
        names.push(name.clone());
        scripts.push((prepare(&catalog, &crate::trim_input(input))?, prepend));
    }
    // Publish the complete definition set before resolving any cross-script references
    let definitions: Vec<_> = scripts
        .iter()
        .enumerate()
        .filter(|(_, (s, _))| publishable(s) && !s.analyzed.as_ref().unwrap().entry.table_declarations.is_empty())
        .map(|(i, (s, _))| (s.analyzed.clone().unwrap(), (i + 1) as u32))
        .collect();
    catalog.load_scripts(&definitions).map_err(|e| e.message)?;
    for (script, _) in scripts.iter_mut() {
        script.analyze(&catalog, false).map_err(|e| e.message)?;
    }
    for (script, source) in scripts.iter_mut() {
        if let Some(prepend) = source {
            script.insert_text_at(0, prepend);
        }
    }
    let inputs: Vec<&Script> = scripts.iter().map(|(s, _)| s).collect();
    let planner_inputs: Vec<_> =
        inputs.iter().map(|&script| dashql_core::planner::PlannerInput { script, catalog: &catalog }).collect();
    let graph = dashql_core::planner::plan(&planner_inputs);
    drop(catalog_script);
    Ok(encode_graph(&graph, &inputs, &names))
}

fn encode_graph(graph: &ExecutionGraphT, inputs: &[&Script], names: &[String]) -> Node {
    let mut out = Map::new();
    out.boolean("valid", graph.valid);
    let scripts = graph
        .scripts
        .iter()
        .flatten()
        .map(|s| {
            let mut m = Map::new();
            let index = inputs.iter().position(|i| i.catalog_entry_id() == s.script_id).unwrap();
            m.plain("name", &names[index]);
            m.int("text-version", s.text_version as i64);
            m.int("analyzed-text-version", s.analyzed_text_version as i64);
            m.int("analyzed-catalog-revision", s.analyzed_catalog_revision as i64);
            m.into_node()
        })
        .collect();
    out.insert("scripts", Node::seq(scripts));
    let entities = graph.entities.as_deref().unwrap_or_default();
    let catalog_id = |index: u32| -> String {
        let entity = &entities[index as usize];
        let id = &entity.catalog_object_id;
        let mut text = match id.object_type {
            ExecutionGraphEntityType::DATABASE => id.object_id.to_string(),
            ExecutionGraphEntityType::SCHEMA => format!("{}.{}", id.object_id, id.sub_object_id),
            _ => {
                let mut t = format!("{}.{}.{}", entity.catalog_database_id, entity.catalog_schema_id, id.object_id);
                if id.object_type == ExecutionGraphEntityType::COLUMN || id.sub_object_id != 0 {
                    t.push_str(&format!(".{}", id.sub_object_id));
                }
                t
            }
        };
        if id.object_type != ExecutionGraphEntityType::TABLE {
            text = format!("{}:{text}", id.object_type.variant_name().unwrap_or(""));
        }
        text
    };
    let entity_list = entities
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let mut m = Map::new();
            m.insert("catalog-id", Node::squo(catalog_id(i as u32)));
            m.plain("type", e.catalog_object_id.object_type.variant_name().unwrap_or(""));
            m.plain("name", &qualified_name(&e.database_name, &e.schema_name, &e.name));
            m.into_node()
        })
        .collect();
    out.insert("entities", Node::seq(entity_list));
    let unresolved = graph
        .unresolved_references
        .iter()
        .flatten()
        .map(|r| {
            let mut m = Map::new();
            m.plain("name", &qualified_name(&r.database_name, &r.schema_name, &r.name));
            m.into_node()
        })
        .collect();
    out.insert("unresolved-references", Node::seq(unresolved));
    let target = |m: &mut Map, entity: u32, unresolved: u32| {
        if entity != u32::MAX {
            m.insert("entity", Node::squo(catalog_id(entity)));
        }
        if unresolved != u32::MAX {
            m.int("unresolved-reference", unresolved as i64);
        }
    };
    let nodes = graph
        .nodes
        .iter()
        .flatten()
        .enumerate()
        .map(|(i, n)| {
            let mut m = Map::new();
            m.int("id", i as i64);
            m.plain("script", &names[n.script as usize]);
            m.int("statement-id", n.statement_id as i64);
            m.plain("type", n.statement_type.variant_name().unwrap_or(""));
            m.quoted("sql", n.sql.as_deref().unwrap_or(""));
            m.boolean("produces-output", n.produces_output);
            m.boolean("barrier", n.barrier);
            let accesses = n
                .accesses
                .iter()
                .flatten()
                .map(|a| {
                    let mut am = Map::new();
                    target(&mut am, a.entity, a.unresolved_reference);
                    am.plain("mode", a.mode.variant_name().unwrap_or(""));
                    am.into_node()
                })
                .collect();
            m.insert("accesses", Node::seq(accesses));
            m.into_node()
        })
        .collect();
    out.insert("nodes", Node::seq(nodes));
    let edges = graph
        .edges
        .iter()
        .flatten()
        .map(|e| {
            let mut m = Map::new();
            m.int("from", e.from as i64);
            m.int("to", e.to as i64);
            m.plain("reason", e.reason.variant_name().unwrap_or(""));
            target(&mut m, e.entity, e.unresolved_reference);
            m.into_node()
        })
        .collect();
    out.insert("edges", Node::seq(edges));
    let diagnostics = graph
        .diagnostics
        .iter()
        .flatten()
        .map(|d| {
            let mut m = Map::new();
            if d.node != u32::MAX {
                m.int("node", d.node as i64);
            }
            m.insert("message", plain(d.message.as_deref().unwrap_or("")));
            m.into_node()
        })
        .collect();
    out.insert("diagnostics", Node::seq(diagnostics));
    out.into_node()
}
