//! Name resolution (`name_resolution_pass.cc`).
//!
//! The visit collects table references, column references, result targets, CTEs and declarations
//! bottom-up and groups them into name scopes. Finish resolves the names of all scopes, populates
//! derived tables, assigns statement ids and runs the schema inference.
//!
//! The C++ pass threads intrusive lists through the node states. Here the node states hold vectors
//! of ids, and merging a child moves its entries to the end, like `IntrusiveList::Append`.

use super::state::{quote_identifier, AnalysisState};
use super::types::*;
use super::NameObject;
use crate::catalog::*;
use dashql_buffers::analyzer::{AnalyzerErrorSeverity, AnalyzerErrorType, NameTag, SemanticNodeMarkerType};
use dashql_buffers::parser::{AttributeKey as K, Node, NodeType, StatementType};
use dashql_grammar::attrs;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;

/// The maximum number of tables a reference may resolve to
const MAX_TABLE_REF_AMBIGUITY: usize = 100;

/// A table column collected from a column definition
#[derive(Clone)]
struct PendingColumn {
    ast_node_id: u32,
    column_name: Name,
}

/// The state of a node during name resolution
#[derive(Default)]
struct NodeState {
    child_scopes: Vec<ScopeId>,
    table_columns: Vec<PendingColumn>,
    table_references: Vec<TableRefId>,
    column_references: Vec<ExprId>,
    result_targets: Vec<ResultTarget>,
    ctes: Vec<CteDefinition>,
}

impl NodeState {
    fn merge(&mut self, other: &mut NodeState) {
        self.child_scopes.append(&mut other.child_scopes);
        self.table_columns.append(&mut other.table_columns);
        self.table_references.append(&mut other.table_references);
        self.column_references.append(&mut other.column_references);
        self.result_targets.append(&mut other.result_targets);
        self.ctes.append(&mut other.ctes);
    }

    fn clear(&mut self) {
        *self = NodeState::default();
    }
}

/// A declaration whose columns are derived after its SELECT scope is resolved
struct PendingDerivedTable {
    table: u32,
    select_node_id: u32,
    column_aliases: Vec<Name>,
}

/// The root scopes, a port of the `ankerl::unordered_dense::set` of the C++ pass.
///
/// The set iterates in insertion order, and erasing moves the last element into the hole.
#[derive(Default)]
struct RootScopes {
    values: Vec<ScopeId>,
    positions: HashMap<ScopeId, usize>,
}

impl RootScopes {
    fn insert(&mut self, scope: ScopeId) {
        if self.positions.contains_key(&scope) {
            return;
        }
        self.positions.insert(scope, self.values.len());
        self.values.push(scope);
    }

    fn erase(&mut self, scope: ScopeId) {
        let Some(pos) = self.positions.remove(&scope) else { return };
        let last = self.values.pop().unwrap();
        if pos < self.values.len() {
            self.values[pos] = last;
            self.positions.insert(last, pos);
        }
    }
}

pub(super) struct NameResolutionPass {
    node_states: Vec<NodeState>,
    root_scopes: RootScopes,
    pending_derived_tables: Vec<PendingDerivedTable>,
}

impl NameResolutionPass {
    pub fn new(state: &AnalysisState) -> Self {
        let mut node_states = Vec::with_capacity(state.ast.len());
        node_states.resize_with(state.ast.len(), NodeState::default);
        Self {
            node_states,
            root_scopes: RootScopes::default(),
            pending_derived_tables: Vec::new(),
        }
    }

    /// Merge the states of all children of a node
    fn merge_child_states(&mut self, dst: &mut NodeState, node: &Node) {
        let begin = node.children_begin_or_value() as usize;
        for child in begin..begin + node.children_count() as usize {
            dst.merge(&mut self.node_states[child]);
        }
    }

    /// Create a naming scope (`CreateScope`)
    fn create_scope(&mut self, state: &mut AnalysisState, target: &mut NodeState, scope_root: u32) -> ScopeId {
        let scope_id = state.out.name_scopes.len() as ScopeId;
        state.out.name_scopes_by_root_node.entry(scope_root).or_insert(scope_id);
        for &child in &target.child_scopes {
            state.out.name_scopes[child as usize].parent_scope = Some(scope_id);
            self.root_scopes.erase(child);
        }
        for &expr in &target.column_references {
            if let Some(column_ref) = state.out.expressions[expr as usize].column_ref_mut() {
                column_ref.ast_scope_root = Some(scope_root);
            }
        }
        for &table_ref in &target.table_references {
            state.out.table_references[table_ref as usize].ast_scope_root = Some(scope_root);
        }
        state.out.name_scopes.push(NameScope {
            name_scope_id: scope_id,
            ast_node_id: scope_root,
            child_scopes: std::mem::take(&mut target.child_scopes),
            expressions: std::mem::take(&mut target.column_references),
            table_references: std::mem::take(&mut target.table_references),
            ..Default::default()
        });
        // Start a new scope
        target.clear();
        target.child_scopes.push(scope_id);
        self.root_scopes.insert(scope_id);
        scope_id
    }

    /// Register a schema and its database (`RegisterSchema`)
    fn register_schema(state: &mut AnalysisState, database_name: &Name, schema_name: &Name) -> QualifiedCatalogObjectId {
        let db_id = match state.out.entry.databases_by_name.get(&database_name.text) {
            Some(&i) => state.out.entry.database_references[i].object_id,
            None => {
                let db_id = state.catalog.reserve_database_id(&database_name.text);
                let index = state.out.entry.database_references.len();
                state.out.entry.database_references.push(DatabaseReference {
                    object_id: db_id,
                    database_name: database_name.text.clone(),
                    database_alias: Arc::from(""),
                });
                state.out.entry.databases_by_name.insert(database_name.text.clone(), index);
                state.resolve_name(database_name, NameObject::Database(index as u32));
                db_id
            }
        };
        let key = (database_name.text.clone(), schema_name.text.clone());
        match state.out.entry.schemas_by_qualified_name.get(&key) {
            Some(&i) => state.out.entry.schema_references[i].object_id,
            None => {
                let schema_id = state.catalog.reserve_schema_id(&database_name.text, &schema_name.text, db_id);
                let index = state.out.entry.schema_references.len();
                state.out.entry.schema_references.push(SchemaReference {
                    object_id: schema_id,
                    database_name: database_name.text.clone(),
                    schema_name: schema_name.text.clone(),
                });
                state.out.entry.schemas_by_qualified_name.insert(key, index);
                state.resolve_name(schema_name, NameObject::Schema(index as u32));
                schema_id
            }
        }
    }

    fn is_explain(state: &AnalysisState, statement_id: u32) -> bool {
        state
            .parsed
            .statements
            .get(statement_id as usize)
            .is_some_and(|s| s.statement_type == StatementType::EXPLAIN)
    }

    /// Register a table-like declaration backed by a SELECT scope (`RegisterDerivedTable`)
    fn register_derived_table(
        &mut self,
        state: &mut AnalysisState,
        declaration_node: &Node,
        name_node: Option<&Node>,
        columns_node: Option<&Node>,
        select_node: &Node,
    ) {
        let declaration_id = state.node_id(declaration_node);
        // EXPLAIN describes a declaration, publishing it would create a phantom catalog producer
        if Self::is_explain(state, state.find_statement_id(declaration_id)) {
            return;
        }
        let Some(table_name) = state.read_qualified_table_name(name_node) else { return };
        let schema_id = Self::register_schema(state, &table_name.database_name, &table_name.schema_name);
        let index = state.out.entry.table_declarations.len() as u32;
        let table_id = ExternalObjectId::new(state.entry_id, index);
        let name = table_name.table_name.clone();
        let mut table = TableDeclaration::new(schema_id, table_id, table_name);
        table.ast_node_id = Some(declaration_id);
        table.ast_statement_id = Some(state.find_statement_id(declaration_id));
        table.ast_scope_root = Some(state.node_id(select_node));
        state.out.entry.table_declarations.push(table);
        state.resolve_name(&name, NameObject::Table(index));

        let mut column_aliases = Vec::new();
        if let Some(columns) = columns_node.filter(|n| n.node_type() == NodeType::ARRAY) {
            for column in state.children(columns) {
                if column.node_type() != NodeType::NAME {
                    continue;
                }
                let name = state.node_name(column);
                state.tag(&name, NameTag::COLUMN_NAME);
                column_aliases.push(name);
            }
        }
        self.pending_derived_tables.push(PendingDerivedTable {
            table: index,
            select_node_id: state.node_id(select_node),
            column_aliases,
        });
    }

    /// Materialize a pending declaration after its SELECT scope has output columns
    fn populate_derived_table(state: &mut AnalysisState, pending: &PendingDerivedTable, scope: ScopeId) {
        let mut output_scope = scope;
        {
            let s = &state.out.name_scopes[scope as usize];
            if s.output_columns.is_empty() && !s.child_scopes.is_empty() {
                output_scope = s.child_scopes[0];
            }
        }
        let outputs = &state.out.name_scopes[output_scope as usize].output_columns;
        let column_names: Vec<Name> = if !pending.column_aliases.is_empty() {
            let count = pending.column_aliases.len().min(outputs.len());
            pending.column_aliases[..count].to_vec()
        } else {
            outputs.iter().filter(|o| !o.column_name.text.is_empty()).map(|o| o.column_name.clone()).collect()
        };
        let table_index = pending.table;
        let table_id = ExternalObjectId::new(state.entry_id, table_index);
        for (column_index, column_name) in column_names.into_iter().enumerate() {
            let table = &mut state.out.entry.table_declarations[table_index as usize];
            table.table_columns_by_name.entry(column_name.text.clone()).or_insert(column_index);
            table.table_columns.push(TableColumn {
                object_id: QualifiedCatalogObjectId::table_column(table_id, column_index as u32),
                table: Some(table_id),
                ast_node_id: None,
                column_name: column_name.clone(),
            });
            let loc = ColumnLoc {
                table: TableLoc::from(table_id),
                column: column_index as u32,
            };
            state.resolve_name(&column_name, NameObject::Column(loc));
        }
    }

    /// The alias under which a table reference is registered in its scope
    fn table_ref_alias(table_ref: &TableReference, fallback: &Arc<str>) -> Arc<str> {
        match &table_ref.alias {
            Some((alias, _)) => alias.text.clone(),
            None => fallback.clone(),
        }
    }

    /// Register a table-like source in a scope
    fn register_in_scope(state: &mut AnalysisState, scope: ScopeId, table_ref: TableRefId, alias: Arc<str>, entry: ReferencedTable) {
        if state.out.name_scopes[scope as usize].referenced_tables_by_name.contains(&alias) {
            let node_id = state.out.table_references[table_ref as usize].ast_node_id;
            let message = format!("duplicate table alias {}", quote_identifier(&alias));
            state.add_error(AnalyzerErrorType::DUPLICATE_TABLE_ALIAS, AnalyzerErrorSeverity::ERROR, node_id, message);
        } else {
            state.out.name_scopes[scope as usize].referenced_tables_by_name.insert(alias, entry);
        }
    }

    /// Resolve all table refs in a scope (`ResolveTableRefsInScope`)
    fn resolve_table_refs_in_scope(state: &mut AnalysisState, scope: ScopeId) {
        let table_refs = state.out.name_scopes[scope as usize].table_references.clone();
        for table_ref_id in table_refs {
            let table_ref = &state.out.table_references[table_ref_id as usize];
            let Some(relation) = &table_ref.inner else { continue };
            if relation.resolved_table.is_some() {
                continue;
            }
            let table_name = relation.table_name.clone();
            let ref_name = table_name.table_name.text.clone();
            let role = table_ref.role;
            let reference_offset = state.ast[table_ref.ast_node_id as usize].symbol_span().offset();

            // Does the table ref match a CTE definition in this or any parent scope?
            let mut matched_cte = None;
            let mut s = Some(scope);
            while let Some(sid) = s {
                let candidate = &state.out.name_scopes[sid as usize];
                if let Some(index) = candidate.cte_definitions.get_index(&ref_name) {
                    let mut visible = true;
                    if !candidate.ctes_recursive {
                        let definition = &state.ast[candidate.cte_definitions.at(index).definition_node_id as usize];
                        let span = definition.symbol_span();
                        let definition_end = span.offset() + span.length();
                        visible = reference_offset > definition_end;
                    }
                    if visible {
                        matched_cte = Some(CteLoc {
                            scope: sid,
                            index: index as u32,
                        });
                        break;
                    }
                }
                s = candidate.parent_scope;
            }
            if let (Some(cte), TableRole::Read) = (matched_cte, role) {
                let alias = Self::table_ref_alias(&state.out.table_references[table_ref_id as usize], &ref_name);
                Self::register_in_scope(state, scope, table_ref_id, alias, ReferencedTable::Cte(cte));
                continue;
            }

            // Resolve as a table of the own script, then through the catalog
            let mut resolved = Vec::new();
            state.out.entry.resolve_table(&table_name, &mut resolved, MAX_TABLE_REF_AMBIGUITY);
            if resolved.is_empty() {
                state.catalog.resolve_table(&table_name, state.entry_id, &mut resolved, MAX_TABLE_REF_AMBIGUITY);
            }
            if let Some(&best_loc) = resolved.first() {
                let entries: Vec<ResolvedTableEntry> = resolved
                    .iter()
                    .filter_map(|&loc| state.table(loc))
                    .map(|t| ResolvedTableEntry {
                        table_name: t.table_name.clone(),
                        catalog_schema_id: t.catalog_schema_id,
                        catalog_table_id: t.object_id,
                        referenced_catalog_version: t.catalog_version,
                    })
                    .collect();
                let best_name = entries[0].table_name.table_name.text.clone();
                let relation = state.out.table_references[table_ref_id as usize].inner.as_mut().unwrap();
                let mut entries = entries.into_iter();
                relation.resolved_table = entries.next();
                relation.resolved_alternatives.extend(entries);
                let alias = Self::table_ref_alias(&state.out.table_references[table_ref_id as usize], &best_name);
                Self::register_in_scope(state, scope, table_ref_id, alias, ReferencedTable::Table(best_loc));
                continue;
            }

            // Neither a CTE nor in the catalog. Register an unresolved relation so that columns used
            // against it can be associated for schema inference.
            let alias = Self::table_ref_alias(&state.out.table_references[table_ref_id as usize], &ref_name);
            let unresolved = ReferencedTable::Unresolved(UnresolvedRelation {
                table_ref: table_ref_id,
                table_name,
            });
            Self::register_in_scope(state, scope, table_ref_id, alias, unresolved);
        }
    }

    /// Resolve a column against a referenced table (`ReferencedTable::ResolveColumn`)
    fn resolve_column(state: &AnalysisState, table: &ReferencedTable, column_name: &str) -> ColumnResolution {
        match table {
            ReferencedTable::Table(loc) => match state.table(*loc).and_then(|t| t.table_columns_by_name.get(column_name)) {
                Some(&column) => ColumnResolution::TableColumn(ColumnLoc {
                    table: *loc,
                    column: column as u32,
                }),
                None => ColumnResolution::Unresolved,
            },
            // An unresolved relation has an unknown schema
            ReferencedTable::Unresolved(_) => ColumnResolution::Unresolved,
            ReferencedTable::Cte(loc) => {
                let cte = state.out.name_scopes[loc.scope as usize].cte_definitions.at(loc.index as usize);
                let Some(child) = cte.child_scope else {
                    return ColumnResolution::Unresolved;
                };
                let child_scope = &state.out.name_scopes[child as usize];
                let column = if !cte.column_aliases.is_empty() {
                    cte.column_aliases.iter().position(|a| &*a.text == column_name)
                } else {
                    child_scope.output_columns_by_name.get(column_name).copied()
                };
                match column {
                    Some(c) if c < child_scope.output_columns.len() => ColumnResolution::ScopeColumn {
                        scope: child,
                        column: c as u32,
                    },
                    _ => ColumnResolution::Unresolved,
                }
            }
        }
    }

    /// Try to resolve a column ref against the tables of a scope (`TryResolveColumnInScope`)
    fn try_resolve_column_in_scope(state: &mut AnalysisState, expr: ExprId, target: ScopeId) -> bool {
        let Some(column_ref) = state.out.expressions[expr as usize].column_ref() else { return false };
        let column_name = column_ref.column_name.column_name.text.clone();
        let alias = column_ref.column_name.table_alias.as_ref().map(|a| a.text.clone());
        let scope = &state.out.name_scopes[target as usize];

        if let Some(alias) = alias {
            if let Some(table) = scope.referenced_tables_by_name.get(&alias) {
                let resolution = Self::resolve_column(state, table, &column_name);
                if resolution.is_resolved() {
                    state.out.expressions[expr as usize].column_ref_mut().unwrap().resolved = resolution;
                    return true;
                }
            }
            return false;
        }

        // No table alias, scan all tables for the column and check for ambiguity
        let mut candidates = Vec::new();
        for (table_name, table) in scope.referenced_tables_by_name.iter() {
            let resolution = Self::resolve_column(state, table, &column_name);
            if resolution.is_resolved() {
                candidates.push((table_name.clone(), resolution));
            }
        }
        match candidates.len() {
            0 => false,
            1 => {
                state.out.expressions[expr as usize].column_ref_mut().unwrap().resolved = candidates[0].1;
                true
            }
            _ => {
                let mut message = String::from("column reference is ambiguous, candidates: ");
                for (i, (table_name, _)) in candidates.iter().enumerate() {
                    if i > 0 {
                        message.push_str(", ");
                    }
                    message.push_str(&quote_identifier(table_name));
                    message.push('.');
                    message.push_str(&quote_identifier(&column_name));
                }
                let node_id = state.out.expressions[expr as usize].ast_node_id;
                state.add_error(AnalyzerErrorType::COLUMN_REF_AMBIGUOUS, AnalyzerErrorSeverity::ERROR, node_id, message);
                false
            }
        }
    }

    /// Try to resolve a column ref against the output columns of a scope (`TryResolveColumnFromOutputs`)
    fn try_resolve_column_from_outputs(state: &mut AnalysisState, expr: ExprId, target: ScopeId) -> bool {
        let Some(column_ref) = state.out.expressions[expr as usize].column_ref() else { return false };
        if column_ref.column_name.table_alias.is_some() {
            return false;
        }
        let scope = &state.out.name_scopes[target as usize];
        match scope.output_columns_by_name.get(&column_ref.column_name.column_name.text) {
            Some(&column) => {
                state.out.expressions[expr as usize].column_ref_mut().unwrap().resolved = ColumnResolution::ScopeColumn {
                    scope: target,
                    column: column as u32,
                };
                true
            }
            None => false,
        }
    }

    fn is_unresolved_column_ref(state: &AnalysisState, expr: ExprId) -> bool {
        state.out.expressions[expr as usize].column_ref().is_some_and(|c| !c.resolved.is_resolved())
    }

    /// Resolve column refs against the tables of the own scope (`ResolveColumnRefsLocally`)
    fn resolve_column_refs_locally(state: &mut AnalysisState, scope: ScopeId) {
        let exprs = state.out.name_scopes[scope as usize].expressions.clone();
        for expr in exprs {
            if Self::is_unresolved_column_ref(state, expr) {
                Self::try_resolve_column_in_scope(state, expr, scope);
            }
        }
    }

    /// Resolve column refs against the output columns of child scopes (`ResolveColumnRefsFromChildOutputs`)
    fn resolve_column_refs_from_child_outputs(state: &mut AnalysisState, scope: ScopeId) {
        let s = &state.out.name_scopes[scope as usize];
        if s.child_output_resolution_barrier {
            return;
        }
        let exprs = s.expressions.clone();
        let children = s.child_scopes.clone();
        for expr in exprs {
            if !Self::is_unresolved_column_ref(state, expr) {
                continue;
            }
            if state.out.expressions[expr as usize].column_ref().unwrap().column_name.table_alias.is_some() {
                continue;
            }
            for &child in &children {
                if Self::try_resolve_column_from_outputs(state, expr, child) {
                    break;
                }
            }
        }
    }

    /// Resolve column refs by walking up the parent scopes (`ResolveColumnRefsFromParents`)
    fn resolve_column_refs_from_parents(state: &mut AnalysisState, scope: ScopeId) {
        let s = &state.out.name_scopes[scope as usize];
        if s.column_correlation_barrier {
            return;
        }
        let exprs = s.expressions.clone();
        let parent = s.parent_scope;
        for expr in exprs {
            if !Self::is_unresolved_column_ref(state, expr) {
                continue;
            }
            Self::resolve_from_parent_chain(state, expr, parent);
        }
    }

    /// Try the parent scopes of a scope in order, stopping at correlation barriers
    fn resolve_from_parent_chain(state: &mut AnalysisState, expr: ExprId, mut target: Option<ScopeId>) -> bool {
        while let Some(t) = target {
            if Self::try_resolve_column_in_scope(state, expr, t) {
                return true;
            }
            let ts = &state.out.name_scopes[t as usize];
            if ts.column_correlation_barrier {
                break;
            }
            target = ts.parent_scope;
        }
        false
    }

    /// Attach parsed CTE definitions to a scope (`AttachCTEs`)
    fn attach_ctes(state: &mut AnalysisState, scope: ScopeId, ctes: Vec<CteDefinition>) {
        for cte in ctes {
            let Some(&child_scope) = state.out.name_scopes_by_root_node.get(&cte.select_node_id) else { continue };
            let mut column_aliases = Vec::new();
            if cte.columns_count > 0 {
                let columns = &state.ast[cte.columns_node_id as usize];
                for ci in 0..cte.columns_count as u32 {
                    let column = &state.ast[(columns.children_begin_or_value() + ci) as usize];
                    if column.node_type() == NodeType::NAME {
                        column_aliases.push(state.node_name(column));
                    }
                }
            }
            let definition = ResolvedCte {
                cte_name: cte.cte_name.clone(),
                child_scope: Some(child_scope),
                definition_node_id: cte.ast_node_id,
                column_aliases,
            };
            let s = &mut state.out.name_scopes[scope as usize];
            s.cte_definitions.insert(cte.cte_name.text.clone(), definition);
            s.cte_definition_nodes.entry(cte.cte_name.text.clone()).or_insert(cte.ast_node_id);
        }
    }

    /// Look up an alias in a scope and its parents (`LookupAliasInScopeChain`)
    fn lookup_alias_in_scope_chain(state: &AnalysisState, scope: ScopeId, alias: &str) -> Option<ReferencedTable> {
        let mut s = Some(scope);
        while let Some(sid) = s {
            let candidate = &state.out.name_scopes[sid as usize];
            if let Some(table) = candidate.referenced_tables_by_name.get(alias) {
                return Some(table.clone());
            }
            s = candidate.parent_scope;
        }
        None
    }

    /// Resolve qualified column refs whose qualifier is not a table in scope as field accesses of
    /// row-typed columns (`ResolveRowFieldAccesses`)
    fn resolve_row_field_accesses(state: &mut AnalysisState, scope: ScopeId) {
        let exprs = state.out.name_scopes[scope as usize].expressions.clone();
        for expr in exprs {
            let Some(column_ref) = state.out.expressions[expr as usize].column_ref() else { continue };
            if column_ref.resolved.is_resolved() {
                continue;
            }
            let Some(qualifier) = column_ref.column_name.table_alias.clone() else { continue };
            if Self::lookup_alias_in_scope_chain(state, scope, &qualifier.text).is_some() {
                continue;
            }
            // In p.x, p is not a table in scope but may be a row-typed column with a field x
            let qualified = column_ref.column_name.clone();
            {
                let column_ref = state.out.expressions[expr as usize].column_ref_mut().unwrap();
                column_ref.column_name.table_alias = None;
                column_ref.column_name.column_name = qualifier.clone();
            }
            let mut resolved = Self::try_resolve_column_in_scope(state, expr, scope);
            let s = &state.out.name_scopes[scope as usize];
            if !resolved && !s.child_output_resolution_barrier {
                for child in s.child_scopes.clone() {
                    resolved = Self::try_resolve_column_from_outputs(state, expr, child);
                    if resolved {
                        break;
                    }
                }
            }
            let s = &state.out.name_scopes[scope as usize];
            if !resolved && !s.column_correlation_barrier {
                resolved = Self::resolve_from_parent_chain(state, expr, s.parent_scope);
            }
            if resolved {
                state.tag(&qualifier, NameTag::COLUMN_NAME);
            } else {
                state.out.expressions[expr as usize].column_ref_mut().unwrap().column_name = qualified;
            }
        }
    }

    /// Associate still-unresolved column refs with unresolved tables in scope (`AssociateUnresolvedColumns`)
    fn associate_unresolved_columns(state: &mut AnalysisState, scope: ScopeId) {
        let s = &state.out.name_scopes[scope as usize];
        // The unresolved relations of this scope in FROM order
        let mut local_unresolved = Vec::new();
        for &table_ref_id in &s.table_references {
            let table_ref = &state.out.table_references[table_ref_id as usize];
            let Some(relation) = &table_ref.inner else { continue };
            if relation.resolved_table.is_some() {
                continue;
            }
            // Skip tables that lost a duplicate alias to an earlier one
            let alias = Self::table_ref_alias(table_ref, &relation.table_name.table_name.text);
            let Some(ReferencedTable::Unresolved(rel)) = s.referenced_tables_by_name.get(&alias) else { continue };
            if rel.table_ref != table_ref_id {
                continue;
            }
            local_unresolved.push(InferenceCandidate {
                table_name: rel.table_name.clone(),
                table_ref: rel.table_ref,
            });
        }

        for expr in s.expressions.clone() {
            let expression = &state.out.expressions[expr as usize];
            let Some(column_ref) = expression.column_ref() else { continue };
            if column_ref.resolved.is_resolved() || column_ref.inferred.is_some() {
                continue;
            }
            let column_name = column_ref.column_name.column_name.clone();
            let constraint = match &column_ref.column_name.table_alias {
                // Alias-qualified, the owner is pinned to whatever the alias refers to
                Some(alias) => {
                    let Some(ReferencedTable::Unresolved(rel)) = Self::lookup_alias_in_scope_chain(state, scope, &alias.text)
                    else {
                        continue;
                    };
                    InferenceConstraint {
                        kind: InferenceConstraintKind::Forced,
                        expression_id: expression.expression_id,
                        column_name,
                        candidates: vec![InferenceCandidate {
                            table_name: rel.table_name.clone(),
                            table_ref: rel.table_ref,
                        }],
                    }
                }
                // Unqualified, the candidates are the unresolved tables in scope
                None => {
                    if local_unresolved.is_empty() {
                        continue;
                    }
                    InferenceConstraint {
                        kind: if local_unresolved.len() == 1 {
                            InferenceConstraintKind::Forced
                        } else {
                            InferenceConstraintKind::Disjunctive
                        },
                        expression_id: expression.expression_id,
                        column_name,
                        candidates: local_unresolved.clone(),
                    }
                }
            };
            state.out.inference_constraints.push(constraint);
        }
    }

    /// Populate the output columns of a scope from its result targets (`PopulateOutputColumns`)
    fn populate_output_columns(state: &mut AnalysisState, scope: ScopeId) {
        let scope_node = &state.ast[state.out.name_scopes[scope as usize].ast_node_id as usize];
        let [combine_inputs] = attrs!(state.children(scope_node), [K::SQL_COMBINE_INPUT]);
        if let Some(combine_inputs) = combine_inputs.filter(|n| n.children_count() > 0) {
            // Set operations expose the column names of the left input
            if let Some(&left) = state.out.name_scopes_by_root_node.get(&combine_inputs.children_begin_or_value()) {
                let left_scope = &state.out.name_scopes[left as usize];
                let (columns, by_name) = (left_scope.output_columns.clone(), left_scope.output_columns_by_name.clone());
                let s = &mut state.out.name_scopes[scope as usize];
                s.output_columns = columns;
                s.output_columns_by_name = by_name;
            }
        }
        let mut result_targets = std::mem::take(&mut state.out.name_scopes[scope as usize].result_targets);
        for rt in result_targets.iter_mut() {
            let mut new_columns: Vec<ScopeColumn> = Vec::new();
            if rt.is_star {
                // Deliberately fuzzy: forward all columns of all table references
                let s = &state.out.name_scopes[scope as usize];
                for &table_ref_id in &s.table_references {
                    let table_ref = &state.out.table_references[table_ref_id as usize];
                    let Some(relation) = &table_ref.inner else { continue };
                    let alias = Self::table_ref_alias(table_ref, &relation.table_name.table_name.text);
                    match s.referenced_tables_by_name.get(&alias) {
                        None => {}
                        Some(ReferencedTable::Table(loc)) => {
                            if let Some(table) = state.table(*loc) {
                                for (ci, column) in table.table_columns.iter().enumerate() {
                                    new_columns.push(ScopeColumn {
                                        column_name: column.column_name.clone(),
                                        source: ScopeColumnSource::TableColumn(ColumnLoc {
                                            table: *loc,
                                            column: ci as u32,
                                        }),
                                    });
                                }
                            }
                        }
                        // An unresolved relation has an unknown schema
                        Some(ReferencedTable::Unresolved(_)) => {}
                        Some(ReferencedTable::Cte(loc)) => {
                            let cte = state.out.name_scopes[loc.scope as usize].cte_definitions.at(loc.index as usize);
                            if let Some(child) = cte.child_scope {
                                for (i, column) in state.out.name_scopes[child as usize].output_columns.iter().enumerate() {
                                    let mut column = column.clone();
                                    if let Some(alias) = cte.column_aliases.get(i) {
                                        column.column_name = alias.clone();
                                    }
                                    new_columns.push(column);
                                }
                            }
                        }
                    }
                }
                // Skip names that are already output columns
                let s = &mut state.out.name_scopes[scope as usize];
                for column in new_columns {
                    if s.output_columns_by_name.contains_key(&column.column_name.text) {
                        continue;
                    }
                    s.output_columns_by_name.insert(column.column_name.text.clone(), s.output_columns.len());
                    s.output_columns.push(column);
                }
            } else {
                let mut expr = rt.expression_id;
                if expr.is_none() {
                    let rt_node = &state.ast[rt.ast_node_id as usize];
                    let [value] = attrs!(state.children(rt_node), [K::SQL_RESULT_TARGET_VALUE]);
                    if let Some(value) = value {
                        expr = state.expression_of(state.node_id(value));
                        if expr.is_some() {
                            rt.expression_id = expr;
                        }
                    }
                }
                let Some(expr) = expr else { continue };
                let name = rt.column_name.clone().unwrap_or_else(|| state.empty_name());
                let s = &mut state.out.name_scopes[scope as usize];
                if !name.text.is_empty() {
                    if s.output_columns_by_name.contains_key(&name.text) {
                        continue;
                    }
                    s.output_columns_by_name.insert(name.text.clone(), s.output_columns.len());
                }
                s.output_columns.push(ScopeColumn {
                    column_name: name,
                    source: ScopeColumnSource::Expression(expr),
                });
            }
        }
        state.out.name_scopes[scope as usize].result_targets = result_targets;
    }

    /// Resolve all names (`ResolveNames`)
    fn resolve_names(&mut self, state: &mut AnalysisState) {
        let roots = self.root_scopes.values.clone();

        // Pass 1, bottom-up: resolve table refs, resolve column refs locally and from child outputs,
        // then populate the output columns for the parent
        let mut dfs: Vec<(ScopeId, bool)> = roots.iter().map(|&r| (r, false)).collect();
        while let Some(top) = dfs.last_mut() {
            let scope = top.0;
            if !top.1 {
                top.1 = true;
                // Push children in reverse order so that earlier siblings are processed first
                let children = state.out.name_scopes[scope as usize].child_scopes.clone();
                dfs.extend(children.iter().rev().map(|&c| (c, false)));
            } else {
                dfs.pop();
                Self::resolve_table_refs_in_scope(state, scope);
                Self::resolve_column_refs_locally(state, scope);
                Self::resolve_column_refs_from_child_outputs(state, scope);
                Self::populate_output_columns(state, scope);
            }
        }

        // Pass 2, top-down: resolve the remaining column refs through the parent scopes
        let mut dfs: Vec<ScopeId> = roots.clone();
        while let Some(scope) = dfs.pop() {
            // Recursive CTE outputs are available only after the bottom-up pass
            for expr in state.out.name_scopes[scope as usize].expressions.clone() {
                if !Self::is_unresolved_column_ref(state, expr) {
                    continue;
                }
                let node_id = state.out.expressions[expr as usize].ast_node_id;
                let ambiguous = state
                    .out
                    .errors
                    .iter()
                    .any(|e| e.error_type == AnalyzerErrorType::COLUMN_REF_AMBIGUOUS && e.ast_node_id == node_id);
                if !ambiguous {
                    Self::try_resolve_column_in_scope(state, expr, scope);
                }
            }
            Self::resolve_column_refs_from_parents(state, scope);
            Self::resolve_row_field_accesses(state, scope);
            dfs.extend(state.out.name_scopes[scope as usize].child_scopes.iter().copied());
        }

        // Pass 3: associate the remaining unresolved columns with unresolved tables, in scope order
        for scope in 0..state.out.name_scopes.len() {
            Self::associate_unresolved_columns(state, scope as ScopeId);
        }
    }

    /// Is the node nested inside syntax-only property graph syntax?
    fn is_inside_graph_syntax(state: &AnalysisState, ast_node_id: u32) -> bool {
        let mut node_id = ast_node_id;
        for _ in 0..state.ast.len() {
            let parent = state.ast[node_id as usize].parent();
            if parent as usize >= state.ast.len() {
                return false;
            }
            match state.ast[parent as usize].node_type() {
                NodeType::OBJECT_SQL_PROPERTY_GRAPH | NodeType::OBJECT_SQL_GRAPH_TABLE => return true,
                _ => node_id = parent,
            }
        }
        false
    }

    pub fn visit(&mut self, state: &mut AnalysisState, morsel: Range<usize>) {
        for node_id in morsel {
            let node = &state.ast[node_id];
            let mut node_state = std::mem::take(&mut self.node_states[node_id]);
            self.visit_node(state, node, node_id as u32, &mut node_state);
            self.node_states[node_id] = node_state;
        }
    }

    fn visit_node(&mut self, state: &mut AnalysisState, node: &Node, node_id: u32, node_state: &mut NodeState) {
        match node.node_type() {
            NodeType::OBJECT_SQL_COLUMN_DEF => {
                let parent = node.parent() as usize;
                if parent < state.ast.len() {
                    // Fields of descriptors and row types are not table columns
                    let key = state.ast[parent].attribute_key();
                    if key == K::SQL_DESCRIPTOR_COLUMNS || key == K::SQL_ROW_TYPE_FIELDS {
                        return;
                    }
                }
                let [name] = attrs!(state.children(node), [K::SQL_COLUMN_DEF_NAME]);
                if let Some(name) = name.filter(|n| n.node_type() == NodeType::NAME) {
                    let name = state.node_name(name);
                    state.tag(&name, NameTag::COLUMN_NAME);
                    node_state.table_columns.push(PendingColumn {
                        ast_node_id: node_id,
                        column_name: name,
                    });
                }
            }

            NodeType::OBJECT_SQL_COLUMN_REF => {
                if Self::is_inside_graph_syntax(state, node_id) {
                    return;
                }
                let [path] = attrs!(state.children(node), [K::SQL_COLUMN_REF_PATH]);
                if let Some(column_name) = state.read_qualified_column_name(path) {
                    let column_ref = ColumnRef {
                        column_name,
                        ast_scope_root: None,
                        resolved: ColumnResolution::Unresolved,
                        resolved_ids: None,
                        inferred: None,
                    };
                    let expr = state.add_expression(node_id, *node.symbol_span(), ExpressionInner::ColumnRef(column_ref));
                    node_state.column_references.push(expr);
                    state.expression_index[node_id as usize] = Some(expr);
                    state.mark(node_id, SemanticNodeMarkerType::COLUMN_REFERENCE);
                }
                // Column refs may be recursive
                self.merge_child_states(node_state, node);
            }

            NodeType::OBJECT_SQL_TABLEREF => {
                if Self::is_inside_graph_syntax(state, node_id) {
                    return;
                }
                let [name_node, alias_node] = attrs!(state.children(node), [K::SQL_TABLEREF_NAME, K::SQL_TABLEREF_ALIAS]);
                // Only consider table refs with a name for now
                if let Some(name) = state.read_qualified_table_name(name_node) {
                    let mut alias = None;
                    if let Some(alias_node) = alias_node.filter(|n| n.node_type() == NodeType::NAME) {
                        let a = state.node_name(alias_node);
                        state.tag(&a, NameTag::TABLE_ALIAS);
                        alias = Some((a, *alias_node.symbol_span()));
                    }
                    let id = state.out.table_references.len() as TableRefId;
                    state.out.table_references.push(TableReference {
                        table_reference_id: ExternalObjectId::new(state.entry_id, id),
                        ast_node_id: node_id,
                        location: Some(*node.symbol_span()),
                        ast_statement_id: None,
                        ast_scope_root: None,
                        alias,
                        inner: Some(RelationExpression {
                            table_name: name,
                            resolved_table: None,
                            resolved_alternatives: Vec::new(),
                        }),
                        role: TableRole::Read,
                    });
                    node_state.table_references.push(id);
                    state.mark(node_id, SemanticNodeMarkerType::TABLE_REFERENCE);
                }
                // Table refs may be recursive
                self.merge_child_states(node_state, node);
            }

            NodeType::OBJECT_SQL_RESULT_TARGET => {
                if Self::is_inside_graph_syntax(state, node_id) {
                    return;
                }
                self.merge_child_states(node_state, node);
                let [value, name, star] = attrs!(state.children(node), [
                    K::SQL_RESULT_TARGET_VALUE,
                    K::SQL_RESULT_TARGET_NAME,
                    K::SQL_RESULT_TARGET_STAR,
                ]);
                let mut rt = ResultTarget {
                    ast_node_id: node_id,
                    ..Default::default()
                };
                if star.is_some() {
                    rt.is_star = true;
                } else {
                    if let Some(name) = name.filter(|n| n.node_type() == NodeType::NAME) {
                        rt.column_name = Some(state.node_name(name));
                    }
                    if let Some(expr) = value.and_then(|v| state.expression_of(state.node_id(v))) {
                        rt.expression_id = Some(expr);
                        if rt.column_name.is_none() {
                            if let Some(column_ref) = state.out.expressions[expr as usize].column_ref() {
                                rt.column_name = Some(column_ref.column_name.column_name.clone());
                            }
                        }
                    }
                }
                node_state.result_targets.push(rt);
            }

            NodeType::OBJECT_SQL_CTE => {
                let [name, columns, statement] =
                    attrs!(state.children(node), [K::SQL_CTE_NAME, K::SQL_CTE_COLUMNS, K::SQL_CTE_STATEMENT]);
                self.merge_child_states(node_state, node);
                if let (Some(name), Some(statement)) = (name.filter(|n| n.node_type() == NodeType::NAME), statement) {
                    node_state.ctes.push(CteDefinition {
                        cte_name: state.node_name(name),
                        select_node_id: state.node_id(statement),
                        columns_node_id: columns.map(|c| state.node_id(c)).unwrap_or(0),
                        columns_count: columns.map(|c| c.children_count() as u16).unwrap_or(0),
                        ast_node_id: node_id,
                    });
                }
            }

            NodeType::OBJECT_SQL_SELECT => {
                if Self::is_inside_graph_syntax(state, node_id) {
                    return;
                }
                self.merge_child_states(node_state, node);
                let result_targets = std::mem::take(&mut node_state.result_targets);
                let ctes = std::mem::take(&mut node_state.ctes);
                let scope = self.create_scope(state, node_state, node_id);
                let [recursive] = attrs!(state.children(node), [K::SQL_SELECT_WITH_RECURSIVE]);
                {
                    let s = &mut state.out.name_scopes[scope as usize];
                    s.result_targets.extend(result_targets);
                    // Completion needs the declaration order and the recursive visibility of CTEs
                    s.ctes_recursive = recursive.is_some();
                }
                Self::attach_ctes(state, scope, ctes);
                let [into] = attrs!(state.children(node), [K::SQL_SELECT_INTO]);
                if let Some(into) = into.filter(|n| n.node_type() == NodeType::OBJECT_SQL_INTO) {
                    let [into_name] = attrs!(state.children(into), [K::SQL_TEMP_NAME]);
                    self.register_derived_table(state, into, into_name, None, node);
                }
            }

            NodeType::OBJECT_SQL_INSERT => {
                let [target, columns, source, default_values, returning, recursive] = attrs!(state.children(node), [
                    K::SQL_INSERT_TARGET,
                    K::SQL_INSERT_COLUMNS,
                    K::SQL_INSERT_SOURCE,
                    K::SQL_INSERT_DEFAULT_VALUES,
                    K::SQL_INSERT_RETURNING,
                    K::SQL_SELECT_WITH_RECURSIVE,
                ]);
                let target_ref = target.and_then(|t| self.node_states[state.node_id(t) as usize].table_references.first().copied());
                let Some(target_ref) = target_ref else {
                    self.merge_child_states(node_state, node);
                    return;
                };
                state.out.table_references[target_ref as usize].role = TableRole::Write;

                self.merge_child_states(node_state, node);
                let result_targets = std::mem::take(&mut node_state.result_targets);
                let ctes = std::mem::take(&mut node_state.ctes);
                let scope = self.create_scope(state, node_state, node_id);
                {
                    let s = &mut state.out.name_scopes[scope as usize];
                    s.result_targets.extend(result_targets);
                    s.ctes_recursive = recursive.is_some();
                    s.child_output_resolution_barrier = true;
                }
                Self::attach_ctes(state, scope, ctes);
                if let Some(source) = source {
                    if let Some(&source_scope) = state.out.name_scopes_by_root_node.get(&state.node_id(source)) {
                        state.out.name_scopes[source_scope as usize].column_correlation_barrier = true;
                    }
                }
                self.set_cte_correlation_barriers(state, scope);

                let mut insert = InsertStatement {
                    ast_node_id: node_id,
                    ast_statement_id: Some(state.find_statement_id(node_id)),
                    target: target_ref,
                    source_ast_node_id: source.map(|s| state.node_id(s)),
                    default_values: default_values.is_some(),
                    returning: returning.is_some(),
                    target_columns: Vec::new(),
                };
                if let Some(columns) = columns.filter(|n| n.node_type() == NodeType::ARRAY) {
                    for column in state.children(columns) {
                        if column.node_type() != NodeType::NAME {
                            continue;
                        }
                        let name = state.node_name(column);
                        state.tag(&name, NameTag::COLUMN_NAME);
                        insert.target_columns.push(InsertTargetColumn {
                            ast_node_id: state.node_id(column),
                            column_name: name,
                            resolved: None,
                        });
                    }
                }
                state.out.insert_statements.push(insert);
            }

            NodeType::OBJECT_SQL_DELETE => {
                let [target, recursive] = attrs!(state.children(node), [K::SQL_DELETE_TARGET, K::SQL_SELECT_WITH_RECURSIVE]);
                if let Some(target) = target {
                    for &table_ref in &self.node_states[state.node_id(target) as usize].table_references {
                        state.out.table_references[table_ref as usize].role = TableRole::Write;
                    }
                }
                self.merge_child_states(node_state, node);
                let result_targets = std::mem::take(&mut node_state.result_targets);
                let ctes = std::mem::take(&mut node_state.ctes);
                let scope = self.create_scope(state, node_state, node_id);
                {
                    let s = &mut state.out.name_scopes[scope as usize];
                    s.result_targets.extend(result_targets);
                    s.ctes_recursive = recursive.is_some();
                    s.child_output_resolution_barrier = true;
                }
                Self::attach_ctes(state, scope, ctes);
                // CTE definitions cannot correlate to the DELETE target or USING relations
                self.set_cte_correlation_barriers(state, scope);
            }

            NodeType::OBJECT_VIS_VISUALISE => {
                self.merge_child_states(node_state, node);
                self.create_scope(state, node_state, node_id);
            }

            NodeType::OBJECT_SQL_CREATE => {
                if Self::is_explain(state, state.find_statement_id(node_id)) {
                    self.merge_child_states(node_state, node);
                    self.create_scope(state, node_state, node_id);
                    return;
                }
                let [name_node, elements] =
                    attrs!(state.children(node), [K::SQL_CREATE_TABLE_NAME, K::SQL_CREATE_TABLE_ELEMENTS]);
                let Some(table_name) = state.read_qualified_table_name(name_node) else { return };
                let schema_id = Self::register_schema(state, &table_name.database_name, &table_name.schema_name);
                let index = state.out.entry.table_declarations.len() as u32;
                let table_id = ExternalObjectId::new(state.entry_id, index);
                // Only the elements are merged
                if let Some(elements) = elements {
                    let elements_id = state.node_id(elements) as usize;
                    node_state.merge(&mut self.node_states[elements_id]);
                }
                let mut columns = std::mem::take(&mut node_state.table_columns);
                // Sort the columns by name.
                // The C++ pass uses the unstable std::sort, duplicate names may be ordered differently.
                columns.sort_by(|l, r| l.column_name.text.as_bytes().cmp(r.column_name.text.as_bytes()));
                self.create_scope(state, node_state, node_id);

                let name = table_name.table_name.clone();
                let mut table = TableDeclaration::new(schema_id, table_id, table_name);
                table.ast_node_id = Some(node_id);
                table.ast_statement_id = Some(state.find_statement_id(node_id));
                for (column_index, column) in columns.iter().enumerate() {
                    table.table_columns_by_name.entry(column.column_name.text.clone()).or_insert(column_index);
                    table.table_columns.push(TableColumn {
                        object_id: QualifiedCatalogObjectId::table_column(table_id, column_index as u32),
                        table: Some(table_id),
                        ast_node_id: Some(column.ast_node_id),
                        column_name: column.column_name.clone(),
                    });
                }
                state.out.entry.table_declarations.push(table);
                state.resolve_name(&name, NameObject::Table(index));
                for (column_index, column) in columns.iter().enumerate() {
                    let loc = ColumnLoc {
                        table: TableLoc::from(table_id),
                        column: column_index as u32,
                    };
                    state.resolve_name(&column.column_name, NameObject::Column(loc));
                }
            }

            NodeType::OBJECT_SQL_CREATE_FUNCTION => {
                if Self::is_explain(state, state.find_statement_id(node_id)) {
                    self.merge_child_states(node_state, node);
                    return;
                }
                let [name_node, params, returns, is_aggregate] = attrs!(state.children(node), [
                    K::SQL_CREATE_FUNCTION_NAME,
                    K::SQL_CREATE_FUNCTION_PARAMS,
                    K::SQL_CREATE_FUNCTION_RETURNS,
                    K::SQL_CREATE_FUNCTION_IS_AGGREGATE,
                ]);
                let Some(function_name) = state.read_qualified_function_name(name_node) else { return };
                let schema_id = Self::register_schema(state, &function_name.database_name, &function_name.schema_name);
                let index = state.out.entry.function_declarations.len() as u32;
                let function_id = ExternalObjectId::new(state.entry_id, index);
                let return_type: Arc<str> = returns.map(|r| Arc::from(state.text_at(*r.symbol_span()))).unwrap_or_else(|| Arc::from(""));
                let mut declaration = FunctionDeclaration {
                    object_id: QualifiedCatalogObjectId::function(function_id),
                    catalog_schema_id: schema_id,
                    is_aggregate: is_aggregate.is_some(),
                    ast_node_id: node_id,
                    ast_statement_id: None,
                    function_name: function_name.clone(),
                    params: Vec::new(),
                    return_type,
                };
                if let Some(params) = params.filter(|n| n.node_type() == NodeType::ARRAY) {
                    for param in state.children(params) {
                        if param.node_type() != NodeType::OBJECT_SQL_FUNCTION_PARAM {
                            continue;
                        }
                        let [param_name, param_type] =
                            attrs!(state.children(param), [K::SQL_FUNCTION_PARAM_NAME, K::SQL_FUNCTION_PARAM_TYPE]);
                        let Some(param_name) = param_name.filter(|n| n.node_type() == NodeType::NAME) else { continue };
                        let param_type = param_type.map(|t| state.text_at(*t.symbol_span())).unwrap_or("");
                        declaration.params.push(FunctionParam {
                            ast_node_id: Some(state.node_id(param)),
                            param_name: state.node_name(param_name),
                            param_type: Arc::from(param_type),
                        });
                    }
                }
                state.out.entry.function_declarations.push(declaration);
                state.tag(&function_name.function_name, NameTag::FUNCTION_NAME);
                state.resolve_name(&function_name.function_name, NameObject::Function(index));
            }

            NodeType::OBJECT_SQL_CREATE_AS | NodeType::OBJECT_SQL_VIEW => {
                let [name, columns, statement] = if node.node_type() == NodeType::OBJECT_SQL_CREATE_AS {
                    attrs!(state.children(node), [K::SQL_CREATE_AS_NAME, K::SQL_CREATE_AS_COLUMNS, K::SQL_CREATE_AS_STATEMENT])
                } else {
                    attrs!(state.children(node), [K::SQL_VIEW_NAME, K::SQL_VIEW_COLUMNS, K::SQL_VIEW_STATEMENT])
                };
                if let Some(statement) = statement.filter(|n| n.node_type() == NodeType::OBJECT_SQL_SELECT) {
                    self.register_derived_table(state, node, name, columns, statement);
                }
                self.merge_child_states(node_state, node);
            }

            NodeType::OBJECT_SQL_PROPERTY_GRAPH | NodeType::OBJECT_SQL_GRAPH_TABLE => {
                // Property graph analysis is syntax-only. Keep graph-local references in the
                // analyzed buffers, but prevent them from entering or affecting an SQL scope.
                self.merge_child_states(node_state, node);
                node_state.clear();
            }

            // By default, merge child states into the node state
            _ => self.merge_child_states(node_state, node),
        }
    }

    /// Mark the CTEs of a scope as correlation barriers
    fn set_cte_correlation_barriers(&self, state: &mut AnalysisState, scope: ScopeId) {
        let children: Vec<ScopeId> = state.out.name_scopes[scope as usize]
            .cte_definitions
            .iter()
            .filter_map(|(_, cte)| cte.child_scope)
            .collect();
        for child in children {
            state.out.name_scopes[child as usize].column_correlation_barrier = true;
        }
    }

    pub fn finish(&mut self, state: &mut AnalysisState) {
        // Index the tables and functions
        state.out.entry.index_declarations();

        // Assign statement ids to scopes before resolving ordered script-local names
        for i in 0..state.out.name_scopes.len() {
            let node_id = state.out.name_scopes[i].ast_node_id;
            state.out.name_scopes[i].ast_statement_id = state.find_statement_id(node_id);
        }

        // Resolve all names
        self.resolve_names(state);

        for pending in std::mem::take(&mut self.pending_derived_tables) {
            if let Some(&scope) = state.out.name_scopes_by_root_node.get(&pending.select_node_id) {
                Self::populate_derived_table(state, &pending, scope);
            }
        }

        // Assign statement ids, the objects are ordered by their AST nodes
        if !state.parsed.statements.is_empty() {
            let statements = &state.parsed.statements;
            let assign = |nodes: &mut dyn Iterator<Item = (u32, &mut Option<u32>)>| {
                let mut statement_id = 0usize;
                let mut statement_begin = statements[0].nodes_begin;
                let mut statement_end = statement_begin + statements[0].node_count;
                for (ast_node_id, statement) in nodes {
                    while statement_end <= ast_node_id && statement_id < statements.len() {
                        statement_id += 1;
                        if statement_id == statements.len() {
                            break;
                        }
                        statement_begin = statements[statement_id].nodes_begin;
                        statement_end = statement_begin + statements[statement_id].node_count;
                    }
                    if statement_id == statements.len() {
                        break;
                    }
                    if statement_begin <= ast_node_id {
                        *statement = Some(statement_id as u32);
                    }
                }
            };
            assign(&mut state.out.table_references.iter_mut().map(|r| (r.ast_node_id, &mut r.ast_statement_id)));
            assign(&mut state.out.expressions.iter_mut().map(|e| (e.ast_node_id, &mut e.ast_statement_id)));
            let mut scope_statements: Vec<Option<u32>> = vec![None; state.out.name_scopes.len()];
            assign(
                &mut state
                    .out
                    .name_scopes
                    .iter()
                    .zip(scope_statements.iter_mut())
                    .map(|(s, statement)| (s.ast_node_id, statement)),
            );
            for (scope, statement) in state.out.name_scopes.iter_mut().zip(scope_statements) {
                if let Some(statement) = statement {
                    scope.ast_statement_id = statement;
                }
            }
            assign(
                &mut state
                    .out
                    .entry
                    .function_declarations
                    .iter_mut()
                    .map(|f| (f.ast_node_id, &mut f.ast_statement_id)),
            );
        }

        // Index the columns of the table declarations
        state.out.entry.index_table_columns();

        // Solve the schema-inference constraints
        Self::run_schema_inference(state);
        Self::resolve_insert_target_columns(state);
        Self::compute_resolved_column_ids(state);
    }

    /// Bind explicit INSERT target columns after target-table resolution (`ResolveInsertTargetColumns`)
    fn resolve_insert_target_columns(state: &mut AnalysisState) {
        for i in 0..state.out.insert_statements.len() {
            let target = state.out.insert_statements[i].target;
            let Some(resolved) = state.out.table_references[target as usize].inner.as_ref().and_then(|r| r.resolved_table.as_ref()) else {
                continue;
            };
            let table_id = resolved.catalog_table_id.unpack_table_id();
            let table = if table_id.origin == state.entry_id {
                state.out.entry.table_by_id(table_id)
            } else {
                state.catalog.table_by_id(table_id)
            };
            let Some(table) = table else { continue };
            let resolved: Vec<Option<ColumnLoc>> = state.out.insert_statements[i]
                .target_columns
                .iter()
                .map(|c| {
                    table.table_columns_by_name.get(&c.column_name.text).map(|&column| ColumnLoc {
                        table: TableLoc::from(table_id),
                        column: column as u32,
                    })
                })
                .collect();
            for (column, resolved) in state.out.insert_statements[i].target_columns.iter_mut().zip(resolved) {
                if resolved.is_some() {
                    column.resolved = resolved;
                }
            }
        }
    }

    /// The catalog ids of a resolved column (`ColumnRef::GetResolvedColumnIDs`)
    fn resolved_column_ids(state: &AnalysisState, resolution: ColumnResolution) -> Option<ResolvedColumnIds> {
        let table_column_ids = |loc: ColumnLoc| {
            let table = state.table(loc.table)?;
            let column = table.table_columns.get(loc.column as usize)?;
            Some(ResolvedColumnIds {
                catalog_schema_id: table.catalog_schema_id,
                catalog_table_column_id: column.object_id,
                referenced_catalog_version: table.catalog_version,
            })
        };
        let mut current = resolution;
        for _ in 0..256 {
            match current {
                ColumnResolution::Unresolved => return None,
                ColumnResolution::TableColumn(loc) => return table_column_ids(loc),
                ColumnResolution::ScopeColumn { scope, column } => {
                    let column = state.out.name_scopes[scope as usize].output_columns.get(column as usize)?;
                    match column.source {
                        ScopeColumnSource::TableColumn(loc) => return table_column_ids(loc),
                        ScopeColumnSource::Expression(expr) => {
                            current = state.out.expressions[expr as usize].column_ref()?.resolved;
                        }
                    }
                }
            }
        }
        None
    }

    fn compute_resolved_column_ids(state: &mut AnalysisState) {
        for i in 0..state.out.expressions.len() {
            let Some(column_ref) = state.out.expressions[i].column_ref() else { continue };
            let ids = Self::resolved_column_ids(state, column_ref.resolved);
            state.out.expressions[i].column_ref_mut().unwrap().resolved_ids = ids;
        }
    }

    /// Solve the schema-inference constraints into inferred table schemas (`RunSchemaInference`)
    fn run_schema_inference(state: &mut AnalysisState) {
        let constraints = std::mem::take(&mut state.out.inference_constraints);
        if constraints.is_empty() {
            return;
        }
        let out = &mut state.out;

        fn get_or_create_schema(out: &mut super::AnalyzedScript, table_name: &QualifiedTableName) -> usize {
            let key = table_name.key();
            if let Some(&i) = out.inferred_table_schemas_by_name.get(&key) {
                return i;
            }
            out.inferred_table_schemas.push(InferredTableSchema {
                table_name: table_name.clone(),
                confidence: InferenceConfidence::None,
                columns: Vec::new(),
                columns_by_name: HashMap::new(),
            });
            let i = out.inferred_table_schemas.len() - 1;
            out.inferred_table_schemas_by_name.insert(key, i);
            i
        }
        fn add_column(schema: &mut InferredTableSchema, column: &Name, confidence: InferenceConfidence) -> usize {
            if let Some(&i) = schema.columns_by_name.get(&column.text) {
                let c = &mut schema.columns[i];
                c.confidence = c.confidence.max(confidence);
                schema.confidence = schema.confidence.max(confidence);
                return i;
            }
            let i = schema.columns.len();
            schema.columns_by_name.insert(column.text.clone(), i);
            schema.columns.push(InferredColumn {
                column_name: column.clone(),
                confidence,
                candidate_table_names: Vec::new(),
            });
            schema.confidence = schema.confidence.max(confidence);
            i
        }
        let has_confident_column = |out: &super::AnalyzedScript, table_name: &QualifiedTableName, column: &str| {
            let Some(&i) = out.inferred_table_schemas_by_name.get(&table_name.key()) else { return false };
            let schema = &out.inferred_table_schemas[i];
            schema
                .columns_by_name
                .get(column)
                .is_some_and(|&c| schema.columns[c].confidence == InferenceConfidence::Confident)
        };
        let write_owner = |out: &mut super::AnalyzedScript, expr: u32, owner: &InferenceCandidate, confidence| {
            if let Some(column_ref) = out.expressions.get_mut(expr as usize).and_then(|e| e.column_ref_mut()) {
                column_ref.inferred = Some(InferredOwner {
                    table_ref: owner.table_ref,
                    table_name: owner.table_name.clone(),
                    confidence,
                });
            }
        };

        let mut resolved = vec![false; constraints.len()];

        // Step 1: seed the forced constraints
        for (i, c) in constraints.iter().enumerate() {
            if c.kind == InferenceConstraintKind::Forced && !c.candidates.is_empty() {
                let candidate = &c.candidates[0];
                let schema = get_or_create_schema(out, &candidate.table_name);
                add_column(&mut out.inferred_table_schemas[schema], &c.column_name, InferenceConfidence::Confident);
                write_owner(out, c.expression_id, candidate, InferenceConfidence::Confident);
                resolved[i] = true;
            }
        }

        // Step 2: propagate over disjunctive constraints to a fixpoint. A disjunction is explained
        // when exactly one candidate confidently owns its column.
        let mut changed = true;
        while changed {
            changed = false;
            for (i, c) in constraints.iter().enumerate() {
                if resolved[i] || c.kind != InferenceConstraintKind::Disjunctive {
                    continue;
                }
                let owners: Vec<&InferenceCandidate> = c
                    .candidates
                    .iter()
                    .filter(|candidate| has_confident_column(out, &candidate.table_name, &c.column_name.text))
                    .collect();
                if owners.is_empty() {
                    continue;
                }
                // Several owners make the use ambiguous, record a best guess
                let confidence = if owners.len() == 1 {
                    InferenceConfidence::Confident
                } else {
                    InferenceConfidence::Candidate
                };
                write_owner(out, c.expression_id, owners[0], confidence);
                resolved[i] = true;
                changed = true;
            }
        }

        // Step 3: assign the residual disjunctions to the candidate with the most inferred columns
        for (i, c) in constraints.iter().enumerate() {
            if resolved[i] || c.kind != InferenceConstraintKind::Disjunctive {
                continue;
            }
            if c.candidates.is_empty() || c.candidates.len() > MAX_TABLE_REF_AMBIGUITY {
                resolved[i] = true;
                continue;
            }
            let mut best = 0;
            let mut best_columns = 0;
            for (ci, candidate) in c.candidates.iter().enumerate() {
                let n = out
                    .inferred_table_schemas_by_name
                    .get(&candidate.table_name.key())
                    .map(|&s| out.inferred_table_schemas[s].columns.len())
                    .unwrap_or(0);
                if n > best_columns {
                    best_columns = n;
                    best = ci;
                }
            }
            let schema = get_or_create_schema(out, &c.candidates[best].table_name);
            let schema = &mut out.inferred_table_schemas[schema];
            let column = add_column(schema, &c.column_name, InferenceConfidence::Candidate);
            for (ci, candidate) in c.candidates.iter().enumerate() {
                if ci != best {
                    schema.columns[column].candidate_table_names.push(candidate.table_name.clone());
                }
            }
            write_owner(out, c.expression_id, &c.candidates[best], InferenceConfidence::Candidate);
            resolved[i] = true;
        }
        state.out.inference_constraints = constraints;
    }
}
