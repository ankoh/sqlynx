#include "dashql/analyzer/name_resolution_pass.h"

#include <format>
#include <functional>
#include <optional>
#include <stack>
#include <variant>

#include "dashql/analyzer/analysis_state.h"
#include "dashql/analyzer/analyzer.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/catalog_object.h"
#include "dashql/external.h"
#include "dashql/script.h"
#include "dashql/utils/intrusive_list.h"

namespace dashql {

using AttributeKey = buffers::parser::AttributeKey;

/// Merge two node states
void NameResolutionPass::NodeState::Merge(NodeState&& other) {
    child_scopes.Append(std::move(other.child_scopes));
    table_columns.Append(std::move(other.table_columns));
    table_references.Append(std::move(other.table_references));
    column_references.Append(std::move(other.column_references));
    result_targets.Append(std::move(other.result_targets));
    ctes.Append(std::move(other.ctes));
}

/// Clear a node state
void NameResolutionPass::NodeState::Clear() {
    child_scopes.Clear();
    table_columns.Clear();
    table_references.Clear();
    column_references.Clear();
    result_targets.Clear();
    ctes.Clear();
}

ReferencedTable::ColumnResolution ReferencedTable::ResolveColumn(std::string_view column_name) const {
    if (auto* table_ref = std::get_if<std::reference_wrapper<const CatalogEntry::TableDeclaration>>(&source)) {
        auto& table = table_ref->get();
        auto it = table.table_columns_by_name.find(column_name);
        if (it != table.table_columns_by_name.end()) {
            return std::cref(it->second.get());
        }
        return {};
    }
    // An unresolved relation has an unknown schema: it can never resolve a column to a catalog or
    // scope column. The caller distinguishes "table in scope but unknown" from "not in scope" via
    // ReferencedTable::IsUnresolvedRelation().
    if (IsUnresolvedRelation()) {
        return {};
    }
    auto& cte = std::get<std::reference_wrapper<ResolvedCTE>>(source).get();
    if (!cte.child_scope) return {};
    auto* scope = cte.child_scope;
    size_t col_idx = std::string::npos;
    if (!cte.column_aliases.empty()) {
        for (size_t i = 0; i < cte.column_aliases.size(); ++i) {
            if (cte.column_aliases[i].get().text == column_name) {
                col_idx = i;
                break;
            }
        }
    } else {
        auto it = scope->output_columns_by_name.find(column_name);
        if (it != scope->output_columns_by_name.end()) {
            col_idx = it->second;
        }
    }
    if (col_idx != std::string::npos && col_idx < scope->output_columns.size()) {
        return std::cref(scope->output_columns[col_idx]);
    }
    return {};
}

/// Constructor
NameResolutionPass::NameResolutionPass(AnalysisState& state)
    : PassManager::LTRPass(state), node_states(state.ast.size()) {}

/// Register a schema
QualifiedCatalogObjectID NameResolutionPass::RegisterSchema(RegisteredName& database_name,
                                                            RegisteredName& schema_name) {
    // Register the database
    auto db_ref_iter = state.analyzed->databases_by_name.find({database_name});
    QualifiedCatalogObjectID db_id = QualifiedCatalogObjectID::Deferred();
    if (db_ref_iter == state.analyzed->databases_by_name.end()) {
        db_id = state.catalog.ReserveDatabaseId(database_name);
        auto& db =
            state.analyzed->database_references.PushBack(CatalogEntry::DatabaseReference{db_id, database_name, ""});
        state.analyzed->databases_by_name.insert({{database_name}, db});
        database_name.resolved_objects.PushBack(db.CastToBase());
    } else {
        db_id = db_ref_iter->second.get().object_id;
    }

    // Register the schema
    QualifiedCatalogObjectID schema_id = QualifiedCatalogObjectID::Deferred();
    auto schema_ref_iter = state.analyzed->schemas_by_qualified_name.find({database_name, schema_name});
    if (schema_ref_iter == state.analyzed->schemas_by_qualified_name.end()) {
        schema_id = state.catalog.ReserveSchemaId(database_name, schema_name, db_id);
        auto& schema = state.analyzed->schema_references.PushBack(
            CatalogEntry::SchemaReference{schema_id, database_name, schema_name});
        state.analyzed->schemas_by_qualified_name.insert({{database_name, schema_name}, schema});
        schema_name.resolved_objects.PushBack(schema.CastToBase());
    } else {
        schema_id = schema_ref_iter->second.get().object_id;
    }
    return schema_id;
}

void NameResolutionPass::RegisterDerivedTable(const buffers::parser::Node& declaration_node,
                                              const buffers::parser::Node* name_node,
                                              const buffers::parser::Node* columns_node,
                                              const buffers::parser::Node& select_node) {
    auto statement_id = FindStatementId(state.GetNodeId(declaration_node));
    // EXPLAIN describes a declaration; publishing it would create a phantom catalog producer.
    if (statement_id < state.parsed.statements.size() &&
        state.parsed.statements[statement_id].type == buffers::parser::StatementType::EXPLAIN) return;
    auto table_name = state.ReadQualifiedTableName(name_node);
    if (!table_name.has_value()) return;

    auto schema_id = RegisterSchema(table_name->database_name, table_name->schema_name);
    ExternalObjectID catalog_table_id{
        state.catalog_entry_id, static_cast<uint32_t>(state.analyzed->table_declarations.GetSize())};
    auto& table = state.analyzed->table_declarations.PushBack(
        AnalyzedScript::TableDeclaration(schema_id, catalog_table_id, table_name.value()));
    table.ast_node_id = state.GetNodeId(declaration_node);
    table.ast_statement_id = FindStatementId(*table.ast_node_id);
    table.ast_scope_root = state.GetNodeId(select_node);
    table_name->table_name.get().resolved_objects.PushBack(table);

    PendingDerivedTable pending{.table = table, .select_node_id = state.GetNodeId(select_node)};
    if (columns_node && columns_node->node_type() == buffers::parser::NodeType::ARRAY) {
        auto columns = state.ast.subspan(columns_node->children_begin_or_value(), columns_node->children_count());
        pending.column_aliases.reserve(columns.size());
        for (auto& column : columns) {
            if (column.node_type() != buffers::parser::NodeType::NAME) continue;
            auto& name = state.scanned.GetNames().At(column.children_begin_or_value());
            name.coarse_analyzer_tags |= buffers::analyzer::NameTag::COLUMN_NAME;
            pending.column_aliases.push_back(name);
        }
    }
    pending_derived_tables.push_back(std::move(pending));
}

void NameResolutionPass::PopulateDerivedTable(PendingDerivedTable& pending, AnalyzedScript::NameScope& scope) {
    auto* output_scope = &scope;
    if (output_scope->output_columns.empty() && !output_scope->child_scopes.IsEmpty()) {
        output_scope = static_cast<AnalyzedScript::NameScope*>(&*output_scope->child_scopes.begin());
    }
    std::vector<std::reference_wrapper<RegisteredName>> column_names;
    if (!pending.column_aliases.empty()) {
        size_t count = std::min(pending.column_aliases.size(), output_scope->output_columns.size());
        column_names.reserve(count);
        for (size_t i = 0; i < count; ++i) {
            column_names.push_back(pending.column_aliases[i]);
        }
    } else {
        column_names.reserve(output_scope->output_columns.size());
        for (auto& output : output_scope->output_columns) {
            if (output.column_name.get().text.empty()) continue;
            column_names.push_back(output.column_name);
        }
    }
    auto& table = pending.table.get();
    table.table_columns.reserve(column_names.size());
    for (size_t column_index = 0; column_index < column_names.size(); ++column_index) {
        table.table_columns.emplace_back(table.GetTableID(), column_index, std::nullopt, column_names[column_index]);
        auto& column = table.table_columns.back();
        column.table = table;
        column.column_name.get().resolved_objects.PushBack(column);
        table.table_columns_by_name.emplace(column.column_name.get().text, column);
    }
}

void NameResolutionPass::MergeChildStates(NodeState& dst,
                                          std::initializer_list<const buffers::parser::Node*> children) {
    for (const buffers::parser::Node* child : children) {
        if (!child) continue;
        dst.Merge(std::move(node_states[child - state.ast.data()]));
    }
}

void NameResolutionPass::MergeChildStates(NodeState& dst, const buffers::parser::Node& parent) {
    for (size_t i = 0; i < parent.children_count(); ++i) {
        auto child_id = parent.children_begin_or_value() + i;
        auto& child = node_states[child_id];
        dst.Merge(std::move(child));
    }
}

AnalyzedScript::NameScope& NameResolutionPass::CreateScope(NodeState& target, uint32_t scope_root) {
    auto& scope = state.analyzed->name_scopes.PushBack(
        AnalyzedScript::NameScope{.name_scope_id = state.analyzed->name_scopes.GetSize(),
                                  .ast_node_id = scope_root,
                                  .parent_scope = nullptr,
                                  .child_scopes = target.child_scopes.CastAsBase()});
    state.analyzed->name_scopes_by_root_node.insert({scope_root, scope});
    for (auto& child_scope : target.child_scopes) {
        child_scope.parent_scope = &scope;
        root_scopes.erase(&child_scope);
    }
    for (auto& ref : target.column_references) {
        assert(std::holds_alternative<AnalyzedScript::Expression::ColumnRef>(ref.inner));
        auto& column_ref = std::get<AnalyzedScript::Expression::ColumnRef>(ref.inner);
        column_ref.ast_scope_root = scope_root;
    }
    for (auto& ref : target.table_references) {
        ref.ast_scope_root = scope_root;
    }
    scope.table_references = target.table_references;
    scope.expressions = target.column_references;
    // Clear the target since we're starting a new scope now
    target.Clear();
    // Remember the child scope
    target.child_scopes.PushBack(scope);
    root_scopes.insert(&scope);
    return scope;
}

constexpr size_t MAX_TABLE_REF_AMBIGUITY = 100;

void NameResolutionPass::ResolveTableRefsInScope(AnalyzedScript::NameScope& scope) {
    // Helper to register a table-like source in scope
    auto register_in_scope = [&](const TableReference& table_ref, std::string_view alias, ReferencedTable entry) {
        auto resolved_iter = scope.referenced_tables_by_name.find(alias);
        if (resolved_iter != scope.referenced_tables_by_name.end()) {
            auto& error = state.analyzed->errors.emplace_back();
            error.error_type = buffers::analyzer::AnalyzerErrorType::DUPLICATE_TABLE_ALIAS;
            error.ast_node_id = table_ref.ast_node_id;
            auto sym_span = state.parsed.nodes[table_ref.ast_node_id].symbol_span();
            error.symbol_span = std::make_unique<buffers::parser::SymbolSpan>(sym_span);
            error.text_span = std::make_unique<buffers::parser::TextSpan>(state.scanned.ResolveTextSpan(sym_span));
            std::string tmp;
            std::string_view alias_text = alias;
            alias_text = quote_anyupper_fuzzy(alias_text, tmp);
            error.message = std::format("duplicate table alias {}", alias_text);
        } else {
            scope.referenced_tables_by_name.insert({alias, std::move(entry)});
        }
    };

    for (auto& table_ref : scope.table_references) {
        auto* rel_expr = std::get_if<AnalyzedScript::TableReference::RelationExpression>(&table_ref.inner);
        if (!rel_expr || rel_expr->resolved_table.has_value()) {
            continue;
        }

        auto table_name = rel_expr->table_name;
        std::string_view ref_name = table_name.table_name.get().text;

        // Check if the table ref matches a CTE definition in this or any parent scope.
        ResolvedCTE* matched_cte = nullptr;
        for (auto* s = &scope; s != nullptr; s = s->parent_scope) {
            auto cte_it = s->cte_definitions.find(ref_name);
            if (cte_it != s->cte_definitions.end()) {
                if (!s->ctes_recursive) {
                    auto& definition = state.ast[cte_it->second.definition_node_id];
                    auto definition_begin = definition.symbol_span().offset();
                    auto definition_end = definition_begin + definition.symbol_span().length();
                    auto reference_offset = state.ast[table_ref.ast_node_id].symbol_span().offset();
                    if (reference_offset <= definition_end) continue;
                }
                matched_cte = &cte_it->second;
                break;
            }
        }
        if (matched_cte && table_ref.role == TableReference::Role::Read) {
            std::string_view alias = table_ref.alias.has_value() ? table_ref.alias.value().first.get().text : ref_name;
            register_in_scope(table_ref, alias, ReferencedTable{.source = std::ref(*matched_cte)});
            continue;
        }

        // Try to resolve as a catalog table in the own script
        std::vector<std::reference_wrapper<const CatalogEntry::TableDeclaration>> resolved_tables;
        state.analyzed->ResolveTable(table_name, resolved_tables, MAX_TABLE_REF_AMBIGUITY);

        // Then resolve through the catalog
        if (resolved_tables.size() == 0) {
            state.catalog.ResolveTable(table_name, state.catalog_entry_id, resolved_tables, MAX_TABLE_REF_AMBIGUITY);
        }

        if (resolved_tables.size() > 0) {
            auto& best_match = resolved_tables.front().get();

            rel_expr->resolved_table = AnalyzedScript::TableReference::ResolvedTableEntry{
                .table_name = best_match.table_name,
                .catalog_schema_id = best_match.catalog_schema_id,
                .catalog_table_id = best_match.object_id,
                .referenced_catalog_version = best_match.catalog_version,
            };

            for (size_t i = 1; i < resolved_tables.size(); ++i) {
                auto& match = resolved_tables[i].get();
                rel_expr->resolved_alternatives.push_back({
                    .table_name = match.table_name,
                    .catalog_schema_id = match.catalog_schema_id,
                    .catalog_table_id = match.object_id,
                    .referenced_catalog_version = match.catalog_version,
                });
            }

            std::string_view alias = table_ref.alias.has_value() ? table_ref.alias.value().first.get().text
                                                                 : best_match.table_name.table_name.get().text;
            register_in_scope(table_ref, alias, ReferencedTable{.source = std::cref(best_match)});
            continue;
        }

        // The table is neither a CTE nor present in the catalog. Register it as an unresolved
        // relation so that columns used against it (e.g. `f.x`) can be associated for schema
        // inference. The alias (or the bare table name) acts as the in-scope key.
        std::string_view alias = table_ref.alias.has_value() ? table_ref.alias.value().first.get().text : ref_name;
        register_in_scope(table_ref, alias,
                          ReferencedTable{.source = UnresolvedRelation{std::ref(table_ref), table_name}});
    }
}

/// Try to resolve a column ref against a single scope's referenced_tables_by_name.
/// Returns true if the column name was found (even without a catalog entry).
static bool TryResolveColumnInScope(AnalyzedScript::Expression& expr, AnalyzedScript::NameScope& target_scope,
                                    AnalysisState& state) {
    auto& column_ref = std::get<AnalyzedScript::Expression::ColumnRef>(expr.inner);
    std::string_view column_name = column_ref.column_name.column_name.get();

    if (column_ref.column_name.table_alias.has_value()) {
        std::string_view table_alias = column_ref.column_name.table_alias->get();
        auto table_iter = target_scope.referenced_tables_by_name.find(table_alias);
        if (table_iter != target_scope.referenced_tables_by_name.end()) {
            auto result = table_iter->second.ResolveColumn(column_name);
            if (!std::holds_alternative<std::monostate>(result)) {
                column_ref.resolved = std::move(result);
                return true;
            }
        }
        return false;
    }

    // No table alias — scan all tables for the column, check for ambiguity
    std::vector<std::pair<std::string_view, ReferencedTable::ColumnResolution>> candidates;
    for (auto& [tbl_name, table] : target_scope.referenced_tables_by_name) {
        auto result = table.ResolveColumn(column_name);
        if (!std::holds_alternative<std::monostate>(result)) {
            candidates.emplace_back(tbl_name, std::move(result));
        }
    }
    if (candidates.size() > 1) {
        auto& error = state.analyzed->errors.emplace_back();
        error.error_type = buffers::analyzer::AnalyzerErrorType::COLUMN_REF_AMBIGUOUS;
        error.ast_node_id = expr.ast_node_id;
        auto sym_span = state.parsed.nodes[expr.ast_node_id].symbol_span();
        error.symbol_span = std::make_unique<buffers::parser::SymbolSpan>(sym_span);
        error.text_span = std::make_unique<buffers::parser::TextSpan>(state.scanned.ResolveTextSpan(sym_span));
        std::string out = "column reference is ambiguous, candidates: ";
        std::string tmp;
        for (size_t i = 0; i < candidates.size(); ++i) {
            if (i > 0) out += ", ";
            std::string_view tbl = candidates[i].first;
            tbl = quote_anyupper_fuzzy(tbl, tmp);
            out += tbl;
            out += ".";
            std::string_view col = column_name;
            col = quote_anyupper_fuzzy(col, tmp);
            out += col;
        }
        error.message = std::move(out);
    } else if (candidates.size() == 1) {
        column_ref.resolved = std::move(candidates.front().second);
        return true;
    }
    return false;
}

/// Try to resolve a column ref against a scope's output_columns.
/// Returns true if the column name was found.
static bool TryResolveColumnFromOutputs(AnalyzedScript::Expression& expr, AnalyzedScript::NameScope& target_scope) {
    auto& column_ref = std::get<AnalyzedScript::Expression::ColumnRef>(expr.inner);
    if (column_ref.column_name.table_alias.has_value()) return false;
    std::string_view column_name = column_ref.column_name.column_name.get();

    auto it = target_scope.output_columns_by_name.find(column_name);
    if (it != target_scope.output_columns_by_name.end()) {
        column_ref.resolved = std::cref(target_scope.output_columns[it->second]);
        return true;
    }
    return false;
}

void NameResolutionPass::ResolveColumnRefsLocally(AnalyzedScript::NameScope& scope) {
    for (auto& expr : scope.expressions) {
        if (auto col_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
            col_ref != nullptr && !col_ref->IsResolved()) {
            TryResolveColumnInScope(expr, scope, state);
        }
    }
}

void NameResolutionPass::ResolveColumnRefsFromChildOutputs(AnalyzedScript::NameScope& scope) {
    if (scope.child_output_resolution_barrier) return;
    for (auto& expr : scope.expressions) {
        if (auto col_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
            col_ref != nullptr && !col_ref->IsResolved()) {
            if (col_ref->column_name.table_alias.has_value()) continue;
            for (auto& child_node : scope.child_scopes) {
                auto& child_scope = *static_cast<AnalyzedScript::NameScope*>(&child_node);
                if (TryResolveColumnFromOutputs(expr, child_scope)) {
                    break;
                }
            }
        }
    }
}

void NameResolutionPass::ResolveColumnRefsFromParents(AnalyzedScript::NameScope& scope) {
    if (scope.column_correlation_barrier) return;
    for (auto& expr : scope.expressions) {
        if (auto col_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
            col_ref != nullptr && !col_ref->IsResolved()) {
            for (auto* target = scope.parent_scope; target != nullptr; target = target->parent_scope) {
                if (TryResolveColumnInScope(expr, *target, state)) {
                    break;
                }
                if (target->column_correlation_barrier) break;
            }
        }
    }
}

void NameResolutionPass::AttachCTEs(AnalyzedScript::NameScope& scope,
                                    IntrusiveList<AnalyzedScript::CTEDefinition>&& ctes) {
    for (auto& cte : ctes) {
        auto it = state.analyzed->name_scopes_by_root_node.find(cte.select_node_id);
        if (it == state.analyzed->name_scopes_by_root_node.end()) continue;
        auto& child_scope = it->second.get();
        ResolvedCTE def{
            .cte_name = cte.cte_name,
            .child_scope = &child_scope,
            .definition_node_id = cte.ast_node_id,
        };
        if (cte.columns_count > 0) {
            auto& cols_node = state.ast[cte.columns_node_id];
            for (uint16_t ci = 0; ci < cte.columns_count; ++ci) {
                auto& col_node = state.ast[cols_node.children_begin_or_value() + ci];
                if (col_node.node_type() == buffers::parser::NodeType::NAME) {
                    def.column_aliases.push_back(
                        state.scanned.GetNames().At(col_node.children_begin_or_value()));
                }
            }
        }
        scope.cte_definitions.emplace(cte.cte_name.get().text, std::move(def));
        scope.cte_definition_nodes.emplace(cte.cte_name.get().text, cte.ast_node_id);
    }
}

/// Look up an alias in a scope and its parents. Returns the matching ReferencedTable if found
/// (whether resolved, a CTE, or an unresolved relation), else nullptr.
static const ReferencedTable* LookupAliasInScopeChain(AnalyzedScript::NameScope& scope, std::string_view alias) {
    for (auto* s = &scope; s != nullptr; s = s->parent_scope) {
        auto it = s->referenced_tables_by_name.find(alias);
        if (it != s->referenced_tables_by_name.end()) {
            return &it->second;
        }
    }
    return nullptr;
}

void NameResolutionPass::ResolveRowFieldAccesses(AnalyzedScript::NameScope& scope) {
    for (auto& expr : scope.expressions) {
        auto* col_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
        if (col_ref == nullptr || col_ref->IsResolved() || !col_ref->column_name.table_alias.has_value()) continue;
        auto& qualifier = col_ref->column_name.table_alias->get();
        if (LookupAliasInScopeChain(scope, qualifier.text) != nullptr) continue;

        // In p.x, p is not a table in scope but may be a row-typed column with a field x.
        // We keep this reading only if p resolves as a column.
        auto qualified = col_ref->column_name;
        col_ref->column_name.table_alias = std::nullopt;
        col_ref->column_name.column_name = qualifier;
        bool resolved = TryResolveColumnInScope(expr, scope, state);
        if (!resolved && !scope.child_output_resolution_barrier) {
            for (auto& child_node : scope.child_scopes) {
                auto& child_scope = *static_cast<AnalyzedScript::NameScope*>(&child_node);
                if ((resolved = TryResolveColumnFromOutputs(expr, child_scope))) break;
            }
        }
        if (!resolved && !scope.column_correlation_barrier) {
            for (auto* target = scope.parent_scope; target != nullptr; target = target->parent_scope) {
                if ((resolved = TryResolveColumnInScope(expr, *target, state))) break;
                if (target->column_correlation_barrier) break;
            }
        }
        if (resolved) {
            qualifier.coarse_analyzer_tags |= buffers::analyzer::NameTag::COLUMN_NAME;
        } else {
            col_ref->column_name = qualified;
        }
    }
}

void NameResolutionPass::AssociateUnresolvedColumns(AnalyzedScript::NameScope& scope) {
    // Gather the unresolved relations visible directly in this scope. Unqualified columns can only
    // be owned by an unresolved table in their own scope (we do not pull in parents' unresolved
    // tables to keep the candidate domain tight). We iterate the ordered table_references list (not
    // the referenced_tables_by_name hash map) so the candidate order is deterministic (FROM order).
    std::vector<InferenceCandidate> local_unresolved;
    for (auto& table_ref : scope.table_references) {
        auto* rel_expr = std::get_if<AnalyzedScript::TableReference::RelationExpression>(&table_ref.inner);
        if (!rel_expr || rel_expr->resolved_table.has_value()) continue;
        // Confirm the alias maps to THIS table ref's unresolved relation. A table whose alias
        // collided with an earlier one was dropped as a DUPLICATE_TABLE_ALIAS, so its alias resolves
        // to the surviving ref — skip it here to avoid listing a table as its own ambiguity candidate.
        std::string_view alias = table_ref.alias.has_value() ? table_ref.alias.value().first.get().text
                                                             : rel_expr->table_name.table_name.get().text;
        auto it = scope.referenced_tables_by_name.find(alias);
        if (it == scope.referenced_tables_by_name.end() || !it->second.IsUnresolvedRelation()) continue;
        auto& rel = std::get<UnresolvedRelation>(it->second.source);
        if (&rel.table_ref.get() != &table_ref) continue;
        local_unresolved.push_back(InferenceCandidate{rel.table_name, rel.table_ref});
    }

    for (auto& expr : scope.expressions) {
        auto* col_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
        if (col_ref == nullptr || col_ref->IsResolved() || col_ref->IsInferred()) continue;

        if (col_ref->column_name.table_alias.has_value()) {
            // Alias-qualified: the owner is pinned to whatever the alias refers to.
            std::string_view alias = col_ref->column_name.table_alias->get();
            const ReferencedTable* ref_table = LookupAliasInScopeChain(scope, alias);
            // Only associate when the alias names an unresolved relation. If the alias is unknown
            // (e.g. a derived-table alias we don't model) or names a known table/CTE that simply
            // lacks the column, this is not an inference (it's a genuine miss / error).
            if (ref_table == nullptr || !ref_table->IsUnresolvedRelation()) continue;
            auto& rel = std::get<UnresolvedRelation>(ref_table->source);
            state.analyzed->inference_constraints.PushBack(InferenceConstraint{
                .kind = InferenceConstraint::Kind::Forced,
                .expression_id = expr.expression_id,
                .column_name = col_ref->column_name.column_name,
                .candidates = {InferenceCandidate{rel.table_name, rel.table_ref}},
            });
        } else {
            // Unqualified: the candidate domain is the unresolved tables in scope. A resolved table
            // can never own a still-unresolved column (its schema is complete), so we exclude them.
            if (local_unresolved.empty()) continue;
            auto kind = local_unresolved.size() == 1 ? InferenceConstraint::Kind::Forced
                                                     : InferenceConstraint::Kind::Disjunctive;
            state.analyzed->inference_constraints.PushBack(InferenceConstraint{
                .kind = kind,
                .expression_id = expr.expression_id,
                .column_name = col_ref->column_name.column_name,
                .candidates = local_unresolved,
            });
        }
    }
}

void NameResolutionPass::PopulateOutputColumns(AnalyzedScript::NameScope& scope) {
    auto [combine_inputs] = state.GetAttributes<AttributeKey::SQL_COMBINE_INPUT>(state.ast[scope.ast_node_id]);
    if (combine_inputs && combine_inputs->children_count() > 0) {
        // Set operations expose the left input's column names, including in recursive CTEs.
        auto left = state.analyzed->name_scopes_by_root_node.find(combine_inputs->children_begin_or_value());
        if (left != state.analyzed->name_scopes_by_root_node.end()) {
            scope.output_columns = left->second.get().output_columns;
            scope.output_columns_by_name = left->second.get().output_columns_by_name;
        }
    }
    for (auto& rt : scope.result_targets) {
        // Note that this is deliberately fuzzy.
        // Independent of the algebra, we just forward all names of table references as output columns if a star is
        // specified. We might want to get smarter (check if there's a grouping etc)
        if (rt.is_star) {
            for (auto& table_reference : scope.table_references) {
                auto* relation = std::get_if<AnalyzedScript::TableReference::RelationExpression>(&table_reference.inner);
                if (!relation) continue;
                std::string_view alias = table_reference.alias.has_value()
                                             ? table_reference.alias->first.get().text
                                             : relation->table_name.table_name.get().text;
                auto referenced_iter = scope.referenced_tables_by_name.find(alias);
                if (referenced_iter == scope.referenced_tables_by_name.end()) continue;
                auto& ref_table = referenced_iter->second;
                if (auto* table_ref =
                        std::get_if<std::reference_wrapper<const CatalogEntry::TableDeclaration>>(&ref_table.source)) {
                    for (auto& col : table_ref->get().table_columns) {
                        std::string_view name = col.column_name.get().text;
                        if (scope.output_columns_by_name.contains(name)) continue;
                        scope.output_columns_by_name.emplace(name, scope.output_columns.size());
                        scope.output_columns.push_back(ScopeColumn{
                            .column_name = col.column_name,
                            .source = std::ref(col),
                        });
                    }
                } else if (ref_table.IsUnresolvedRelation()) {
                    // An unresolved relation has an unknown schema: a `SELECT *` cannot enumerate its
                    // columns, so it contributes no output columns (as before it was registered at all).
                    continue;
                } else {
                    auto& cte = std::get<std::reference_wrapper<ResolvedCTE>>(ref_table.source).get();
                    if (cte.child_scope) {
                        for (size_t i = 0; i < cte.child_scope->output_columns.size(); ++i) {
                            auto out_col = cte.child_scope->output_columns[i];
                            if (i < cte.column_aliases.size()) out_col.column_name = cte.column_aliases[i];
                            std::string_view name = out_col.column_name.get().text;
                            if (scope.output_columns_by_name.contains(name)) continue;
                            scope.output_columns_by_name.emplace(name, scope.output_columns.size());
                            scope.output_columns.push_back(out_col);
                        }
                    }
                }
            }
        } else {
            AnalyzedScript::Expression* expr = nullptr;
            if (rt.expression_id.has_value()) {
                expr = state.GetExpression(*rt.expression_id);
            } else {
                auto& rt_node = state.ast[rt.ast_node_id];
                auto [value_node] = state.GetAttributes<AttributeKey::SQL_RESULT_TARGET_VALUE>(rt_node);
                if (value_node) {
                    expr = state.GetDerivedForNode<AnalyzedScript::Expression>(*value_node);
                    if (expr) rt.expression_id = expr->expression_id;
                }
            }
            if (expr) {
                auto& name_ref = rt.column_name.has_value() ? rt.column_name->get() : state.empty_name;
                std::string_view name = name_ref.text;
                if (!name.empty()) {
                    if (scope.output_columns_by_name.contains(name)) continue;
                    scope.output_columns_by_name.emplace(name, scope.output_columns.size());
                }
                scope.output_columns.push_back(ScopeColumn{
                    .column_name = name_ref,
                    .source = std::ref(*expr),
                });
            }
        }
    }
}

void NameResolutionPass::ResolveNames() {
    std::vector<AnalyzedScript::NameScope*> roots{root_scopes.begin(), root_scopes.end()};
    // Pass 1 (bottom-up via post-order DFS): resolve table refs from catalog,
    // resolve column refs locally against those tables, resolve from child scope
    // outputs, then populate this scope's output_columns for its parent.
    std::stack<std::pair<AnalyzedScript::NameScope*, bool>> dfs;
    for (auto* scope : roots) {
        dfs.push({scope, false});
    }
    while (!dfs.empty()) {
        auto& [scope, visited] = dfs.top();
        if (!visited) {
            visited = true;
            // Push children in reverse order so earlier siblings are processed first in post-order
            std::vector<AnalyzedScript::NameScope*> children;
            for (auto& child : scope->child_scopes) {
                children.push_back(static_cast<AnalyzedScript::NameScope*>(&child));
            }
            for (auto it = children.rbegin(); it != children.rend(); ++it) {
                dfs.push({*it, false});
            }
        } else {
            dfs.pop();
            ResolveTableRefsInScope(*scope);
            ResolveColumnRefsLocally(*scope);
            ResolveColumnRefsFromChildOutputs(*scope);
            PopulateOutputColumns(*scope);
        }
    }

    // Pass 2 (top-down via pre-order DFS): resolve remaining unresolved column
    // refs by walking up to parent scopes. This handles correlated subqueries.
    for (auto* scope : roots) {
        dfs.push({scope, false});
    }
    while (!dfs.empty()) {
        auto [scope, _] = dfs.top();
        dfs.pop();
        // Recursive CTE outputs are available only after the bottom-up pass completes.
        for (auto& expr : scope->expressions) {
            auto* column = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
            if (!column || column->IsResolved()) continue;
            bool ambiguous = std::ranges::any_of(state.analyzed->errors, [&](const auto& error) {
                return error.error_type == buffers::analyzer::AnalyzerErrorType::COLUMN_REF_AMBIGUOUS &&
                       error.ast_node_id == expr.ast_node_id;
            });
            if (!ambiguous) TryResolveColumnInScope(expr, *scope, state);
        }
        ResolveColumnRefsFromParents(*scope);
        ResolveRowFieldAccesses(*scope);
        for (auto& child : scope->child_scopes) {
            dfs.push({static_cast<AnalyzedScript::NameScope*>(&child), false});
        }
    }

    // Pass 3: associate columns that remain unresolved after all resolution attempts with the
    // unresolved tables in scope, emitting schema-inference constraints. Runs after Pass 2 so that
    // columns resolvable from a parent scope (correlated subqueries) are never spuriously associated.
    // We iterate the name_scopes buffer in creation order (rather than the root_scopes hash set) so
    // that constraint emission order is deterministic and follows source order.
    state.analyzed->name_scopes.ForEach([&](size_t, AnalyzedScript::NameScope& scope) { AssociateUnresolvedColumns(scope); });
}

uint32_t NameResolutionPass::FindStatementId(uint32_t ast_node_id) const {
    NodeID root_node_id = ast_node_id;
    for (size_t depth = 0; depth < state.ast.size(); ++depth) {
        auto parent = state.ast[root_node_id].parent();
        if (parent >= state.ast.size()) break;
        root_node_id = parent;
    }
    for (uint32_t i = 0; i < state.parsed.statements.size(); ++i) {
        if (state.parsed.statements[i].root == root_node_id) return i;
    }
    for (uint32_t i = 0; i < state.parsed.statements.size(); ++i) {
        const auto& statement = state.parsed.statements[i];
        if (ast_node_id >= statement.nodes_begin && ast_node_id < statement.nodes_begin + statement.node_count) {
            return i;
        }
    }
    return PROTO_NULL_U32;
}

bool NameResolutionPass::IsInsideGraphSyntax(uint32_t ast_node_id) const {
    uint32_t node_id = ast_node_id;
    for (size_t depth = 0; depth < state.ast.size(); ++depth) {
        uint32_t parent_id = state.ast[node_id].parent();
        if (parent_id >= state.ast.size()) return false;
        switch (state.ast[parent_id].node_type()) {
            case buffers::parser::NodeType::OBJECT_SQL_PROPERTY_GRAPH:
            case buffers::parser::NodeType::OBJECT_SQL_GRAPH_TABLE:
                return true;
            default:
                node_id = parent_id;
                break;
        }
    }
    return false;
}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}

/// Visit a chunk of nodes
void NameResolutionPass::Visit(std::span<const buffers::parser::Node> morsel) {
    // XXX What about:
    //  indirections? c_expr
    //  subquery with alias

    // Scan nodes in morsel
    size_t morsel_offset = morsel.data() - state.ast.data();
    for (size_t i = 0; i < morsel.size(); ++i) {
        // Resolve the node
        const buffers::parser::Node& node = morsel[i];
        NodeID node_id = morsel_offset + i;
        // Create empty node state
        NodeState& node_state = node_states[node_id];

        // Check node type
        switch (node.node_type()) {
            case buffers::parser::NodeType::OBJECT_SQL_COLUMN_DEF: {
                size_t parent_id = node.parent();
                if (parent_id < state.ast.size()) {
                    const auto& parent = state.ast[parent_id];
                    // Fields of descriptors and row types are not table columns
                    if (parent.attribute_key() == AttributeKey::SQL_DESCRIPTOR_COLUMNS ||
                        parent.attribute_key() == AttributeKey::SQL_ROW_TYPE_FIELDS) {
                        break;
                    }
                }
                auto [column_def_node] = state.GetAttributes<AttributeKey::SQL_COLUMN_DEF_NAME>(node);
                if (column_def_node && column_def_node->node_type() == buffers::parser::NodeType::NAME) {
                    auto& name = state.scanned.GetNames().At(column_def_node->children_begin_or_value());
                    name.coarse_analyzer_tags |= buffers::analyzer::NameTag::COLUMN_NAME;
                    if (auto reused = pending_columns_free_list.PopFront()) {
                        *reused = AnalyzedScript::TableColumn(node_id, name);
                        node_state.table_columns.PushBack(*reused);
                    } else {
                        auto& node = pending_columns.PushBack(AnalyzedScript::TableColumn(node_id, name));
                        node_state.table_columns.PushBack(node);
                    }
                }
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_COLUMN_REF: {
                if (IsInsideGraphSyntax(node_id)) break;
                // Read column ref path
                auto [column_ref_node] = state.GetAttributes<AttributeKey::SQL_COLUMN_REF_PATH>(node);
                auto column_name = state.ReadQualifiedColumnName(column_ref_node);
                if (column_name.has_value()) {
                    // Add column reference
                    AnalyzedScript::Expression::ColumnRef column_ref{
                        .column_name = column_name.value(),
                        .ast_scope_root = std::nullopt,
                        .resolved = {},
                        .inferred = std::nullopt,
                    };
                    auto& n = state.analyzed->AddExpression(node_id, node.symbol_span(), std::move(column_ref));
                    node_state.column_references.PushBack(n);
                    state.SetDerivedForNode(node, n);
                    state.MarkNode(node, buffers::analyzer::SemanticNodeMarkerType::COLUMN_REFERENCE);
                }
                // Column refs may be recursive
                MergeChildStates(node_state, node);
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_TABLEREF: {
                if (IsInsideGraphSyntax(node_id)) break;
                // Read a table ref name
                auto [name_node, alias_node] =
                    state.GetAttributes<AttributeKey::SQL_TABLEREF_NAME, AttributeKey::SQL_TABLEREF_ALIAS>(node);
                // Only consider table refs with a name for now
                if (name_node) {
                    auto name = state.ReadQualifiedTableName(name_node);
                    if (name.has_value()) {
                        // Read a table alias
                        std::string_view alias_str;
                        std::optional<std::pair<std::reference_wrapper<RegisteredName>, sx::parser::SymbolSpan>> alias =
                            std::nullopt;
                        if (alias_node && alias_node->node_type() == buffers::parser::NodeType::NAME) {
                            auto& a = state.scanned.GetNames().At(alias_node->children_begin_or_value());
                            a.coarse_analyzer_tags |= buffers::analyzer::NameTag::TABLE_ALIAS;
                            alias_str = a;
                            alias = {a, alias_node->symbol_span()};
                        }
                        // Add table reference
                        auto& n = state.analyzed->table_references.PushBack(AnalyzedScript::TableReference(alias));
                        n.buffer_index = state.analyzed->table_references.GetSize() - 1;
                        n.table_reference_id =
                            ExternalObjectID{state.catalog_entry_id,
                                             static_cast<uint32_t>(state.analyzed->table_references.GetSize() - 1)};
                        n.ast_node_id = node_id;
                        n.location = state.parsed.nodes[node_id].symbol_span();
                        n.ast_statement_id = std::nullopt;
                        n.ast_scope_root = std::nullopt;
                        n.inner = AnalyzedScript::TableReference::RelationExpression{
                            .table_name = name.value(),
                            .resolved_table = std::nullopt,
                            .resolved_alternatives = {},
                        };
                        node_state.table_references.PushBack(n);
                        state.MarkNode(node, buffers::analyzer::SemanticNodeMarkerType::TABLE_REFERENCE);
                    }
                }
                // Table refs may be recursive
                MergeChildStates(node_state, node);
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_RESULT_TARGET: {
                if (IsInsideGraphSyntax(node_id)) break;
                MergeChildStates(node_state, node);

                auto [value_node, name_node, star_node] =
                    state.GetAttributes<AttributeKey::SQL_RESULT_TARGET_VALUE, AttributeKey::SQL_RESULT_TARGET_NAME,
                                        AttributeKey::SQL_RESULT_TARGET_STAR>(node);

                auto& rt = pending_result_targets.PushBack(AnalyzedScript::ResultTarget{});
                rt.ast_node_id = node_id;

                if (star_node) {
                    rt.is_star = true;
                } else {
                    if (name_node && name_node->node_type() == buffers::parser::NodeType::NAME) {
                        auto& alias = state.scanned.GetNames().At(name_node->children_begin_or_value());
                        rt.column_name = alias;
                    }
                    if (value_node) {
                        auto* expr = state.GetDerivedForNode<AnalyzedScript::Expression>(*value_node);
                        if (expr) {
                            rt.expression_id = expr->expression_id;
                            if (!rt.column_name.has_value()) {
                                if (auto* col_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr->inner)) {
                                    rt.column_name = col_ref->column_name.column_name;
                                }
                            }
                        }
                    }
                }

                node_state.result_targets.PushBack(rt);
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_CTE: {
                auto [name_node, columns_node, stmt_node] =
                    state.GetAttributes<AttributeKey::SQL_CTE_NAME, AttributeKey::SQL_CTE_COLUMNS,
                                        AttributeKey::SQL_CTE_STATEMENT>(node);
                MergeChildStates(node_state, node);
                if (name_node && name_node->node_type() == buffers::parser::NodeType::NAME && stmt_node) {
                    auto& cte_name = state.scanned.GetNames().At(name_node->children_begin_or_value());
                    uint32_t stmt_node_id = stmt_node - state.ast.data();
                    uint32_t cols_node_id = columns_node ? static_cast<uint32_t>(columns_node - state.ast.data()) : 0;
                    uint16_t cols_count = columns_node ? columns_node->children_count() : 0;
                    auto& cte = pending_cte_nodes.PushBack(AnalyzedScript::CTEDefinition{
                        .cte_name = cte_name,
                        .select_node_id = stmt_node_id,
                        .columns_node_id = cols_node_id,
                        .columns_count = cols_count,
                        .ast_node_id = node_id,
                    });
                    node_state.ctes.PushBack(cte);
                }
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_SELECT: {
                if (IsInsideGraphSyntax(node_id)) {
                    break;
                }
                MergeChildStates(node_state, node);
                auto result_targets = std::move(node_state.result_targets);
                auto cte_defs = std::move(node_state.ctes);
                auto& scope = CreateScope(node_state, node_id);
                scope.result_targets.Append(std::move(result_targets));
                // Completion needs both declaration order and recursive visibility after the
                // analyzer has consumed the temporary CTE nodes, so persist that metadata on scope.
                auto [recursive_node] = state.GetAttributes<AttributeKey::SQL_SELECT_WITH_RECURSIVE>(node);
                scope.ctes_recursive = recursive_node != nullptr;

                AttachCTEs(scope, std::move(cte_defs));

                auto [into_node] = state.GetAttributes<AttributeKey::SQL_SELECT_INTO>(node);
                if (into_node && into_node->node_type() == buffers::parser::NodeType::OBJECT_SQL_INTO) {
                    auto [into_name_node] = state.GetAttributes<AttributeKey::SQL_TEMP_NAME>(*into_node);
                    RegisterDerivedTable(*into_node, into_name_node, nullptr, node);
                }
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_INSERT: {
                auto [target_node, columns_node, source_node, default_values_node, returning_node, recursive_node] =
                    state.GetAttributes<AttributeKey::SQL_INSERT_TARGET, AttributeKey::SQL_INSERT_COLUMNS,
                                        AttributeKey::SQL_INSERT_SOURCE, AttributeKey::SQL_INSERT_DEFAULT_VALUES,
                                        AttributeKey::SQL_INSERT_RETURNING, AttributeKey::SQL_SELECT_WITH_RECURSIVE>(node);
                if (!target_node) {
                    MergeChildStates(node_state, node);
                    break;
                }

                auto& target_state = node_states[target_node - state.ast.data()];
                if (target_state.table_references.IsEmpty()) {
                    MergeChildStates(node_state, node);
                    break;
                }
                auto& target_ref = *target_state.table_references.begin();
                target_ref.role = TableReference::Role::Write;

                MergeChildStates(node_state, node);
                auto result_targets = std::move(node_state.result_targets);
                auto cte_defs = std::move(node_state.ctes);
                auto& scope = CreateScope(node_state, node_id);
                scope.result_targets.Append(std::move(result_targets));
                scope.ctes_recursive = recursive_node != nullptr;
                scope.child_output_resolution_barrier = true;
                AttachCTEs(scope, std::move(cte_defs));
                if (source_node) {
                    auto source_scope = state.analyzed->name_scopes_by_root_node.find(source_node - state.ast.data());
                    if (source_scope != state.analyzed->name_scopes_by_root_node.end()) {
                        source_scope->second.get().column_correlation_barrier = true;
                    }
                }
                for (auto& [_, cte] : scope.cte_definitions) {
                    if (cte.child_scope) cte.child_scope->column_correlation_barrier = true;
                }

                InsertStatement insert{
                    .ast_node_id = static_cast<uint32_t>(node_id),
                    .ast_statement_id = FindStatementId(node_id),
                    .target = target_ref,
                    .source_ast_node_id = source_node ? std::optional<uint32_t>(source_node - state.ast.data())
                                                      : std::nullopt,
                    .default_values = default_values_node != nullptr,
                    .returning = returning_node != nullptr,
                };
                if (columns_node && columns_node->node_type() == buffers::parser::NodeType::ARRAY) {
                    auto columns = state.ast.subspan(columns_node->children_begin_or_value(), columns_node->children_count());
                    insert.target_columns.reserve(columns.size());
                    for (auto& column : columns) {
                        if (column.node_type() != buffers::parser::NodeType::NAME) continue;
                        auto& name = state.scanned.GetNames().At(column.children_begin_or_value());
                        name.coarse_analyzer_tags |= buffers::analyzer::NameTag::COLUMN_NAME;
                        insert.target_columns.push_back({
                            .ast_node_id = static_cast<uint32_t>(&column - state.ast.data()),
                            .column_name = name,
                        });
                    }
                }
                state.analyzed->insert_statements.PushBack(std::move(insert));
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_DELETE: {
                auto [target_node, recursive_node] =
                    state.GetAttributes<AttributeKey::SQL_DELETE_TARGET,
                                        AttributeKey::SQL_SELECT_WITH_RECURSIVE>(node);
                if (target_node) {
                    auto& target_state = node_states[target_node - state.ast.data()];
                    for (auto& reference : target_state.table_references) {
                        reference.role = TableReference::Role::Write;
                    }
                }
                MergeChildStates(node_state, node);
                auto result_targets = std::move(node_state.result_targets);
                auto cte_defs = std::move(node_state.ctes);
                auto& scope = CreateScope(node_state, node_id);
                scope.result_targets.Append(std::move(result_targets));
                scope.ctes_recursive = recursive_node != nullptr;
                scope.child_output_resolution_barrier = true;
                AttachCTEs(scope, std::move(cte_defs));
                // CTE definitions cannot correlate to the DELETE target or USING relations.
                for (auto& [_, cte] : scope.cte_definitions) {
                    if (cte.child_scope) cte.child_scope->column_correlation_barrier = true;
                }
                break;
            }

            case buffers::parser::NodeType::OBJECT_VIS_VISUALISE: {
                MergeChildStates(node_state, node);
                CreateScope(node_state, node_id);
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_CREATE: {
                auto statement_id = FindStatementId(node_id);
                if (statement_id < state.parsed.statements.size() &&
                    state.parsed.statements[statement_id].type == buffers::parser::StatementType::EXPLAIN) {
                    MergeChildStates(node_state, node);
                    CreateScope(node_state, node_id);
                    break;
                }
                auto [name_node, elements_node] =
                    state.GetAttributes<AttributeKey::SQL_CREATE_TABLE_NAME, AttributeKey::SQL_CREATE_TABLE_ELEMENTS>(
                        node);
                // Read the name
                auto table_name = state.ReadQualifiedTableName(name_node);
                if (table_name.has_value()) {
                    // Register the database
                    auto schema_id = RegisterSchema(table_name->database_name, table_name->schema_name);
                    // Determine the catalog table id
                    ExternalObjectID catalog_table_id{
                        state.catalog_entry_id, static_cast<uint32_t>(state.analyzed->table_declarations.GetSize())};
                    // Merge child states
                    MergeChildStates(node_state, {elements_node});
                    // Collect all columns
                    auto table_columns = node_state.table_columns.Flatten();
                    pending_columns_free_list.Append(std::move(node_state.table_columns));

                    // Sort the table columns
                    std::sort(table_columns.begin(), table_columns.end(),
                              [&](CatalogEntry::TableColumn& l, CatalogEntry::TableColumn& r) {
                                  return l.column_name.get().text < r.column_name.get().text;
                              });
                    // Create the scope
                    CreateScope(node_state, node_id);
                    // Build the table
                    auto& n = state.analyzed->table_declarations.PushBack(
                        AnalyzedScript::TableDeclaration(schema_id, catalog_table_id, table_name.value()));
                    n.ast_node_id = node_id;
                    n.ast_statement_id = FindStatementId(node_id);
                    n.table_columns = std::move(table_columns);
                    // Register the table declaration
                    table_name->table_name.get().resolved_objects.PushBack(n);
                    // Update the table ref and index of all columns
                    n.table_columns_by_name.reserve(n.table_columns.size());
                    for (size_t column_index = 0; column_index != n.table_columns.size(); ++column_index) {
                        auto& column = n.table_columns[column_index];
                        column.object_id = QualifiedCatalogObjectID::TableColumn(catalog_table_id, column_index);
                        column.table = n;
                        column.column_name.get().resolved_objects.PushBack(column);
                        n.table_columns_by_name.insert({column.column_name.get().text, column});
                    }
                }
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_CREATE_FUNCTION: {
                auto statement_id = FindStatementId(node_id);
                if (statement_id < state.parsed.statements.size() &&
                    state.parsed.statements[statement_id].type == buffers::parser::StatementType::EXPLAIN) {
                    MergeChildStates(node_state, node);
                    break;
                }
                auto [name_node, params_node, returns_node, is_aggregate_node] = state.GetAttributes<
                    AttributeKey::SQL_CREATE_FUNCTION_NAME, AttributeKey::SQL_CREATE_FUNCTION_PARAMS,
                    AttributeKey::SQL_CREATE_FUNCTION_RETURNS, AttributeKey::SQL_CREATE_FUNCTION_IS_AGGREGATE>(node);
                auto func_name = state.ReadQualifiedFunctionName(name_node);
                if (func_name.has_value()) {
                    auto schema_id = RegisterSchema(func_name->database_name, func_name->schema_name);
                    ExternalObjectID catalog_function_id{
                        state.catalog_entry_id, static_cast<uint32_t>(state.analyzed->function_declarations.GetSize())};
                    auto& decl = state.analyzed->function_declarations.PushBack(
                        CatalogEntry::FunctionDeclaration(schema_id, catalog_function_id, func_name.value()));
                    decl.ast_node_id = node_id;
                    decl.is_aggregate = (is_aggregate_node != nullptr);
                    // Read return type text from the AST node location
                    if (returns_node) {
                        decl.return_type = state.scanned.ReadTextAtSymbolSpan(returns_node->symbol_span());
                    }
                    // Read parameters
                    if (params_node && params_node->node_type() == buffers::parser::NodeType::ARRAY) {
                        auto param_nodes =
                            state.ast.subspan(params_node->children_begin_or_value(), params_node->children_count());
                        for (auto& param_node : param_nodes) {
                            if (param_node.node_type() != buffers::parser::NodeType::OBJECT_SQL_FUNCTION_PARAM)
                                continue;
                            auto [param_name_node, param_type_node] =
                                LookupAttributes<AttributeKey::SQL_FUNCTION_PARAM_NAME,
                                                 AttributeKey::SQL_FUNCTION_PARAM_TYPE>(state.ast.subspan(
                                    param_node.children_begin_or_value(), param_node.children_count()));
                            if (param_name_node && param_name_node->node_type() == buffers::parser::NodeType::NAME) {
                                auto& param_name =
                                    state.scanned.GetNames().At(param_name_node->children_begin_or_value());
                                std::string_view param_type_text;
                                if (param_type_node) {
                                    param_type_text =
                                        state.scanned.ReadTextAtSymbolSpan(param_type_node->symbol_span());
                                }
                                decl.params.emplace_back(&param_node - state.ast.data(), param_name, param_type_text);
                            }
                        }
                    }
                    func_name->function_name.get().coarse_analyzer_tags |= buffers::analyzer::NameTag::FUNCTION_NAME;
                    func_name->function_name.get().resolved_objects.PushBack(decl);
                }
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_CREATE_AS: {
                auto [name_node, columns_node, statement_node] =
                    state.GetAttributes<AttributeKey::SQL_CREATE_AS_NAME, AttributeKey::SQL_CREATE_AS_COLUMNS,
                                        AttributeKey::SQL_CREATE_AS_STATEMENT>(node);
                if (statement_node && statement_node->node_type() == buffers::parser::NodeType::OBJECT_SQL_SELECT) {
                    RegisterDerivedTable(node, name_node, columns_node, *statement_node);
                }
                MergeChildStates(node_state, node);
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_VIEW: {
                auto [name_node, columns_node, statement_node] =
                    state.GetAttributes<AttributeKey::SQL_VIEW_NAME, AttributeKey::SQL_VIEW_COLUMNS,
                                        AttributeKey::SQL_VIEW_STATEMENT>(node);
                if (statement_node && statement_node->node_type() == buffers::parser::NodeType::OBJECT_SQL_SELECT) {
                    RegisterDerivedTable(node, name_node, columns_node, *statement_node);
                }
                MergeChildStates(node_state, node);
                break;
            }

            case buffers::parser::NodeType::OBJECT_EXT_EXPLAIN: {
                MergeChildStates(node_state, node);
                break;
            }

            case buffers::parser::NodeType::OBJECT_SQL_PROPERTY_GRAPH:
            case buffers::parser::NodeType::OBJECT_SQL_GRAPH_TABLE: {
                // Property graph analysis is syntax-only. Keep graph-local references in the
                // analyzed buffers, but prevent them from entering or affecting an SQL scope.
                MergeChildStates(node_state, node);
                node_state.Clear();
                break;
            }

            // By default, merge child states into the node state
            default:
                MergeChildStates(node_state, node);
                break;
        }
    }
}

/// Finish the analysis pass
void NameResolutionPass::Finish() {
    for (auto& table_chunk : state.analyzed->table_declarations.GetChunks()) {
        for (auto& table : table_chunk) {
            state.analyzed->tables_by_qualified_name.insert({table.table_name, table});
            state.analyzed->tables_by_unqualified_name.insert({table.table_name.table_name.get().text, table});
            if (table.table_name.schema_name.get() != "") {
                state.analyzed->tables_by_unqualified_schema.insert(
                    {{table.table_name.schema_name.get(), table.table_name.database_name.get()}, table});
            }
        }
    }

    // Index function declarations
    for (auto& func_chunk : state.analyzed->function_declarations.GetChunks()) {
        for (auto& func : func_chunk) {
            state.analyzed->functions_by_qualified_name.insert({func.function_name, func});
            state.analyzed->functions_by_unqualified_name.insert({func.function_name.function_name.get().text, func});
        }
    }

    // Assign statement ids to scopes before resolving ordered script-local names.
    state.analyzed->name_scopes.ForEach([&](size_t, auto& scope) {
        scope.ast_statement_id = FindStatementId(scope.ast_node_id);
    });

    // Resolve all names
    ResolveNames();

    for (auto& pending : pending_derived_tables) {
        auto scope_iter = state.analyzed->name_scopes_by_root_node.find(pending.select_node_id);
        if (scope_iter != state.analyzed->name_scopes_by_root_node.end()) {
            PopulateDerivedTable(pending, scope_iter->second);
        }
    }

    // Bail out if there are no statements
    if (!state.parsed.statements.empty()) {
        auto assign_statment_ids = [&](auto& chunks) {
            uint32_t statement_id = 0;
            size_t statement_begin = state.parsed.statements[0].nodes_begin;
            size_t statement_end = statement_begin + state.parsed.statements[0].node_count;
            for (auto& chunk : chunks) {
                for (auto& ref : chunk) {
                    while (statement_end <= ref.ast_node_id && statement_id < state.parsed.statements.size()) {
                        ++statement_id;
                        if (statement_id == state.parsed.statements.size()) break;
                        statement_begin = state.parsed.statements[statement_id].nodes_begin;
                        statement_end = statement_begin + state.parsed.statements[statement_id].node_count;
                    }
                    if (statement_id == state.parsed.statements.size()) break;
                    if (statement_begin <= ref.ast_node_id) ref.ast_statement_id = statement_id;
                }
            }
        };
        assign_statment_ids(state.analyzed->table_references.GetChunks());
        assign_statment_ids(state.analyzed->expressions.GetChunks());
        assign_statment_ids(state.analyzed->name_scopes.GetChunks());
        assign_statment_ids(state.analyzed->function_declarations.GetChunks());
    }

    // Index the table declarations
    state.analyzed->table_declarations.ForEach([&](size_t ti, auto& table) {
        for (size_t i = 0; i < table.table_columns.size(); ++i) {
            auto& column = table.table_columns[i];
            state.analyzed->table_columns_by_name.insert({column.column_name.get().text, column});
        }
    });

    // Solve the schema-inference constraints collected during name resolution.
    RunSchemaInference();
    ResolveInsertTargetColumns();
}

void NameResolutionPass::ResolveInsertTargetColumns() {
    state.analyzed->insert_statements.ForEach([&](size_t, InsertStatement& insert) {
        auto* relation = std::get_if<TableReference::RelationExpression>(&insert.target.get().inner);
        if (!relation || !relation->resolved_table) return;
        auto table_id = relation->resolved_table->catalog_table_id.UnpackTableID();
        const auto* table = table_id.GetOrigin() == state.catalog_entry_id
                                ? state.analyzed->ResolveTableById(table_id)
                                : state.catalog.ResolveTable(table_id);
        if (!table) return;
        for (auto& target_column : insert.target_columns) {
            auto it = table->table_columns_by_name.find(target_column.column_name.get().text);
            if (it == table->table_columns_by_name.end()) continue;
            auto& column = it->second.get();
            target_column.resolved = std::cref(column);
        }
    });
}

namespace {

/// Build the (db, schema, table) identity key for an unresolved table name.
CatalogEntry::QualifiedTableName::Key MakeTableKey(const QualifiedTableName& tn) {
    return {tn.database_name.get().text, tn.schema_name.get().text, tn.table_name.get().text};
}

}  // namespace

void NameResolutionPass::RunSchemaInference() {
    auto& analyzed = *state.analyzed;
    if (analyzed.inference_constraints.IsEmpty()) return;

    // Get-or-create the inferred schema for a table name.
    auto get_or_create_schema = [&](const QualifiedTableName& tn) -> AnalyzedScript::InferredTableSchema& {
        auto key = MakeTableKey(tn);
        auto it = analyzed.inferred_table_schemas_by_name.find(key);
        if (it != analyzed.inferred_table_schemas_by_name.end()) {
            return it->second.get();
        }
        auto& schema = analyzed.inferred_table_schemas.PushBack(AnalyzedScript::InferredTableSchema{.table_name = tn});
        analyzed.inferred_table_schemas_by_name.insert({MakeTableKey(schema.table_name), schema});
        return schema;
    };

    // Add (or upgrade) a column on a schema. Returns the column index.
    auto add_column = [&](AnalyzedScript::InferredTableSchema& schema, RegisteredName& col,
                          InferenceConfidence conf) -> size_t {
        std::string_view name = col.text;
        auto it = schema.columns_by_name.find(name);
        if (it != schema.columns_by_name.end()) {
            auto& c = schema.columns[it->second];
            if (conf > c.confidence) c.confidence = conf;
            if (conf > schema.confidence) schema.confidence = conf;
            return it->second;
        }
        size_t idx = schema.columns.size();
        schema.columns_by_name.emplace(name, idx);
        schema.columns.push_back(AnalyzedScript::InferredColumn{.column_name = col, .confidence = conf});
        if (conf > schema.confidence) schema.confidence = conf;
        return idx;
    };

    // Does a table confidently own a column already?
    auto table_has_confident_column = [&](const QualifiedTableName& tn, std::string_view col) -> bool {
        auto it = analyzed.inferred_table_schemas_by_name.find(MakeTableKey(tn));
        if (it == analyzed.inferred_table_schemas_by_name.end()) return false;
        auto& schema = it->second.get();
        auto cit = schema.columns_by_name.find(col);
        return cit != schema.columns_by_name.end() &&
               schema.columns[cit->second].confidence == InferenceConfidence::CONFIDENT;
    };

    // Write the solved owner back onto the originating column-ref expression.
    auto write_owner = [&](uint32_t expression_id, const InferenceCandidate& owner, InferenceConfidence conf) {
        auto* expr = state.GetExpression(expression_id);
        if (!expr) return;
        if (auto* col_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr->inner)) {
            col_ref->inferred = InferredOwner{
                .table_ref = owner.table_ref,
                .table_name = owner.table_name,
                .confidence = conf,
            };
        }
    };

    // Per-constraint resolution flag (indexed by the constraint's position in the buffer).
    std::vector<bool> resolved(analyzed.inference_constraints.GetSize(), false);

    // Step 1: seed forced constraints (alias-qualified uses, join-predicate sides whose operands are
    // alias-qualified, and unqualified columns with a single unresolved table in scope).
    {
        size_t ci = 0;
        analyzed.inference_constraints.ForEach([&](size_t, AnalyzedScript::InferenceConstraint& c) {
            if (c.kind == AnalyzedScript::InferenceConstraint::Kind::Forced && !c.candidates.empty()) {
                auto& cand = c.candidates.front();
                auto& schema = get_or_create_schema(cand.table_name);
                add_column(schema, c.column_name.get(), InferenceConfidence::CONFIDENT);
                write_owner(c.expression_id, cand, InferenceConfidence::CONFIDENT);
                resolved[ci] = true;
            }
            ++ci;
        });
    }

    // Step 2: propagate over disjunctive constraints to a fixpoint. A disjunction is "explained" when
    // its column is already confidently owned by exactly one candidate (exactly-one-owner rule,
    // fault-tolerant: if several candidates own it, the use is genuinely ambiguous). Iterate because
    // resolving one disjunction may add columns that explain another.
    bool changed = true;
    while (changed) {
        changed = false;
        size_t ci = 0;
        analyzed.inference_constraints.ForEach([&](size_t, AnalyzedScript::InferenceConstraint& c) {
            size_t idx = ci++;
            if (resolved[idx] || c.kind != AnalyzedScript::InferenceConstraint::Kind::Disjunctive) return;
            std::string_view col = c.column_name.get().text;

            // Count candidates that already confidently own the column.
            std::vector<const InferenceCandidate*> owners;
            for (auto& cand : c.candidates) {
                if (table_has_confident_column(cand.table_name, col)) owners.push_back(&cand);
            }
            if (owners.size() == 1) {
                // Exactly one in-scope candidate owns it: the use is confidently that table.
                write_owner(c.expression_id, *owners.front(), InferenceConfidence::CONFIDENT);
                resolved[idx] = true;
                changed = true;
            } else if (owners.size() > 1) {
                // Several candidates own the column (e.g. a join key present in both): the use is
                // ambiguous. Record a best guess plus the full feasible set; add no new columns.
                write_owner(c.expression_id, *owners.front(), InferenceConfidence::CANDIDATE);
                resolved[idx] = true;
                changed = true;
            }
        });
    }

    // Step 3: residual ambiguity. Remaining disjunctions have a column owned by none of their
    // candidates yet. Assign each to a best-guess table — greedily the candidate that already has the
    // most inferred columns (a parsimonious "this table is more fleshed out" prior) — recording the
    // full feasible set so the guess is never presented as authoritative.
    {
        constexpr size_t MAX_INFERENCE_CANDIDATES = MAX_TABLE_REF_AMBIGUITY;
        size_t ci = 0;
        analyzed.inference_constraints.ForEach([&](size_t, AnalyzedScript::InferenceConstraint& c) {
            size_t idx = ci++;
            if (resolved[idx] || c.kind != AnalyzedScript::InferenceConstraint::Kind::Disjunctive) return;
            if (c.candidates.empty() || c.candidates.size() > MAX_INFERENCE_CANDIDATES) {
                resolved[idx] = true;
                return;
            }

            // Pick the best-guess candidate: the one with the most inferred columns so far.
            const InferenceCandidate* best = &c.candidates.front();
            size_t best_cols = 0;
            for (auto& cand : c.candidates) {
                auto it = analyzed.inferred_table_schemas_by_name.find(MakeTableKey(cand.table_name));
                size_t n = it == analyzed.inferred_table_schemas_by_name.end() ? 0 : it->second.get().columns.size();
                if (n > best_cols) {
                    best_cols = n;
                    best = &cand;
                }
            }

            // Add the column to the best-guess table as a CANDIDATE column, recording the other
            // feasible owner tables on the column.
            auto& schema = get_or_create_schema(best->table_name);
            size_t col_idx = add_column(schema, c.column_name.get(), InferenceConfidence::CANDIDATE);
            auto& inferred_col = schema.columns[col_idx];
            for (auto& cand : c.candidates) {
                if (&cand == best) continue;
                inferred_col.candidate_table_names.push_back(cand.table_name);
            }
            write_owner(c.expression_id, *best, InferenceConfidence::CANDIDATE);
            resolved[idx] = true;
        });
    }
}

}  // namespace dashql
