#include "sqlynx/analyzer/name_resolution_pass.h"

#include <functional>
#include <iterator>
#include <optional>
#include <stack>

#include "sqlynx/catalog.h"
#include "sqlynx/external.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/intrusive_list.h"

namespace sqlynx {

/// Helper to merge two vectors
template <typename T> static void merge(std::vector<T>& left, std::vector<T>&& right) {
    if (left.empty()) {
        left = std::move(right);
    } else {
        left.insert(left.end(), std::make_move_iterator(right.begin()), std::make_move_iterator(right.end()));
        right.clear();
    }
}

/// Merge two node states
void NameResolutionPass::NodeState::Merge(NodeState&& other) {
    child_scopes.Append(std::move(other.child_scopes));
    table_columns.Append(std::move(other.table_columns));
    table_references.Append(std::move(other.table_references));
    column_references.Append(std::move(other.column_references));
}

/// Clear a node state
void NameResolutionPass::NodeState::Clear() {
    child_scopes.Clear();
    table_columns.Clear();
    table_references.Clear();
    column_references.Clear();
}

/// Constructor
NameResolutionPass::NameResolutionPass(AnalyzedScript& analyzed, Catalog& catalog, AttributeIndex& attribute_index)
    : scanned(*analyzed.parsed_script->scanned_script),
      parsed(*analyzed.parsed_script),
      analyzed(analyzed),
      catalog_entry_id(parsed.external_id),
      catalog(catalog),
      attribute_index(attribute_index),
      ast(parsed.nodes),
      default_database_name(parsed.scanned_script->name_registry.Register(catalog.GetDefaultDatabaseName())),
      default_schema_name(parsed.scanned_script->name_registry.Register(catalog.GetDefaultSchemaName())) {
    node_states.resize(ast.size());
    default_database_name.resolved_tags |= proto::NameTag::DATABASE_NAME;
    default_schema_name.resolved_tags |= proto::NameTag::SCHEMA_NAME;
}

std::span<std::reference_wrapper<RegisteredName>> NameResolutionPass::ReadNamePath(const sx::Node& node) {
    if (node.node_type() != proto::NodeType::ARRAY) {
        return {};
    }
    name_path_buffer.clear();
    auto children = ast.subspan(node.children_begin_or_value(), node.children_count());
    for (size_t i = 0; i != children.size(); ++i) {
        // A child is either a name, an indirection or an operator (*).
        // We only consider plan name paths for now and extend later.
        auto& child = children[i];
        if (child.node_type() != proto::NodeType::NAME) {
            name_path_buffer.clear();
            break;
        }
        auto& name = scanned.GetNames().At(child.children_begin_or_value());
        name_path_buffer.push_back(name);
    }
    return std::span{name_path_buffer};
}

std::optional<AnalyzedScript::QualifiedTableName> NameResolutionPass::ReadQualifiedTableName(const sx::Node* node) {
    if (!node) {
        return std::nullopt;
    }
    auto name_path = ReadNamePath(*node);
    auto ast_node_id = node - ast.data();
    switch (name_path.size()) {
        case 3:
            name_path[0].get().resolved_tags |= sx::NameTag::DATABASE_NAME;
            name_path[1].get().resolved_tags |= sx::NameTag::SCHEMA_NAME;
            name_path[2].get().resolved_tags |= sx::NameTag::TABLE_NAME;
            return AnalyzedScript::QualifiedTableName{ast_node_id, name_path[0], name_path[1], name_path[2]};
        case 2: {
            name_path[0].get().resolved_tags |= sx::NameTag::SCHEMA_NAME;
            name_path[1].get().resolved_tags |= sx::NameTag::TABLE_NAME;
            return AnalyzedScript::QualifiedTableName{ast_node_id, default_database_name, name_path[0], name_path[1]};
        }
        case 1: {
            name_path[0].get().resolved_tags |= sx::NameTag::TABLE_NAME;
            return AnalyzedScript::QualifiedTableName{ast_node_id, default_database_name, default_schema_name,
                                                      name_path[0]};
        }
        default:
            return std::nullopt;
    }
}

std::optional<AnalyzedScript::QualifiedColumnName> NameResolutionPass::ReadQualifiedColumnName(const sx::Node* node) {
    if (!node) {
        return std::nullopt;
    }
    auto name_path = ReadNamePath(*node);
    auto ast_node_id = node - ast.data();
    // Build the qualified column name
    switch (name_path.size()) {
        case 2:
            name_path[0].get().resolved_tags |= sx::NameTag::TABLE_ALIAS;
            name_path[1].get().resolved_tags |= sx::NameTag::COLUMN_NAME;
            return AnalyzedScript::QualifiedColumnName{ast_node_id, name_path[0], name_path[1]};
        case 1:
            name_path[0].get().resolved_tags |= sx::NameTag::COLUMN_NAME;
            return AnalyzedScript::QualifiedColumnName{ast_node_id, std::nullopt, name_path[0]};
        default:
            return std::nullopt;
    }
}

/// Register a schema
std::pair<CatalogDatabaseID, CatalogSchemaID> NameResolutionPass::RegisterSchema(RegisteredName& database_name,
                                                                                 RegisteredName& schema_name) {
    // Register the database
    CatalogDatabaseID db_id = 0;
    CatalogSchemaID schema_id = 0;
    auto db_ref_iter = analyzed.databases_by_name.find(database_name);
    if (db_ref_iter == analyzed.databases_by_name.end()) {
        db_id = catalog.AllocateDatabaseId(database_name);
        auto& db = analyzed.database_references.Append(CatalogEntry::DatabaseReference{db_id, database_name, ""});
        analyzed.databases_by_name.insert({db.database_name, db});
        database_name.resolved_objects.PushBack(db);
    } else {
        db_id = db_ref_iter->second.get().catalog_database_id;
    }
    // Register the schema
    auto schema_ref_iter = analyzed.schemas_by_name.find({database_name, schema_name});
    if (schema_ref_iter == analyzed.schemas_by_name.end()) {
        schema_id = catalog.AllocateSchemaId(database_name, schema_name);
        auto& schema = analyzed.schema_references.Append(
            CatalogEntry::SchemaReference{db_id, schema_id, database_name, schema_name});
        analyzed.schemas_by_name.insert({{database_name, schema_name}, schema});
        schema_name.resolved_objects.PushBack(schema);
    } else {
        schema_id = schema_ref_iter->second.get().catalog_schema_id;
    }
    return {db_id, schema_id};
}

void NameResolutionPass::MergeChildStates(NodeState& dst, std::initializer_list<const proto::Node*> children) {
    for (const proto::Node* child : children) {
        if (!child) continue;
        dst.Merge(std::move(node_states[child - ast.data()]));
    }
}

void NameResolutionPass::MergeChildStates(NodeState& dst, const proto::Node& parent) {
    for (size_t i = 0; i < parent.children_count(); ++i) {
        auto child_id = parent.children_begin_or_value() + i;
        auto& child = node_states[parent.children_begin_or_value() + i];
        dst.Merge(std::move(child));
    }
}

AnalyzedScript::NameScope& NameResolutionPass::CreateScope(NodeState& target, uint32_t scope_root) {
    auto& scope = analyzed.name_scopes.Append(AnalyzedScript::NameScope{
        .ast_scope_root = scope_root, .parent_scope = nullptr, .child_scopes = target.child_scopes});
    for (auto& child_scope : target.child_scopes) {
        child_scope.parent_scope = &scope.value;
        root_scopes.erase(&child_scope);
    }
    for (auto& ref : target.column_references) {
        ref.ast_scope_root = scope_root;
    }
    for (auto& ref : target.table_references) {
        ref.ast_scope_root = scope_root;
    }
    scope.value.table_references = target.table_references;
    scope.value.expressions = target.column_references;
    // Clear the target since we're starting a new scope now
    target.Clear();
    // Remember the child scope
    target.child_scopes.PushBack(scope);
    root_scopes.insert(&scope.value);
    return scope.value;
}

void NameResolutionPass::ResolveTableRefsInScope(AnalyzedScript::NameScope& scope) {
    for (auto& table_ref : scope.table_references) {
        // TODO Matches a view or CTE?

        auto* unresolved = std::get_if<AnalyzedScript::TableReference::UnresolvedRelationExpression>(&table_ref.inner);
        if (!unresolved) {
            continue;
        }
        // Copy table name so that we can override the unresolved expression
        auto table_name = unresolved->table_name;
        // Table ref points to own table?
        auto iter = analyzed.tables_by_name.find(table_name);
        if (iter != analyzed.tables_by_name.end()) {
            // Store resolved relation expression
            auto& table = iter->second.get();
            table_ref.inner = AnalyzedScript::TableReference::ResolvedRelationExpression{
                .table_name = table.table_name,
                .catalog_database_id = table.catalog_database_id,
                .catalog_schema_id = table.catalog_schema_id,
                .catalog_table_id = table.catalog_table_id,
            };

            if (table_ref.alias_name.has_value()) {
                // Register named table
                scope.named_tables.insert({table_ref.alias_name->get().text, table});
            } else {
                // Register unnambed table
                scope.unnamed_tables.insert({table.catalog_table_id, table});
            }
            continue;
        }

        // Otherwise consult the external search path
        if (auto* resolved = catalog.ResolveTable(table_name, catalog_entry_id)) {
            // Remember resolved table
            table_ref.inner = AnalyzedScript::TableReference::ResolvedRelationExpression{
                .table_name = table_name,
                .catalog_database_id = resolved->catalog_database_id,
                .catalog_schema_id = resolved->catalog_schema_id,
                .catalog_table_id = resolved->catalog_table_id,
            };

            if (table_ref.alias_name.has_value()) {
                // Register named table
                scope.named_tables.insert({table_ref.alias_name->get().text, *resolved});
            } else {
                // Register unnambed table
                scope.unnamed_tables.insert({resolved->catalog_table_id, *resolved});
            }
            continue;
        }

        // Failed to resolve the table ref, leave unresolved
    }
}

void NameResolutionPass::ResolveColumnRefsInScope(AnalyzedScript::NameScope& scope, ColumnRefsByAlias& refs_by_alias,
                                                  ColumnRefsByName& refs_by_name) {
    std::list<std::reference_wrapper<AnalyzedScript::Expression>> unresolved_columns;
    for (auto& expr : scope.expressions) {
        if (std::holds_alternative<AnalyzedScript::Expression::UnresolvedColumnRef>(expr.inner)) {
            unresolved_columns.push_back(expr);
        }
    }
    // Resolve refs in the scope upwards
    for (auto target_scope = &scope; target_scope != nullptr; target_scope = target_scope->parent_scope) {
        for (auto iter = unresolved_columns.begin(); iter != unresolved_columns.end();) {
            auto& expr = iter->get();
            auto unresolved = std::get<AnalyzedScript::Expression::UnresolvedColumnRef>(expr.inner);
            auto column_name = unresolved.column_name.column_name.get().text;

            // Try to resolve a table
            std::optional<std::reference_wrapper<AnalyzedScript::TableColumn>> table_column;
            if (unresolved.column_name.table_alias.has_value()) {
                // Do we know the alias in this scope?
                auto table_alias = unresolved.column_name.table_alias->get().text;
                auto table_iter = target_scope->named_tables.find(table_alias);
                if (table_iter != target_scope->named_tables.end()) {
                    // Is the table known in that table?
                    auto& table_columns_by_name = table_iter->second.get().table_columns_by_name;
                    auto column_iter = table_columns_by_name.find(column_name);
                    if (column_iter != table_columns_by_name.end()) {
                        table_column = column_iter->second;
                    }
                }
            } else {
                for (auto& [table_id, table] : target_scope->unnamed_tables) {
                    auto& table_columns_by_name = table.get().table_columns_by_name;
                    auto column_iter = table_columns_by_name.find(column_name);
                    if (column_iter != table_columns_by_name.end()) {
                        table_column = column_iter->second;
                        break;
                    }
                }
            }
            // Found a table column?
            if (table_column.has_value()) {
                auto& resolved_column = table_column.value().get();
                auto& resolved_table = resolved_column.table->get();
                expr.inner = AnalyzedScript::Expression::ResolvedColumnRef{
                    .column_name = unresolved.column_name,
                    .catalog_database_id = resolved_table.catalog_database_id,
                    .catalog_schema_id = resolved_table.catalog_schema_id,
                    .catalog_table_id = resolved_table.catalog_table_id,
                    .table_column_id = resolved_column.column_index,
                };
                auto dead_iter = iter++;
                unresolved_columns.erase(dead_iter);
            } else {
                ++iter;
            }
        }
    }
}

void NameResolutionPass::ResolveNames() {
    // Create column ref maps
    ColumnRefsByAlias tmp_refs_by_alias;
    ColumnRefsByAlias tmp_refs_by_name;
    tmp_refs_by_alias.reserve(analyzed.expressions.GetSize());
    tmp_refs_by_name.reserve(analyzed.expressions.GetSize());

    // Recursively traverse down the scopes
    std::stack<std::reference_wrapper<AnalyzedScript::NameScope>> pending_scopes;
    for (auto& scope : root_scopes) {
        pending_scopes.push(*scope);
    }
    while (!pending_scopes.empty()) {
        auto& top = pending_scopes.top();
        pending_scopes.pop();
        ResolveTableRefsInScope(top);
        tmp_refs_by_alias.clear();
        tmp_refs_by_name.clear();
        ResolveColumnRefsInScope(top, tmp_refs_by_alias, tmp_refs_by_name);
        for (auto& child_scope : top.get().child_scopes) {
            pending_scopes.push(child_scope);
        }
    }
}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}

/// Visit a chunk of nodes
void NameResolutionPass::Visit(std::span<proto::Node> morsel) {
    // XXX What about:
    //  indirections? c_expr
    //  subquery with alias

    // Scan nodes in morsel
    size_t morsel_offset = morsel.data() - ast.data();
    for (size_t i = 0; i < morsel.size(); ++i) {
        // Resolve the node
        proto::Node& node = morsel[i];
        NodeID node_id = morsel_offset + i;
        // Create empty node state
        NodeState& node_state = node_states[node_id];

        // Check node type
        switch (node.node_type()) {
            // Read a column definition
            case proto::NodeType::OBJECT_SQL_COLUMN_DEF: {
                auto children = ast.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_def_node = attrs[proto::AttributeKey::SQL_COLUMN_DEF_NAME];
                if (column_def_node && column_def_node->node_type() == sx::NodeType::NAME) {
                    auto& name = scanned.GetNames().At(column_def_node->children_begin_or_value());
                    name.resolved_tags |= sx::NameTag::COLUMN_NAME;
                    if (auto reused = pending_columns_free_list.PopFront()) {
                        *reused = AnalyzedScript::TableColumn(node_id, name);
                        node_state.table_columns.PushBack(*reused);
                    } else {
                        auto& node = pending_columns.Append(AnalyzedScript::TableColumn(node_id, name));
                        node_state.table_columns.PushBack(node);
                    }
                }
                break;
            }

            // Read a column reference
            case proto::NodeType::OBJECT_SQL_COLUMN_REF: {
                // Read column ref path
                auto children = ast.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_ref_node = attrs[proto::AttributeKey::SQL_COLUMN_REF_PATH];
                auto column_name = ReadQualifiedColumnName(column_ref_node);
                if (column_name.has_value()) {
                    // Add column reference
                    auto& n = analyzed.expressions.Append(AnalyzedScript::Expression());
                    n.buffer_index = analyzed.expressions.GetSize() - 1;
                    n.value.expression_id =
                        ExternalObjectID{catalog_entry_id, static_cast<uint32_t>(analyzed.expressions.GetSize() - 1)};
                    n.value.ast_node_id = node_id;
                    n.value.ast_statement_id = std::nullopt;
                    n.value.ast_scope_root = std::nullopt;
                    n.value.inner = AnalyzedScript::Expression::UnresolvedColumnRef{.column_name = column_name.value()};
                    node_state.column_references.PushBack(n);
                }
                // Column refs may be recursive
                MergeChildStates(node_state, node);
                break;
            }

            // Read a table reference
            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                // Read a table ref name
                auto children = ast.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                // Only consider table refs with a name for now
                if (auto name_node = attrs[proto::AttributeKey::SQL_TABLEREF_NAME]) {
                    auto name = ReadQualifiedTableName(name_node);
                    if (name.has_value()) {
                        // Read a table alias
                        std::string_view alias_str;
                        auto alias_node = attrs[proto::AttributeKey::SQL_TABLEREF_ALIAS];
                        std::optional<std::reference_wrapper<RegisteredName>> alias_name = std::nullopt;
                        if (alias_node && alias_node->node_type() == sx::NodeType::NAME) {
                            auto& alias = scanned.GetNames().At(alias_node->children_begin_or_value());
                            alias.resolved_tags |= sx::NameTag::TABLE_ALIAS;
                            alias_str = alias;
                            alias_name = alias;
                        }
                        // Add table reference
                        auto& n = analyzed.table_references.Append(AnalyzedScript::TableReference(alias_name));
                        n.buffer_index = analyzed.table_references.GetSize() - 1;
                        n.value.table_reference_id = ExternalObjectID{
                            catalog_entry_id, static_cast<uint32_t>(analyzed.table_references.GetSize() - 1)};
                        n.value.ast_node_id = node_id;
                        n.value.ast_statement_id = std::nullopt;
                        n.value.ast_scope_root = std::nullopt;
                        n.value.inner =
                            AnalyzedScript::TableReference::UnresolvedRelationExpression{.table_name = name.value()};
                        node_state.table_references.PushBack(n);
                    }
                }
                // Table refs may be recursive
                MergeChildStates(node_state, node);
                break;
            }

            // Finish select statement
            case proto::NodeType::OBJECT_SQL_SELECT: {
                MergeChildStates(node_state, node);
                CreateScope(node_state, node_id);
                break;
            }

            // Finish create table statement
            case proto::NodeType::OBJECT_SQL_CREATE: {
                auto attrs = attribute_index.Load(ast.subspan(node.children_begin_or_value(), node.children_count()));
                const proto::Node* name_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                const proto::Node* elements_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_ELEMENTS];
                // Read the name
                auto table_name = ReadQualifiedTableName(name_node);
                if (table_name.has_value()) {
                    // Register the database
                    auto [db_id, schema_id] = RegisterSchema(table_name->database_name, table_name->schema_name);
                    // Determine the catalog table id
                    ExternalObjectID catalog_table_id{catalog_entry_id,
                                                      static_cast<uint32_t>(analyzed.table_declarations.GetSize())};
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
                    auto& n = analyzed.table_declarations.Append(AnalyzedScript::TableDeclaration(table_name.value()));
                    n.catalog_table_id = catalog_table_id;
                    n.catalog_database_id = db_id;
                    n.catalog_schema_id = schema_id;
                    n.ast_node_id = node_id;
                    n.table_columns = std::move(table_columns);
                    // Register the table declaration
                    table_name->table_name.get().resolved_objects.PushBack(n);
                    // Update the table ref and index of all columns
                    n.table_columns_by_name.reserve(n.table_columns.size());
                    for (size_t column_index = 0; column_index != n.table_columns.size(); ++column_index) {
                        auto& column = n.table_columns[column_index];
                        column.table = n;
                        column.column_index = column_index;
                        column.column_name.get().resolved_objects.PushBack(column);
                        n.table_columns_by_name.insert({column.column_name.get().text, column});
                    }
                }
                break;
            }

            // Finish create table statement
            case proto::NodeType::OBJECT_SQL_CREATE_AS: {
                auto attrs = attribute_index.Load(ast.subspan(node.children_begin_or_value(), node.children_count()));
                auto name_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                auto columns_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                auto elements_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_ELEMENTS];

                (void)name_node;
                (void)columns_node;
                (void)elements_node;
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
    analyzed.tables_by_name.reserve(analyzed.table_declarations.GetSize());
    for (auto& table_chunk : analyzed.table_declarations.GetChunks()) {
        for (auto& table : table_chunk) {
            analyzed.tables_by_name.insert({table.table_name, table});
        }
    }

    // Resolve all names
    ResolveNames();

    // Bail out if there are no statements
    if (!parsed.statements.empty()) {
        // Helper to assign statement ids
        auto assign_statment_ids = [&](auto& chunks) {
            uint32_t statement_id = 0;
            size_t statement_begin = parsed.statements[0].nodes_begin;
            size_t statement_end = statement_begin + parsed.statements[0].node_count;
            for (auto& chunk : chunks) {
                for (auto& ref : chunk) {
                    // Node ids should only be missing for external tables.
                    // Assert that we only store table_refs of internal tables.
                    assert(ref.value.ast_node_id.has_value());
                    // Get the location
                    auto ast_node_id = ref.value.ast_node_id.value();
                    // Search first statement that might include the node
                    while (statement_end <= ast_node_id && statement_id < parsed.statements.size()) {
                        ++statement_id;
                        statement_begin = parsed.statements[statement_id].nodes_begin;
                        statement_end = statement_begin + parsed.statements[statement_id].node_count;
                    }
                    // There is none?
                    // Abort, all other refs won't match either
                    if (statement_id == parsed.statements.size()) {
                        break;
                    }
                    // The statement includes the node?
                    if (statement_begin <= ast_node_id) {
                        ref.value.ast_statement_id = statement_id;
                        continue;
                    }
                    // Otherwise lthe ast_node does not belong to a statement, check next one
                }
            }
        };
        assign_statment_ids(analyzed.table_references.GetChunks());
        assign_statment_ids(analyzed.expressions.GetChunks());
    }

    // Index the table declarations
    analyzed.table_declarations.ForEach([&](size_t ti, auto& table) {
        for (size_t i = 0; i < table.table_columns.size(); ++i) {
            auto& column = table.table_columns[i];
            analyzed.table_columns_by_name.insert({column.column_name.get().text, column});
        }
    });
}

}  // namespace sqlynx
