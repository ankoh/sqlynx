#include "flatsql/analyzer/name_resolution_pass.h"

#include <iterator>
#include <limits>
#include <stack>

#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {

/// Helper to merge two vectors
template <typename T> static void merge(std::vector<T>& left, std::vector<T>&& right) {
    if (right.empty()) {
        left = std::move(right);
    } else {
        left.insert(left.end(), std::make_move_iterator(right.begin()), std::make_move_iterator(right.end()));
        right.clear();
    }
}

/// Merge two node states
void NameResolutionPass::NodeState::Merge(NodeState&& other) {
    merge(table_columns, std::move(other.table_columns));
    merge(table_references, std::move(other.table_references));
    merge(column_references, std::move(other.column_references));
}

/// Constructor
NameResolutionPass::NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index)
    : scanned_program(parser.scan),
      parsed_program(parser),
      attribute_index(attribute_index),
      nodes(parsed_program.nodes) {}

/// Register external tables from an analyzed program
void NameResolutionPass::RegisterExternalTables(const AnalyzedProgram& external) {
    // Use a map for external names and assign them new ids.
    // We don't map (external string -> new string) but instead just track (external id -> new id).
    //
    // For each external id:
    //      Check if the external id is already mapped,
    //      If not, get string and lookup local string id.
    //      If not matching any local name, create new id mapping for external name
    //
    // That way, we only need to track how many external tables were imported and can offset local table ids by that
    // amount. That is, `table_id = external_tables.size() + offset in tables`

    // Helper to remap a name id
    auto map_name = [this](const AnalyzedProgram& external, NameID name) {
        if (name == std::numeric_limits<NameID>::max()) return name;
        // First check if the external id is already mapped,
        if (auto iter = external_names.find(name); iter != external_names.end()) {
            return iter->second;
        }
        // If not, get name string and lookup local name
        if (auto iter = scanned_program.name_dictionary_ids.find(external.scanned.name_dictionary[name].first);
            iter != scanned_program.name_dictionary_ids.end()) {
            external_names.insert({name, iter->second});
            return iter->second;
        }
        // If not matching any local, create new mapping
        NameID mapped_id = external_names.size();
        external_names.insert({name, mapped_id});
        return mapped_id;
    };

    // Copy all over
    external_tables = external.tables.Flatten();
    external_table_columns = external.table_columns.Flatten();
    external_names.clear();
    external_names.reserve(external.scanned.name_dictionary_ids.size());
    external_table_ids.clear();
    external_table_ids.reserve(external_tables.size());

    // Map tables
    for (size_t table_id = 0; table_id < external_tables.size(); ++table_id) {
        auto& t = external_tables[table_id];
        proto::QualifiedTableName name = t.table_name();
        name.mutate_database_name(map_name(external, name.database_name()));
        name.mutate_schema_name(map_name(external, name.schema_name()));
        name.mutate_table_name(map_name(external, name.table_name()));
        t.mutate_ast_node_id(Analyzer::ID());
        t.mutate_ast_statement_id(Analyzer::ID());
        external_table_ids.insert({name, Analyzer::ID(table_id, true)});
    }
    // Map columns
    for (auto& c : external_table_columns) {
        c.mutate_column_name(map_name(external, c.column_name()));
        c.mutate_ast_node_id(Analyzer::ID());
    }
}

std::span<NameID> NameResolutionPass::ReadNamePath(const sx::Node& node) {
    if (node.node_type() != proto::NodeType::ARRAY) {
        return {};
    }
    tmp_name_path.clear();
    auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
    for (size_t i = 0; i != children.size(); ++i) {
        // A child is either a name, an indirection or an operator (*).
        // We only consider plan name paths for now and extend later.
        auto& child = children[i];
        if (child.node_type() != proto::NodeType::NAME) {
            tmp_name_path.clear();
            break;
        }
        tmp_name_path.push_back(child.children_begin_or_value());
    }
    return std::span{tmp_name_path};
}

proto::QualifiedTableName NameResolutionPass::ReadQualifiedTableName(const sx::Node* node) {
    proto::QualifiedTableName name{Analyzer::ID(), Analyzer::ID(), Analyzer::ID(), Analyzer::ID()};
    if (!node) {
        return name;
    }
    auto name_path = ReadNamePath(*node);
    name.mutate_ast_node_id(node - nodes.data());
    switch (tmp_name_path.size()) {
        case 3:
            name.mutate_schema_name(name_path[0]);
            name.mutate_database_name(name_path[1]);
            name.mutate_table_name(name_path[2]);
            break;
        case 2:
            name.mutate_database_name(name_path[0]);
            name.mutate_table_name(name_path[1]);
            break;
        case 1:
            name.mutate_table_name(name_path[0]);
            break;
        default:
            break;
    }
    return name;
}

proto::QualifiedColumnName NameResolutionPass::ReadQualifiedColumnName(const sx::Node* node) {
    proto::QualifiedColumnName name{Analyzer::ID(), Analyzer::ID(), Analyzer::ID()};
    if (!node) {
        return name;
    }
    auto name_path = ReadNamePath(*node);
    name.mutate_ast_node_id(node - nodes.data());
    // Build the qualified column name
    switch (name_path.size()) {
        case 2:
            name.mutate_table_alias(name_path[0]);
            name.mutate_column_name(name_path[1]);
            break;
        case 1:
            name.mutate_column_name(name_path[0]);
            break;
        default:
            break;
    }
    return name;
}

void NameResolutionPass::CloseScope(NodeState& target, size_t node_id) {
    target.table_columns.clear();
    for (size_t i : target.tables) {
        if (!Analyzer::ID(tables[i].ast_scope_root())) {
            tables[i].mutate_ast_scope_root(node_id);
        }
    }
    for (size_t i : target.table_references) {
        if (!Analyzer::ID(table_references[i].ast_scope_root())) {
            table_references[i].mutate_ast_scope_root(node_id);
        }
    }
    for (size_t i : target.column_references) {
        if (!Analyzer::ID(column_references[i].ast_scope_root())) {
            column_references[i].mutate_ast_scope_root(node_id);
        }
    }
}

void NameResolutionPass::MergeChildStates(NodeState& dst, std::initializer_list<const proto::Node*> children) {
    for (const proto::Node* child : children) {
        if (!child) continue;
        dst.Merge(std::move(node_states[child - nodes.data()].value()));
    }
}

void NameResolutionPass::MergeChildStates(NodeState& dst, const proto::Node& parent) {
    for (size_t i = 0; i < parent.children_count(); ++i) {
        auto child_id = parent.children_begin_or_value() + i;
        auto& child = node_states[parent.children_begin_or_value() + i];
        assert(node_states[child_id].has_value());
        dst.Merge(std::move(child.value()));
    }
}

void NameResolutionPass::ResolveNames(NodeState& state) {
    // Build a map with all table names that are in scope
    ankerl::unordered_dense::map<Analyzer::TableKey, Analyzer::ID, Analyzer::TableKey::Hasher> local_tables;
    size_t max_column_count = 0;
    for (size_t table_id : state.tables) {
        proto::Table& table = tables[table_id];
        // Table declarations are out of scope if they have a scope root set
        if (Analyzer::ID(table.ast_scope_root())) {
            continue;
        }
        // Register as local table if in scope
        proto::QualifiedTableName table_name = table.table_name();
        max_column_count += table.column_count();
        local_tables.insert({table_name, Analyzer::ID(table_id, false)});
    }

    // Collect all columns that are in scope
    ankerl::unordered_dense::map<Analyzer::ColumnKey, std::pair<Analyzer::ID, size_t>, Analyzer::ColumnKey::Hasher>
        columns;
    columns.reserve(max_column_count);
    for (size_t table_ref_id : state.table_references) {
        proto::TableReference& table_ref = table_references[table_ref_id];
        // Table references are out of scope if they have a scope root set
        if (Analyzer::ID(table_ref.ast_scope_root())) {
            continue;
        }
        // Helper to register columns from a table
        auto register_columns_from = [&](Analyzer::ID tid) {
            if (tid.IsExternal()) {
                proto::Table& resolved = external_tables[tid.AsIndex()];
                for (uint32_t cid = 0; cid < resolved.column_count(); ++cid) {
                    proto::TableColumn& col = external_table_columns[resolved.columns_begin() + cid];
                    proto::QualifiedColumnName col_name{table_ref.ast_node_id(), table_ref.alias_name(),
                                                        col.column_name()};
                    columns.insert({col_name, {tid, cid}});
                }
            } else {
                proto::Table& resolved = tables[tid.AsIndex()];
                for (uint32_t cid = 0; cid < resolved.column_count(); ++cid) {
                    proto::TableColumn& col = table_columns[resolved.columns_begin() + cid];
                    proto::QualifiedColumnName col_name{table_ref.ast_node_id(), table_ref.alias_name(),
                                                        col.column_name()};
                    columns.insert({col_name, {tid, cid}});
                }
            }
        };
        // Available locally?
        if (auto iter = local_tables.find(table_ref.table_name()); iter != local_tables.end()) {
            register_columns_from(iter->second);
            table_ref.mutate_table_id(Analyzer::ID(iter->second, false));
        } else if (auto iter = external_table_ids.find(table_ref.table_name()); iter != external_table_ids.end()) {
            // Available globally
            register_columns_from(iter->second);
            table_ref.mutate_table_id(Analyzer::ID(iter->second, true));
        }
    }

    // Now scan all unresolved column refs and look them up in the map
    for (size_t column_ref_id : state.column_references) {
        proto::ColumnReference& column_ref = column_references[column_ref_id];
        // Out of scope or already resolved?
        if (Analyzer::ID(column_ref.ast_scope_root()) || Analyzer::ID(column_ref.table_id())) {
            continue;
        }
        // Resolve the column ref
        if (auto iter = columns.find(column_ref.column_name()); iter != columns.end()) {
            auto [tid, cid] = iter->second;
            column_ref.mutate_table_id(tid);
            column_ref.mutate_column_id(cid);
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
        NodeState& node_state = node_states.EmplaceBack();

        // Check node type
        switch (node.node_type()) {
            // Read a column definition
            case proto::NodeType::OBJECT_SQL_COLUMN_DEF: {
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_def_node = attrs[proto::AttributeKey::SQL_COLUMN_DEF_NAME];
                NameID column_name;
                if (column_def_node && column_def_node->node_type() == sx::NodeType::NAME) {
                    column_name = column_def_node->children_begin_or_value();
                }
                node_state.table_columns.emplace_back(node_id, column_name);
                break;
            }

            // Read a column reference
            case proto::NodeType::OBJECT_SQL_COLUMN_REF: {
                // Read column ref path
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_ref_node = attrs[proto::AttributeKey::SQL_COLUMN_REF_PATH];
                auto column_name = ReadQualifiedColumnName(column_ref_node);
                // Add column reference
                auto col_ref_id = column_references.GetSize();
                auto& col_ref = column_references.Append(proto::ColumnReference());
                col_ref.mutate_ast_node_id(node_id);
                col_ref.mutate_ast_statement_id(Analyzer::ID());
                col_ref.mutate_ast_scope_root(Analyzer::ID());
                col_ref.mutate_table_id(Analyzer::ID());
                col_ref.mutate_column_id(Analyzer::ID());
                col_ref.mutable_column_name() = column_name;
                node_state.column_references.push_back(col_ref_id);
                break;
            }

            // Read a table reference
            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                // Read a table ref name
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto table_ref_node = attrs[proto::AttributeKey::SQL_TABLEREF_NAME];
                auto table_name = ReadQualifiedTableName(table_ref_node);
                // Read a table alias
                NodeID alias = Analyzer::ID();
                auto alias_node = attrs[proto::AttributeKey::SQL_TABLEREF_ALIAS];
                if (alias_node && alias_node->node_type() == sx::NodeType::NAME) {
                    alias = alias_node->children_begin_or_value();
                }
                // Add table reference
                auto table_ref_id = table_references.GetSize();
                auto& table_ref = table_references.Append(proto::TableReference());
                table_ref.mutate_ast_node_id(node_id);
                table_ref.mutate_ast_statement_id(Analyzer::ID());
                table_ref.mutate_ast_scope_root(Analyzer::ID());
                table_ref.mutate_table_id(Analyzer::ID());
                table_ref.mutable_table_name() = table_name;
                table_ref.mutate_alias_name(alias);
                node_state.table_references.push_back(table_ref_id);
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
                            assert(node_states[args_begin].has_value());
                            assert(node_states[args_begin + 1].has_value());
                            auto& l = node_states[args_begin].value();
                            auto& r = node_states[args_begin + 1].value();
                            join_edges.Append(proto::JoinEdge(node_id, join_edge_nodes.GetSize(),
                                                              l.column_references.size(), r.column_references.size()));
                            for (auto ref_id : l.column_references) {
                                join_edge_nodes.Append(proto::JoinEdgeNode(ref_id));
                            }
                            for (auto ref_id : r.column_references) {
                                join_edge_nodes.Append(proto::JoinEdgeNode(ref_id));
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
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                const proto::Node* from_node = attrs[proto::AttributeKey::SQL_SELECT_FROM];
                const proto::Node* into_node = attrs[proto::AttributeKey::SQL_SELECT_INTO];
                const proto::Node* where_node = attrs[proto::AttributeKey::SQL_SELECT_WHERE];
                const proto::Node* with_node = attrs[proto::AttributeKey::SQL_SELECT_WITH_CTES];
                MergeChildStates(node_state, {from_node, with_node, where_node});
                ResolveNames(node_state);
                CloseScope(node_state, node_id);
                break;
            }

            // Finish create table statement
            case proto::NodeType::OBJECT_SQL_CREATE: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                const proto::Node* name_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                const proto::Node* elements_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_ELEMENTS];
                // Read the name
                auto table_name = ReadQualifiedTableName(name_node);
                // Merge child states
                MergeChildStates(node_state, {elements_node});
                // Resolve all names in the merged state, likely a noop but just to be sure
                ResolveNames(node_state);
                // Collect all columns
                size_t columns_begin = table_columns.GetSize();
                size_t column_count = node_state.table_columns.size();
                for (auto& col : node_state.table_columns) {
                    table_columns.Append(col);
                }
                // Build the table
                auto table_id = tables.GetSize();
                auto& table = tables.Append(proto::Table());
                table.mutate_ast_node_id(node_id);
                table.mutate_ast_statement_id(Analyzer::ID());
                table.mutate_ast_scope_root(Analyzer::ID());
                table.mutable_table_name() = table_name;
                table.mutate_columns_begin(columns_begin);
                table.mutate_column_count(column_count);
                node_state.tables.push_back(table_id);
                // Close the scope
                CloseScope(node_state, node_id);
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

        // Erase grand-child states, this leaves the state of Array children in-tact
        for (size_t i = 0; i < node.children_count(); ++i) {
            auto child_id = node.children_begin_or_value() + i;
            auto& child_node = nodes[child_id];
            for (size_t j = 0; j < child_node.children_count(); ++j) {
                auto grand_child_id = child_node.children_begin_or_value() + j;
                node_states.Erase(grand_child_id);
            }
        }
    }
}

/// Finish the analysis pass
void NameResolutionPass::Finish() {}

/// Export an analyzed program
void NameResolutionPass::Export(AnalyzedProgram& program) {
    program.tables = std::move(tables);
    program.table_columns = std::move(table_columns);
    program.table_references = std::move(table_references);
    program.column_references = std::move(column_references);
    program.join_edges = std::move(join_edges);
    program.join_edge_nodes = std::move(join_edge_nodes);
}

}  // namespace flatsql
