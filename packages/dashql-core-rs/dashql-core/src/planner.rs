//! The planner, a port of `src/planner.cc`.
//!
//! Plans relation-level hazards between the statements of several scripts: every statement becomes
//! a node with the relations it reads, writes or defines, and edges order conflicting accesses.
//! Opaque SELECT functions may have side effects; barriers order statements but do not promise
//! backend session affinity.

use crate::analyzer::{AnalyzedScript, ReferencedTable, TableRole};
use crate::catalog::{Catalog, CatalogEntryId, CatalogEntryRef, QualifiedCatalogObjectId, QualifiedTableName, TableDeclaration};
use crate::compiler::compile_visualization;
use crate::pack;
use crate::script::Script;
use dashql_buffers::analyzer::AnalyzerErrorSeverity;
use dashql_buffers::execution::{
    ExecutionGraphAccessMode as Mode, ExecutionGraphAccessT, ExecutionGraphCatalogObjectIDT, ExecutionGraphDiagnosticT,
    ExecutionGraphEdgeReason as Reason, ExecutionGraphEdgeT, ExecutionGraphEntityT, ExecutionGraphEntityType, ExecutionGraphNodeT,
    ExecutionGraphScriptT, ExecutionGraphT, ExecutionGraphUnresolvedReferenceT,
};
use dashql_buffers::parser::{AttributeKey as Key, Node, NodeType, StatementType as Type, TempType};
use dashql_grammar::attrs;
use dashql_grammar::parser::context::resolve_text_span;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

/// A relation name: (database, schema, table)
type Name = (String, String, String);

const NONE: u32 = u32::MAX;

fn resource_name(name: &QualifiedTableName) -> Name {
    (name.database_name.text.to_string(), name.schema_name.text.to_string(), name.table_name.text.to_string())
}

/// The table declarations of an entry with their AST statement ids
fn tables(entry: &CatalogEntryRef) -> &[TableDeclaration] {
    &entry.data().table_declarations
}

/// Is a table declared by a CREATE VIEW statement?
fn is_view(analyzed: &AnalyzedScript, table: &TableDeclaration) -> bool {
    table
        .ast_statement_id
        .and_then(|s| analyzed.parsed.statements.get(s as usize))
        .is_some_and(|s| s.statement_type == Type::CREATE_VIEW)
}

/// A table of the plan: a published or an input declaration
struct PlanState<'a> {
    graph: ExecutionGraphT,
    entities: BTreeMap<QualifiedCatalogObjectId, u32>,
    unresolved_references: BTreeMap<Name, u32>,
    entity_list: Vec<ExecutionGraphEntityT>,
    unresolved_list: Vec<ExecutionGraphUnresolvedReferenceT>,
    diagnostics: Vec<ExecutionGraphDiagnosticT>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl PlanState<'_> {
    fn diagnose(&mut self, node: u32, message: String, invalid: bool) {
        let mut d = ExecutionGraphDiagnosticT::default();
        d.node = node;
        d.message = Some(message);
        self.diagnostics.push(d);
        if invalid {
            self.graph.valid = false;
        }
    }

    fn intern_entity(&mut self, table: &TableDeclaration) -> u32 {
        if let Some(&i) = self.entities.get(&table.object_id) {
            return i;
        }
        let i = self.entity_list.len() as u32;
        self.entities.insert(table.object_id, i);
        let mut entity = ExecutionGraphEntityT::default();
        let mut id = ExecutionGraphCatalogObjectIDT::default();
        id.object_type = ExecutionGraphEntityType::TABLE;
        id.object_id = table.table_id().pack();
        id.sub_object_id = 0;
        entity.catalog_object_id = id;
        (entity.catalog_database_id, entity.catalog_schema_id) = table.catalog_schema_id.unpack_schema_id();
        let (db, schema, name) = resource_name(&table.table_name);
        entity.database_name = Some(db);
        entity.schema_name = Some(schema);
        entity.name = Some(name);
        self.entity_list.push(entity);
        i
    }

    fn intern_unresolved(&mut self, name: &Name) -> u32 {
        if let Some(&i) = self.unresolved_references.get(name) {
            return i;
        }
        let i = self.unresolved_list.len() as u32;
        self.unresolved_references.insert(name.clone(), i);
        let mut r = ExecutionGraphUnresolvedReferenceT::default();
        r.database_name = Some(name.0.clone());
        r.schema_name = Some(name.1.clone());
        r.name = Some(name.2.clone());
        self.unresolved_list.push(r);
        i
    }
}

/// Plan the statements of scripts (`Planner::Plan`). Consumes the current analysis without
/// analyzing, publishing or changing scripts.
pub fn plan(inputs: &[&Script], catalog: &Catalog) -> ExecutionGraphT {
    let mut state = PlanState {
        graph: ExecutionGraphT::default(),
        entities: BTreeMap::new(),
        unresolved_references: BTreeMap::new(),
        entity_list: Vec::new(),
        unresolved_list: Vec::new(),
        diagnostics: Vec::new(),
        _marker: Default::default(),
    };
    state.graph.valid = true;
    let mut script_ids: BTreeSet<CatalogEntryId> = BTreeSet::new();
    let mut offsets = Vec::new();
    let mut scripts_meta = Vec::new();
    let mut count = 0u32;
    for script in inputs {
        offsets.push(count);
        if !script_ids.insert(script.catalog_entry_id()) {
            state.diagnose(NONE, "duplicate planner script".into(), true);
        }
        let (Some(scanned), Some(parsed), Some(analyzed)) = (&script.scanned, &script.parsed, &script.analyzed) else {
            state.diagnose(NONE, "missing or stale script analysis".into(), true);
            continue;
        };
        if !Arc::ptr_eq(&analyzed.parsed, parsed) || !Arc::ptr_eq(&parsed.scanned, scanned) || scanned.text_version != script.text_version() {
            state.diagnose(NONE, "missing or stale script analysis".into(), true);
            continue;
        }
        if analyzed.entry.catalog_version != catalog.version() {
            state.diagnose(NONE, "stale catalog analysis".into(), true);
            continue;
        }
        for e in &scanned.errors {
            state.diagnose(NONE, format!("scanner: {}", e.message), true);
        }
        for e in &parsed.errors {
            state.diagnose(NONE, format!("parser: {}", e.message), true);
        }
        if parsed.statements.is_empty() {
            let text = scanned.text.as_bytes();
            let mut offset = 0;
            while offset < text.len() {
                let comment = scanned.comments.iter().find(|c| c.offset as usize <= offset && offset < (c.offset + c.length) as usize);
                if let Some(c) = comment {
                    offset = (c.offset + c.length) as usize;
                    continue;
                }
                if !b" \t\r\n\x0c;".contains(&text[offset]) {
                    state.diagnose(NONE, "unsupported SQL: parser produced no statements".into(), true);
                    break;
                }
                offset += 1;
            }
        }
        let mut meta = ExecutionGraphScriptT::default();
        meta.script_id = script.catalog_entry_id();
        meta.text_version = script.text_version();
        meta.analyzed_text_version = analyzed.parsed.scanned.text_version;
        meta.analyzed_catalog_revision = analyzed.entry.catalog_version as u64;
        scripts_meta.push(meta);
        count += parsed.statements.len() as u32;
    }
    // Invalid input snapshots must never yield executable partial plans
    if !state.graph.valid {
        return finish(state, scripts_meta, Vec::new(), Vec::new());
    }

    // The declarations of the catalog and the inputs
    let mut producers: BTreeMap<u64, u32> = BTreeMap::new();
    let mut declarations: BTreeMap<QualifiedCatalogObjectId, &TableDeclaration> = BTreeMap::new();
    let mut published_views: BTreeMap<QualifiedCatalogObjectId, bool> = BTreeMap::new();
    let mut incompatible_kinds: BTreeSet<QualifiedCatalogObjectId> = BTreeSet::new();
    let mut views: BTreeSet<u64> = BTreeSet::new();
    let remember_views = |views: &mut BTreeSet<u64>, analyzed: &AnalyzedScript| {
        for table in &analyzed.entry.table_declarations {
            if is_view(analyzed, table) {
                views.insert(table.table_id().pack());
            }
        }
    };
    for (_, entry) in catalog.entries_ranked() {
        if let CatalogEntryRef::Script(analyzed) = entry {
            remember_views(&mut views, analyzed);
        }
        for table in tables(entry) {
            declarations.insert(table.object_id, table);
            published_views.insert(table.object_id, views.contains(&table.table_id().pack()));
        }
    }
    let analyzed_inputs: Vec<&Arc<AnalyzedScript>> = inputs.iter().map(|s| s.analyzed.as_ref().unwrap()).collect();
    for (i, analyzed) in analyzed_inputs.iter().enumerate() {
        remember_views(&mut views, analyzed);
        for table in &analyzed.entry.table_declarations {
            let view = is_view(analyzed, table);
            if published_views.get(&table.object_id).is_some_and(|&p| p != view) {
                incompatible_kinds.insert(table.object_id);
            }
            declarations.insert(table.object_id, table);
            if let Some(statement) = table.ast_statement_id {
                producers.insert(table.table_id().pack(), offsets[i] + statement);
            }
        }
    }

    let mut live_producers: BTreeSet<Name> = BTreeSet::new();
    let mut dropped_resources: BTreeSet<Name> = BTreeSet::new();
    let mut live_views: BTreeSet<Name> = BTreeSet::new();
    let mut live_namespace: BTreeMap<Name, &TableDeclaration> = BTreeMap::new();
    for (_, entry) in catalog.entries_ranked() {
        // Participating declarations enter the namespace only when their CREATE is reached
        if script_ids.contains(&entry.data().catalog_entry_id) {
            continue;
        }
        for table in tables(entry) {
            live_namespace.entry(resource_name(&table.table_name)).or_insert(table);
        }
    }

    let mut nodes: Vec<ExecutionGraphNodeT> = Vec::new();
    for (si, script) in inputs.iter().enumerate() {
        let analyzed = analyzed_inputs[si];
        let parsed = script.parsed.as_ref().unwrap();
        let scanned = &parsed.scanned;
        let text_at = |offset: u32, length: u32| -> String {
            let text = scanned.text.as_bytes();
            let begin = (offset as usize).min(text.len());
            let end = (begin + length as usize).min(text.len());
            String::from_utf8_lossy(&text[begin..end]).into_owned()
        };
        let descriptions = parsed.associate_descriptions();
        let children = |n: &Node| -> &[Node] {
            let begin = n.children_begin_or_value() as usize;
            &parsed.nodes[begin..begin + n.children_count() as usize]
        };
        for (statement_id, statement) in parsed.statements.iter().enumerate() {
            let node_id = nodes.len() as u32;
            let mut node = ExecutionGraphNodeT::default();
            node.script = si as u32;
            node.statement_id = statement_id as u32;
            node.statement_type = statement.statement_type;
            let ty = statement.statement_type;
            let span = descriptions[statement_id].statement_span;
            let mut sql = text_at(span.offset, span.length);
            node.produces_output = matches!(ty, Type::SELECT | Type::EXPLAIN | Type::VIS_VISUALISE);
            let root = &parsed.nodes[statement.root as usize];
            let mut explain_executes = false;
            let mut accesses: BTreeMap<(u32, u32), Mode> = BTreeMap::new();
            let mut barrier = false;
            // `barrier` marks the node, `invalid` the plan
            macro_rules! barrier {
                ($message:expr, $invalid:expr) => {{
                    barrier = true;
                    state.diagnose(node_id, $message.to_string(), $invalid);
                }};
            }
            let access = |state: &mut PlanState, accesses: &mut BTreeMap<(u32, u32), Mode>, name: &Name, table: Option<&TableDeclaration>, mode: Mode| {
                let target = match table {
                    Some(t) => (state.intern_entity(t), NONE),
                    None => (NONE, state.intern_unresolved(name)),
                };
                let entry = accesses.entry(target).or_insert(mode);
                if mode > *entry {
                    *entry = mode;
                }
            };
            match ty {
                Type::SELECT
                | Type::INSERT
                | Type::DELETE
                | Type::EXPLAIN
                | Type::VIS_VISUALISE
                | Type::CREATE_TABLE
                | Type::CREATE_TABLE_AS
                | Type::CREATE_VIEW
                | Type::SELECT_INTO
                | Type::DROP_TABLE
                | Type::DROP_VIEW => {}
                _ => {
                    barrier!("unsupported statement effects; backend session semantics are not guaranteed", true);
                    sql.clear();
                }
            }
            if ty == Type::VIS_VISUALISE {
                let [source] = attrs!(children(root), [Key::VIS_VISUALISE_SELECT]);
                match source.filter(|s| s.node_type() == NodeType::OBJECT_SQL_SELECT) {
                    None => {
                        barrier!("VISUALIZE requires a SELECT source", true);
                        sql.clear();
                    }
                    Some(source) => {
                        let ts = resolve_text_span(&scanned.text, &scanned.symbols, *source.symbol_span());
                        sql = text_at(ts.offset, ts.length);
                        let visualization = analyzed.visualization_specs.iter().find(|s| s.ast_statement_id == Some(statement_id as u32));
                        match visualization {
                            None => {
                                barrier!("could not resolve visualization metadata", true);
                                sql.clear();
                            }
                            Some(spec) => match compile_visualization(spec, analyzed) {
                                Ok(compiled) => node.visualization = Some(Box::new(compiled)),
                                Err(e) => {
                                    barrier!(format!("visualization: {e}"), true);
                                    sql.clear();
                                }
                            },
                        }
                    }
                }
            }
            if ty == Type::EXPLAIN {
                let [body, options] = attrs!(children(root), [Key::EXT_EXPLAIN_STATEMENT, Key::EXT_EXPLAIN_OPTIONS]);
                let option_text = |n: Option<&Node>| -> String {
                    let Some(n) = n.filter(|n| n.node_type() != NodeType::NONE) else { return String::new() };
                    let ts = resolve_text_span(&scanned.text, &scanned.symbols, *n.symbol_span());
                    let mut text = text_at(ts.offset, ts.length).to_ascii_lowercase();
                    let b = text.as_bytes();
                    if b.len() >= 2 && (b[0] == b'\'' || b[0] == b'"') && b[b.len() - 1] == b[0] {
                        text = text[1..text.len() - 1].to_string();
                    }
                    text
                };
                if let Some(options) = options.filter(|o| o.node_type() == NodeType::ARRAY) {
                    for option in children(options) {
                        if option.node_type() != NodeType::OBJECT_SQL_GENERIC_OPTION {
                            continue;
                        }
                        let [key, value] = attrs!(children(option), [Key::SQL_GENERIC_OPTION_KEY, Key::SQL_GENERIC_OPTION_VALUE]);
                        let name = option_text(key);
                        if name == "analyze" || name == "analyse" {
                            // Unknown arguments are execution-enabled, not proof of read-only behavior
                            explain_executes |= value.is_none_or(|v| v.node_type() != NodeType::BOOL || v.children_begin_or_value() != 0);
                        } else if name == "format" && matches!(option_text(value).as_str(), "analyze" | "analyse") {
                            explain_executes = true;
                        }
                    }
                }
                if body.is_none_or(|b| b.node_type() == NodeType::NONE) {
                    barrier!("EXPLAIN requires a statement or expressions body", true);
                    sql.clear();
                }
            }
            for e in &analyzed.errors {
                if e.ast_node_id < statement.nodes_begin || e.ast_node_id >= statement.nodes_begin + statement.node_count {
                    continue;
                }
                let invalid = e.severity == AnalyzerErrorSeverity::ERROR;
                state.diagnose(node_id, format!("analyzer: {}", e.message), invalid);
                if invalid {
                    barrier = true;
                }
            }
            if ty == Type::INSERT || ty == Type::DELETE {
                let [returning] = if ty == Type::INSERT {
                    attrs!(children(root), [Key::SQL_INSERT_RETURNING])
                } else {
                    attrs!(children(root), [Key::SQL_DELETE_RETURNING])
                };
                node.produces_output = returning.is_some_and(|r| r.node_type() != NodeType::NONE);
            }
            // AST effects that are not represented by ordinary relation reads
            for ni in statement.nodes_begin..statement.nodes_begin + statement.node_count {
                let ast = &parsed.nodes[ni as usize];
                if ast.node_type() == NodeType::NONE {
                    continue;
                }
                let mutating = matches!(
                    ast.node_type(),
                    NodeType::OBJECT_SQL_INSERT
                        | NodeType::OBJECT_SQL_DELETE
                        | NodeType::OBJECT_SQL_CREATE
                        | NodeType::OBJECT_SQL_CREATE_AS
                        | NodeType::OBJECT_SQL_VIEW
                        | NodeType::OBJECT_SQL_CREATE_FUNCTION
                ) || ast.attribute_key() == Key::SQL_SELECT_INTO;
                if ty == Type::EXPLAIN && explain_executes && mutating {
                    barrier!("execution-enabled EXPLAIN with a mutating body cannot be safely classified", true);
                    sql.clear();
                }
                if ty == Type::VIS_VISUALISE && ast.attribute_key() == Key::SQL_SELECT_INTO {
                    barrier!("VISUALIZE SELECT INTO has unsupported mutation and session effects", true);
                    sql.clear();
                }
                if ast.node_type() == NodeType::ENUM_SQL_TEMP_TYPE && ast.children_begin_or_value() == TempType::NONE.0 as u32 {
                    continue;
                }
                if matches!(
                    ast.attribute_key(),
                    Key::SQL_CREATE_TABLE_TEMP
                        | Key::SQL_CREATE_AS_TEMP
                        | Key::SQL_VIEW_TEMP
                        | Key::SQL_TEMP_TYPE
                        | Key::SQL_SELECT_ROW_LOCKING
                        | Key::SQL_TABLE_CONSTRAINT_REFERENCES_NAME
                ) || matches!(ast.node_type(), NodeType::OBJECT_SQL_GRAPH_TABLE | NodeType::OBJECT_SQL_PROPERTY_GRAPH)
                {
                    barrier!("unsupported session, locking, constraint, or graph effects", true);
                }
            }
            for table_ref in &analyzed.table_references {
                if table_ref.ast_statement_id != Some(statement_id as u32) {
                    continue;
                }
                let Some(relation) = &table_ref.inner else {
                    barrier!("unsupported table source", true);
                    continue;
                };
                if !relation.resolved_alternatives.is_empty() {
                    barrier!("ambiguous relation reference", true);
                }
                // References to CTEs are no relation accesses
                if relation.resolved_table.is_none()
                    && table_ref.role == TableRole::Read
                    && relation.table_name.database_name.text.is_empty()
                    && relation.table_name.schema_name.text.is_empty()
                {
                    if let Some(&scope) = table_ref.ast_scope_root.and_then(|r| analyzed.name_scopes_by_root_node.get(&r)) {
                        let alias = match &table_ref.alias {
                            Some((a, _)) => a.text.clone(),
                            None => relation.table_name.table_name.text.clone(),
                        };
                        if matches!(analyzed.name_scopes[scope as usize].referenced_tables_by_name.get(&alias), Some(ReferencedTable::Cte(_))) {
                            continue;
                        }
                    }
                }
                let name = resource_name(relation.resolved_table.as_ref().map(|t| &t.table_name).unwrap_or(&relation.table_name));
                let mut table: Option<&TableDeclaration> = None;
                if let Some(resolved) = &relation.resolved_table {
                    if let Some(&declaration) = declarations.get(&resolved.catalog_table_id) {
                        if declaration.catalog_schema_id == resolved.catalog_schema_id
                            && resource_name(&declaration.table_name) == name
                            && !incompatible_kinds.contains(&resolved.catalog_table_id)
                        {
                            table = Some(declaration);
                        }
                    }
                    // Analysis can bind an earlier access to a later same-name declaration, the live
                    // lifetime still owns that access
                    if let (Some(_), Some(&live)) = (table, live_namespace.get(&name)) {
                        if live_producers.contains(&name) || producers.contains_key(&resolved.catalog_table_id.unpack_table_id().pack()) {
                            table = Some(live);
                        }
                    }
                    if table.is_none() {
                        barrier!("resolved relation declaration is incompatible or unavailable", true);
                    }
                }
                let write = table_ref.role == TableRole::Write && (ty != Type::EXPLAIN || explain_executes);
                access(&mut state, &mut accesses, &name, table, if write { Mode::WRITE } else { Mode::READ });
                if dropped_resources.contains(&name) {
                    barrier!("relation was dropped without an earlier lifetime producer; later producer cannot be reordered", true);
                }
                match &relation.resolved_table {
                    None => barrier!(format!("unresolved relation: {}", relation.table_name.debug_string()), false),
                    Some(resolved) => {
                        let id = match table {
                            Some(t) => t.table_id().pack(),
                            None => resolved.catalog_table_id.unpack_table_id().pack(),
                        };
                        if producers.get(&id).is_some_and(|&p| p >= node_id) && !live_producers.contains(&name) {
                            barrier!("relation resolves to a later producer in input order", true);
                        }
                        if views.contains(&id) || live_views.contains(&name) {
                            barrier!("view dependencies are not expanded; conservative access barrier", false);
                        }
                    }
                }
            }
            let drop = matches!(ty, Type::DROP_TABLE | Type::DROP_VIEW);
            let ddl = drop || matches!(ty, Type::CREATE_TABLE | Type::CREATE_TABLE_AS | Type::CREATE_VIEW | Type::SELECT_INTO);
            if ddl {
                let packed = pack::pack_parsed_statement(parsed, statement_id);
                match packed.target {
                    None => barrier!("missing DDL target", true),
                    Some(target) => {
                        let mut name: Name = (
                            target.database_name.clone().unwrap_or_default(),
                            target.schema_name.clone().unwrap_or_default(),
                            target.relation_name.clone().unwrap_or_default(),
                        );
                        let mut table: Option<&TableDeclaration> = None;
                        if drop {
                            // Prefer an exact live name, then native suffix matches. Never let a future
                            // declaration in an analyzed input redirect this DROP.
                            if !live_namespace.contains_key(&name) {
                                let matches: BTreeSet<Name> = live_namespace
                                    .keys()
                                    .filter(|c| c.2 == name.2 && (name.1.is_empty() || c.1 == name.1) && (name.0.is_empty() || c.0 == name.0))
                                    .cloned()
                                    .collect();
                                if matches.len() == 1 {
                                    name = matches.into_iter().next().unwrap();
                                } else if matches.len() > 1 {
                                    barrier!("ambiguous DROP target", true);
                                }
                            }
                            match live_namespace.get(&name) {
                                Some(&live) => table = Some(live),
                                None => barrier!("unresolved DROP target; conservative access barrier", false),
                            }
                            if let Some(t) = table {
                                if views.contains(&t.table_id().pack()) || live_views.contains(&name) {
                                    barrier!("view dependencies are not expanded; conservative access barrier", false);
                                }
                            }
                        } else {
                            for declaration in &analyzed.entry.table_declarations {
                                if declaration.ast_statement_id == Some(statement_id as u32) && resource_name(&declaration.table_name) == name {
                                    table = Some(declaration);
                                }
                            }
                            match table {
                                Some(t) => name = resource_name(&t.table_name),
                                None => barrier!("missing DDL target declaration", true),
                            }
                        }
                        access(&mut state, &mut accesses, &name, table, Mode::DDL);
                        if drop {
                            live_producers.remove(&name);
                            live_namespace.remove(&name);
                            live_views.remove(&name);
                            dropped_resources.insert(name);
                        } else {
                            live_producers.insert(name.clone());
                            if let Some(t) = table {
                                live_namespace.insert(name.clone(), t);
                            }
                            dropped_resources.remove(&name);
                            if ty == Type::CREATE_VIEW {
                                live_views.insert(name);
                            } else {
                                live_views.remove(&name);
                            }
                        }
                    }
                }
            }
            node.accesses = Some(
                accesses
                    .into_iter()
                    .map(|((entity, unresolved), mode)| {
                        let mut a = ExecutionGraphAccessT::default();
                        a.entity = entity;
                        a.unresolved_reference = unresolved;
                        a.mode = mode;
                        a
                    })
                    .collect(),
            );
            node.sql = Some(sql);
            node.barrier = barrier;
            nodes.push(node);
        }
    }

    // Order conflicting accesses along the timeline of every relation
    #[derive(Default)]
    struct Timeline {
        writer: Option<u32>,
        mode: Option<Mode>,
        readers: Vec<u32>,
    }
    let mut timelines: BTreeMap<Name, Timeline> = BTreeMap::new();
    let mut edges: BTreeSet<(u32, u32, u32, u32, u8)> = BTreeSet::new();
    let mut edge = |from: Option<u32>, to: u32, entity: u32, unresolved: u32, reason: Reason| {
        if let Some(from) = from {
            if from != to {
                edges.insert((from, to, entity, unresolved, reason.0));
            }
        }
    };
    let mut last_barrier = None;
    let mut since_barrier = Vec::new();
    for (i, node) in nodes.iter().enumerate() {
        let i = i as u32;
        edge(last_barrier, i, NONE, NONE, Reason::BARRIER);
        if node.barrier {
            for &earlier in &since_barrier {
                edge(Some(earlier), i, NONE, NONE, Reason::BARRIER);
            }
            since_barrier.clear();
            last_barrier = Some(i);
        } else {
            since_barrier.push(i);
        }
        // Merge by name only for conflict tracking
        let mut merged: BTreeMap<Name, &ExecutionGraphAccessT> = BTreeMap::new();
        for a in node.accesses.iter().flatten() {
            let name = if a.entity != NONE {
                let e = &state.entity_list[a.entity as usize];
                (e.database_name.clone().unwrap_or_default(), e.schema_name.clone().unwrap_or_default(), e.name.clone().unwrap_or_default())
            } else {
                let r = &state.unresolved_list[a.unresolved_reference as usize];
                (r.database_name.clone().unwrap_or_default(), r.schema_name.clone().unwrap_or_default(), r.name.clone().unwrap_or_default())
            };
            match merged.get(&name) {
                Some(existing) if a.mode <= existing.mode => {}
                _ => {
                    merged.insert(name, a);
                }
            }
        }
        for (name, a) in merged {
            let timeline = timelines.entry(name).or_default();
            let ddl = a.mode == Mode::DDL || timeline.mode == Some(Mode::DDL);
            if a.mode == Mode::READ {
                edge(timeline.writer, i, a.entity, a.unresolved_reference, if ddl { Reason::DDL } else { Reason::READ_AFTER_WRITE });
                timeline.readers.push(i);
            } else {
                edge(timeline.writer, i, a.entity, a.unresolved_reference, if ddl { Reason::DDL } else { Reason::WRITE_AFTER_WRITE });
                for &reader in &timeline.readers {
                    edge(Some(reader), i, a.entity, a.unresolved_reference, if a.mode == Mode::DDL { Reason::DDL } else { Reason::WRITE_AFTER_READ });
                }
                timeline.readers.clear();
                timeline.writer = Some(i);
                timeline.mode = Some(a.mode);
            }
        }
    }
    let edges = edges
        .into_iter()
        .map(|(from, to, entity, unresolved, reason)| {
            let mut e = ExecutionGraphEdgeT::default();
            e.from = from;
            e.to = to;
            e.entity = entity;
            e.unresolved_reference = unresolved;
            e.reason = Reason(reason);
            e
        })
        .collect();
    finish(state, scripts_meta, nodes, edges)
}

/// A string the C++ object API leaves out when empty
fn opt(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}

/// A vector the C++ object API leaves out when empty
fn opt_vec<T>(v: Vec<T>) -> Option<Vec<T>> {
    (!v.is_empty()).then_some(v)
}

fn finish(state: PlanState, scripts: Vec<ExecutionGraphScriptT>, nodes: Vec<ExecutionGraphNodeT>, edges: Vec<ExecutionGraphEdgeT>) -> ExecutionGraphT {
    let mut graph = state.graph;
    graph.scripts = opt_vec(scripts);
    graph.entities = opt_vec(
        state
            .entity_list
            .into_iter()
            .map(|mut e| {
                e.database_name = opt(e.database_name);
                e.schema_name = opt(e.schema_name);
                e.name = opt(e.name);
                e
            })
            .collect(),
    );
    graph.unresolved_references = opt_vec(
        state
            .unresolved_list
            .into_iter()
            .map(|mut r| {
                r.database_name = opt(r.database_name);
                r.schema_name = opt(r.schema_name);
                r.name = opt(r.name);
                r
            })
            .collect(),
    );
    graph.nodes = opt_vec(
        nodes
            .into_iter()
            .map(|mut n| {
                n.sql = opt(n.sql);
                n.accesses = n.accesses.and_then(opt_vec);
                if let Some(v) = n.visualization.as_mut() {
                    v.renderer = opt(v.renderer.take());
                    v.vegalite_spec = opt(v.vegalite_spec.take());
                }
                n
            })
            .collect(),
    );
    graph.edges = opt_vec(edges);
    graph.diagnostics = opt_vec(
        state
            .diagnostics
            .into_iter()
            .map(|mut d| {
                d.message = opt(d.message);
                d
            })
            .collect(),
    );
    graph
}
