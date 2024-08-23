#include "sqlynx/analyzer/name_resolution_pass.h"

#include <functional>
#include <iterator>
#include <optional>
#include <stack>

#include "sqlynx/catalog.h"
#include "sqlynx/external.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/overlay_list.h"

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
NameResolutionPass::NameResolutionPass(ParsedScript& parser, Catalog& catalog, AttributeIndex& attribute_index)
    : scanned_program(*parser.scanned_script),
      parsed_program(parser),
      catalog_entry_id(parser.external_id),
      catalog(catalog),
      attribute_index(attribute_index),
      nodes(parsed_program.nodes),
      default_database_name(parser.scanned_script->name_registry.Register(catalog.GetDefaultDatabaseName())),
      default_schema_name(parser.scanned_script->name_registry.Register(catalog.GetDefaultSchemaName())) {
    node_states.resize(nodes.size());
    default_database_name.resolved_tags |= proto::NameTag::DATABASE_NAME;
    default_schema_name.resolved_tags |= proto::NameTag::SCHEMA_NAME;
}

std::span<std::reference_wrapper<RegisteredName>> NameResolutionPass::ReadNamePath(const sx::Node& node) {
    if (node.node_type() != proto::NodeType::ARRAY) {
        return {};
    }
    name_path_buffer.clear();
    auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
    for (size_t i = 0; i != children.size(); ++i) {
        // A child is either a name, an indirection or an operator (*).
        // We only consider plan name paths for now and extend later.
        auto& child = children[i];
        if (child.node_type() != proto::NodeType::NAME) {
            name_path_buffer.clear();
            break;
        }
        auto& name = scanned_program.GetNames().At(child.children_begin_or_value());
        name_path_buffer.push_back(name);
    }
    return std::span{name_path_buffer};
}

std::optional<AnalyzedScript::QualifiedTableName> NameResolutionPass::ReadQualifiedTableName(const sx::Node* node) {
    if (!node) {
        return std::nullopt;
    }
    auto name_path = ReadNamePath(*node);
    auto ast_node_id = node - nodes.data();
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
    auto ast_node_id = node - nodes.data();
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
    auto db_ref_iter = databases_by_name.find(database_name);
    if (db_ref_iter == databases_by_name.end()) {
        db_id = catalog.AllocateDatabaseId(database_name);
        auto& db = database_references.Append(CatalogEntry::DatabaseReference{db_id, database_name, ""});
        databases_by_name.insert({db.database_name, db});
        database_name.resolved_objects.PushBack(db);
    } else {
        db_id = db_ref_iter->second.get().catalog_database_id;
    }
    // Register the schema
    auto schema_ref_iter = schemas_by_name.find({database_name, schema_name});
    if (schema_ref_iter == schemas_by_name.end()) {
        schema_id = catalog.AllocateSchemaId(database_name, schema_name);
        auto& schema =
            schema_references.Append(CatalogEntry::SchemaReference{db_id, schema_id, database_name, schema_name});
        schemas_by_name.insert({{database_name, schema_name}, schema});
        schema_name.resolved_objects.PushBack(schema);
    } else {
        schema_id = schema_ref_iter->second.get().catalog_schema_id;
    }
    return {db_id, schema_id};
}

void NameResolutionPass::MergeChildStates(NodeState& dst, std::initializer_list<const proto::Node*> children) {
    for (const proto::Node* child : children) {
        if (!child) continue;
        dst.Merge(std::move(node_states[child - nodes.data()]));
    }
}

void NameResolutionPass::MergeChildStates(NodeState& dst, const proto::Node& parent) {
    for (size_t i = 0; i < parent.children_count(); ++i) {
        auto child_id = parent.children_begin_or_value() + i;
        auto& child = node_states[parent.children_begin_or_value() + i];
        dst.Merge(std::move(child));
    }
}

NameResolutionPass::NameScope& NameResolutionPass::CreateScope(NodeState& target, uint32_t scope_root) {
    auto& scope = name_scopes.Append(
        NameScope{.ast_scope_root = scope_root, .parent_scope = nullptr, .child_scopes = target.child_scopes});
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
    scope.value.column_references = target.column_references;
    // Clear the target since we're starting a new scope now
    target.Clear();
    // Remember the child scope
    target.child_scopes.PushBack(scope);
    root_scopes.insert(&scope.value);
    return scope.value;
}

void NameResolutionPass::ResolveTableRefsInScope(NameScope& scope) {
    for (auto& table_ref : scope.table_references) {
        // TODO Matches a view or CTE?

        // Table ref points to own table?
        auto iter = tables_by_name.find(table_ref.table_name);
        if (iter != tables_by_name.end()) {
            auto& table = iter->second.get();

            // Remember resolved table
            scope.resolved_table_references.insert({&table_ref, table});
            table_ref.resolved_catalog_database_id = table.catalog_database_id;
            table_ref.resolved_catalog_schema_id = table.catalog_schema_id;
            table_ref.resolved_catalog_table_id = table.catalog_table_id;

            // Remember all available columns
            for (size_t i = 0; i < table.table_columns.size(); ++i) {
                auto& column = table.table_columns[i];
                scope.resolved_table_columns.insert(
                    {CatalogEntry::QualifiedColumnName::Key{
                         table_ref.alias_name.has_value() ? table_ref.alias_name.value().get().text : "",
                         column.column_name.get().text},
                     ResolvedTableColumn{.alias_name = table_ref.alias_name,
                                         .column_name = column.column_name,
                                         .table = table,
                                         .column_id = i,
                                         .table_reference_id = table_ref.table_reference_id}});
            }
            continue;
        }

        // Qualify table name for search path lookup
        CatalogEntry::QualifiedTableName qualified_table_name = table_ref.table_name;
        // Otherwise consult the external search path
        if (auto resolved = catalog.ResolveTable(qualified_table_name, catalog_entry_id)) {
            // Remember resolved table
            scope.resolved_table_references.insert({&table_ref, *resolved});
            table_ref.resolved_catalog_database_id = resolved->catalog_database_id;
            table_ref.resolved_catalog_schema_id = resolved->catalog_schema_id;
            table_ref.resolved_catalog_table_id = resolved->catalog_table_id;

            // Collect all available columns
            for (size_t i = 0; i < resolved->table_columns.size(); ++i) {
                auto& column = resolved->table_columns[i];
                scope.resolved_table_columns.insert(
                    {CatalogEntry::QualifiedColumnName::Key{
                         table_ref.alias_name ? table_ref.alias_name->get().text : "", column.column_name.get()},
                     ResolvedTableColumn{.alias_name = table_ref.alias_name,
                                         .column_name = column.column_name,
                                         .table = *resolved,
                                         .column_id = i,
                                         .table_reference_id = table_ref.table_reference_id}});
            }
            continue;
        }

        // Failed to resolve the table ref, leave unresolved
    }
}

void NameResolutionPass::ResolveColumnRefsInScope(NameScope& scope, ColumnRefsByAlias& refs_by_alias,
                                                  ColumnRefsByName& refs_by_name) {
    std::list<std::reference_wrapper<AnalyzedScript::ColumnReference>> unresolved_columns;
    for (auto& column_ref : scope.column_references) {
        unresolved_columns.push_back(column_ref);
    }
    // Resolve refs in the scope upwards
    for (auto target_scope = &scope; target_scope != nullptr; target_scope = target_scope->parent_scope) {
        for (auto column_ref_iter = unresolved_columns.begin(); column_ref_iter != unresolved_columns.end();) {
            auto& column_ref = column_ref_iter->get();
            auto& column_name = column_ref.column_name;
            auto resolved_iter = target_scope->resolved_table_columns.find(
                {column_name.table_alias ? column_name.table_alias->get().text : "", column_name.column_name.get()});
            if (resolved_iter != target_scope->resolved_table_columns.end()) {
                auto& resolved = resolved_iter->second;
                column_ref.resolved_catalog_database_id = resolved.table.catalog_database_id;
                column_ref.resolved_catalog_schema_id = resolved.table.catalog_schema_id;
                column_ref.resolved_catalog_table_id = resolved.table.catalog_table_id;
                column_ref.resolved_table_column_id = resolved.column_id;
                auto dead_iter = column_ref_iter++;
                unresolved_columns.erase(dead_iter);
            } else {
                ++column_ref_iter;
            }
        }
    }
}

void NameResolutionPass::ResolveNames() {
    // Create column ref maps
    ColumnRefsByAlias tmp_refs_by_alias;
    ColumnRefsByAlias tmp_refs_by_name;
    tmp_refs_by_alias.reserve(column_references.GetSize());
    tmp_refs_by_name.reserve(column_references.GetSize());

    // Recursively traverse down the scopes
    std::stack<std::reference_wrapper<NameScope>> pending_scopes;
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
    // Scan nodes in morsel
    size_t morsel_offset = morsel.data() - nodes.data();
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
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_def_node = attrs[proto::AttributeKey::SQL_COLUMN_DEF_NAME];
                if (column_def_node && column_def_node->node_type() == sx::NodeType::NAME) {
                    auto& name = scanned_program.GetNames().At(column_def_node->children_begin_or_value());
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
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_ref_node = attrs[proto::AttributeKey::SQL_COLUMN_REF_PATH];
                auto column_name = ReadQualifiedColumnName(column_ref_node);
                if (column_name.has_value()) {
                    // Add column reference
                    auto& n = column_references.Append(AnalyzedScript::ColumnReference(column_name.value()));
                    n.buffer_index = column_references.GetSize() - 1;
                    n.value.column_reference_id =
                        ExternalObjectID{catalog_entry_id, static_cast<uint32_t>(column_references.GetSize() - 1)};
                    n.value.ast_node_id = node_id;
                    n.value.ast_statement_id = std::nullopt;
                    n.value.ast_scope_root = std::nullopt;
                    n.value.resolved_catalog_database_id = std::numeric_limits<uint32_t>::max();
                    n.value.resolved_catalog_schema_id = std::numeric_limits<uint32_t>::max();
                    n.value.resolved_catalog_table_id = ExternalObjectID();
                    n.value.resolved_table_column_id = std::nullopt;
                    node_state.column_references.PushBack(n);
                }
                // Column refs may be recursive
                MergeChildStates(node_state, node);
                break;
            }

            // Read a table reference
            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                // Read a table ref name
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
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
                            auto& alias = scanned_program.GetNames().At(alias_node->children_begin_or_value());
                            alias.resolved_tags |= sx::NameTag::TABLE_ALIAS;
                            alias_str = alias;
                            alias_name = alias;
                        }
                        // Add table reference
                        auto& n = table_references.Append(AnalyzedScript::TableReference(name.value(), alias_name));
                        n.buffer_index = table_references.GetSize() - 1;
                        n.value.table_reference_id =
                            ExternalObjectID{catalog_entry_id, static_cast<uint32_t>(table_references.GetSize() - 1)};
                        n.value.ast_node_id = node_id;
                        n.value.ast_statement_id = std::nullopt;
                        n.value.ast_scope_root = std::nullopt;
                        n.value.resolved_catalog_database_id = std::numeric_limits<uint32_t>::max();
                        n.value.resolved_catalog_schema_id = std::numeric_limits<uint32_t>::max();
                        n.value.resolved_catalog_table_id = ExternalObjectID();
                        node_state.table_references.PushBack(n);
                    }
                }
                // Table refs may be recursive
                MergeChildStates(node_state, node);
                break;
            }

            // Read an n-ary expression
            case proto::NodeType::OBJECT_SQL_NARY_EXPRESSION: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                auto op_node = attrs[proto::AttributeKey::SQL_EXPRESSION_OPERATOR];

                // Get arg nodes
                auto args_node = attrs[proto::AttributeKey::SQL_EXPRESSION_ARGS];
                size_t args_begin = 0;
                size_t args_count = 0;
                if (args_node && args_node->node_type() == sx::NodeType::ARRAY) {
                    args_begin = args_node->children_begin_or_value();
                    args_count = args_node->children_count();
                }

                // Has expression operator
                if (op_node && op_node->node_type() == sx::NodeType::ENUM_SQL_EXPRESSION_OPERATOR) {
                    auto func = static_cast<proto::ExpressionOperator>(op_node->children_begin_or_value());
                    switch (func) {
                        // And operator?
                        case proto::ExpressionOperator::AND:
                        case proto::ExpressionOperator::OR:
                        case proto::ExpressionOperator::XOR:
                            break;

                        // Comparison operator? - Finish dependencies.
                        case proto::ExpressionOperator::EQUAL:
                        case proto::ExpressionOperator::GREATER_EQUAL:
                        case proto::ExpressionOperator::GREATER_THAN:
                        case proto::ExpressionOperator::LESS_EQUAL:
                        case proto::ExpressionOperator::LESS_THAN:
                        case proto::ExpressionOperator::NOT_EQUAL: {
                            assert(args_count == 2);
                            auto qualifies = [&](size_t idx) {
                                // XXX Should we emit subselect hyperedges?
                                // nodes[idx].node_type() != proto::NodeType::OBJECT_SQL_SELECT_EXPRESSION;
                                return node_states[idx].column_references.GetSize() >= 1;
                            };
                            if (qualifies(args_begin) && qualifies(args_begin + 1)) {
                                auto& l = node_states[args_begin];
                                auto& r = node_states[args_begin + 1];
                                graph_edges.Append(AnalyzedScript::QueryGraphEdge(node_id, graph_edge_nodes.GetSize(),
                                                                                  l.column_references.GetSize(),
                                                                                  r.column_references.GetSize(), func));
                                for (auto iter = l.column_references.begin(); iter != l.column_references.end();
                                     ++iter) {
                                    graph_edge_nodes.Append(AnalyzedScript::QueryGraphEdgeNode(iter.GetBufferIndex()));
                                }
                                for (auto iter = r.column_references.begin(); iter != r.column_references.end();
                                     ++iter) {
                                    graph_edge_nodes.Append(AnalyzedScript::QueryGraphEdgeNode(iter.GetBufferIndex()));
                                }
                            }
                            break;
                        }

                        // Other operators
                        case proto::ExpressionOperator::AT_TIMEZONE:
                        case proto::ExpressionOperator::BETWEEN_ASYMMETRIC:
                        case proto::ExpressionOperator::BETWEEN_SYMMETRIC:
                        case proto::ExpressionOperator::COLLATE:
                        case proto::ExpressionOperator::DEFAULT:
                        case proto::ExpressionOperator::DIVIDE:
                        case proto::ExpressionOperator::GLOB:
                        case proto::ExpressionOperator::ILIKE:
                        case proto::ExpressionOperator::IN:
                        case proto::ExpressionOperator::IS_DISTINCT_FROM:
                        case proto::ExpressionOperator::IS_FALSE:
                        case proto::ExpressionOperator::IS_NOT_DISTINCT_FROM:
                        case proto::ExpressionOperator::IS_NOT_FALSE:
                        case proto::ExpressionOperator::IS_NOT_OF:
                        case proto::ExpressionOperator::IS_NOT_TRUE:
                        case proto::ExpressionOperator::IS_NOT_UNKNOWN:
                        case proto::ExpressionOperator::IS_NULL:
                        case proto::ExpressionOperator::IS_OF:
                        case proto::ExpressionOperator::IS_TRUE:
                        case proto::ExpressionOperator::IS_UNKNOWN:
                        case proto::ExpressionOperator::LIKE:
                        case proto::ExpressionOperator::MINUS:
                        case proto::ExpressionOperator::MODULUS:
                        case proto::ExpressionOperator::MULTIPLY:
                        case proto::ExpressionOperator::NEGATE:
                        case proto::ExpressionOperator::NOT:
                        case proto::ExpressionOperator::NOT_BETWEEN_ASYMMETRIC:
                        case proto::ExpressionOperator::NOT_BETWEEN_SYMMETRIC:
                        case proto::ExpressionOperator::NOT_GLOB:
                        case proto::ExpressionOperator::NOT_ILIKE:
                        case proto::ExpressionOperator::NOT_IN:
                        case proto::ExpressionOperator::NOT_LIKE:
                        case proto::ExpressionOperator::NOT_NULL:
                        case proto::ExpressionOperator::NOT_SIMILAR_TO:
                        case proto::ExpressionOperator::OVERLAPS:
                        case proto::ExpressionOperator::PLUS:
                        case proto::ExpressionOperator::SIMILAR_TO:
                        case proto::ExpressionOperator::TYPECAST:
                            break;
                    }
                }

                // Merge all child states
                if (args_node) {
                    MergeChildStates(node_state, *args_node);
                }
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
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                const proto::Node* name_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                const proto::Node* elements_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_ELEMENTS];
                // Read the name
                auto table_name = ReadQualifiedTableName(name_node);
                if (table_name.has_value()) {
                    // Register the database
                    auto [db_id, schema_id] = RegisterSchema(table_name->database_name, table_name->schema_name);
                    // Determine the catalog table id
                    ExternalObjectID catalog_table_id{catalog_entry_id,
                                                      static_cast<uint32_t>(table_declarations.GetSize())};
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
                    // Store the catalog ids in the table columns
                    for (size_t column_index = 0; column_index != table_columns.size(); ++column_index) {
                        auto& column = table_columns[column_index];
                        column.catalog_database_id = db_id;
                        column.catalog_schema_id = schema_id;
                        column.catalog_table_id = catalog_table_id;
                        column.column_index = column_index;
                        column.column_name.get().resolved_objects.PushBack(column);
                    }

                    // Create the scope
                    CreateScope(node_state, node_id);
                    // Build the table
                    auto& n = table_declarations.Append(AnalyzedScript::TableDeclaration(table_name.value()));
                    n.catalog_table_id = catalog_table_id;
                    n.catalog_database_id = db_id;
                    n.catalog_schema_id = schema_id;
                    n.ast_node_id = node_id;
                    n.table_columns = std::move(table_columns);
                    // Register the table declaration
                    table_name->table_name.get().resolved_objects.PushBack(n);
                }
                break;
            }

            // Finish create table statement
            case proto::NodeType::OBJECT_SQL_CREATE_AS: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                auto name_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                auto columns_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                auto elements_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_ELEMENTS];

                (void)name_node;
                (void)columns_node;
                (void)elements_node;
                break;
            }

            // Preserve state of individual array elements for expression args.
            case proto::NodeType::ARRAY: {
                if (node.attribute_key() != proto::AttributeKey::SQL_EXPRESSION_ARGS) {
                    MergeChildStates(node_state, node);
                }
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
    tables_by_name.reserve(table_declarations.GetSize());
    for (auto& table_chunk : table_declarations.GetChunks()) {
        for (auto& table : table_chunk) {
            tables_by_name.insert({table.table_name, table});
        }
    }

    // Resolve all names
    ResolveNames();

    // Bail out if there are no statements
    if (!parsed_program.statements.empty()) {
        // Helper to assign statement ids
        auto assign_statment_ids = [&](auto& chunks) {
            uint32_t statement_id = 0;
            size_t statement_begin = parsed_program.statements[0].nodes_begin;
            size_t statement_end = statement_begin + parsed_program.statements[0].node_count;
            for (auto& chunk : chunks) {
                for (auto& ref : chunk) {
                    // Node ids should only be missing for external tables.
                    // Assert that we only store table_refs of internal tables.
                    assert(ref.value.ast_node_id.has_value());
                    // Get the location
                    auto ast_node_id = ref.value.ast_node_id.value();
                    // Search first statement that might include the node
                    while (statement_end <= ast_node_id && statement_id < parsed_program.statements.size()) {
                        ++statement_id;
                        statement_begin = parsed_program.statements[statement_id].nodes_begin;
                        statement_end = statement_begin + parsed_program.statements[statement_id].node_count;
                    }
                    // There is none?
                    // Abort, all other refs won't match either
                    if (statement_id == parsed_program.statements.size()) {
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
        assign_statment_ids(table_references.GetChunks());
        assign_statment_ids(column_references.GetChunks());
    }
}

/// Export an analyzed program
void NameResolutionPass::Export(AnalyzedScript& program) {
    program.database_references = std::move(database_references);
    program.databases_by_name = std::move(databases_by_name);
    program.schema_references = std::move(schema_references);
    program.schemas_by_name = std::move(schemas_by_name);
    program.table_declarations = std::move(table_declarations);
    program.tables_by_name = std::move(tables_by_name);
    program.graph_edges = graph_edges.Flatten();
    program.graph_edge_nodes = graph_edge_nodes.Flatten();

    program.table_references.reserve(table_references.GetSize());
    for (auto& chunk : table_references.GetChunks()) {
        for (auto& ref : chunk) {
            program.table_references.push_back(std::move(ref.value));
        }
    }
    program.column_references.reserve(column_references.GetSize());
    for (auto& chunk : column_references.GetChunks()) {
        for (auto& ref : chunk) {
            program.column_references.push_back(std::move(ref.value));
        }
    }
    for (auto& table : program.table_declarations) {
        for (size_t i = 0; i < table.table_columns.size(); ++i) {
            auto& column = table.table_columns[i];
            program.table_columns_by_name.insert({column.column_name.get().text, {table, i}});
        }
    }
}

}  // namespace sqlynx
