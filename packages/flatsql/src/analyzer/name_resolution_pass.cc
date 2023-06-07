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
        t.mutate_ast_node_id(NULL_ID);
        t.mutate_ast_statement_id(NULL_ID);
        external_table_ids.insert({name, table_id});
    }
    // Map columns
    for (auto& c : external_table_columns) {
        c.mutate_column_name(map_name(external, c.column_name()));
        c.mutate_ast_node_id(NULL_ID);
    }
}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}

/// Visit a chunk of nodes
void NameResolutionPass::Visit(std::span<proto::Node> morsel) {
    std::vector<NameID> tmp_name_path;

    // Helper to read a name path
    auto read_name_path = [this, &tmp_name_path](const sx::Node& node) {
        tmp_name_path.clear();
        auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
        for (size_t i = node.children_begin_or_value(); i != node.children_count(); ++i) {
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
    };

    // Helper to merge child states
    auto merge_child_states = [this](const sx::Node& node, NodeState& state) {
        for (size_t i = 0; i < node.children_count(); ++i) {
            auto child_id = node.children_begin_or_value() + i;
            auto& child = node_states[node.children_begin_or_value() + i];
            assert(node_states[child_id].has_value());
            state.Merge(std::move(child.value()));
        }
    };

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
                proto::QualifiedColumnName name{NULL_ID, NULL_ID, NULL_ID};
                // Read column ref path
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_ref_node = attrs[proto::AttributeKey::SQL_COLUMN_REF_PATH];
                if (column_ref_node && column_ref_node->node_type() == sx::NodeType::ARRAY) {
                    auto name_path = read_name_path(*column_ref_node);
                    name.mutate_ast_node_id(column_ref_node - nodes.data());
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
                }
                // Add column reference
                auto col_ref_id = column_references.GetSize();
                auto& col_ref = column_references.Append(proto::ColumnReference());
                col_ref.mutate_ast_node_id(node_id);
                col_ref.mutate_ast_statement_id(NULL_ID);
                col_ref.mutate_table_id(NULL_ID);
                col_ref.mutable_column_name() = name;
                node_state.column_references.push_back(col_ref_id);
                break;
            }

            // Read a table reference
            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                proto::QualifiedTableName name{NULL_ID, NULL_ID, NULL_ID, NULL_ID};
                NodeID alias = NULL_ID;

                // Read a table ref name
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto table_ref_node = attrs[proto::AttributeKey::SQL_TABLEREF_NAME];
                if (table_ref_node && table_ref_node->node_type() == sx::NodeType::ARRAY) {
                    auto name_path = read_name_path(*table_ref_node);
                    name.mutate_ast_node_id(table_ref_node - nodes.data());
                    // Build the qualified table name
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
                }
                // Read a table alias
                auto alias_node = attrs[proto::AttributeKey::SQL_TABLEREF_ALIAS];
                if (alias_node && alias_node->node_type() == sx::NodeType::NAME) {
                    alias = alias_node->children_begin_or_value();
                }
                // Add table reference
                auto table_ref_id = table_references.GetSize();
                auto& table_ref = table_references.Append(proto::TableReference());
                table_ref.mutate_ast_node_id(node_id);
                table_ref.mutate_ast_statement_id(NULL_ID);
                table_ref.mutate_table_id(NULL_ID);
                table_ref.mutable_table_name() = name;
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
                        // And operator? - Close subtrees.
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

                        // Operators that preserve refs
                        case proto::ExpressionOperator::COLLATE:
                        case proto::ExpressionOperator::DEFAULT:
                        case proto::ExpressionOperator::DIVIDE:
                        case proto::ExpressionOperator::MINUS:
                        case proto::ExpressionOperator::MODULUS:
                        case proto::ExpressionOperator::MULTIPLY:
                        case proto::ExpressionOperator::NEGATE:
                        case proto::ExpressionOperator::NOT:
                        case proto::ExpressionOperator::PLUS:
                        case proto::ExpressionOperator::TYPECAST:
                            merge_child_states(*args_node, node_state);
                            break;

                        // Other operators
                        case proto::ExpressionOperator::AT_TIMEZONE:
                        case proto::ExpressionOperator::BETWEEN_ASYMMETRIC:
                        case proto::ExpressionOperator::BETWEEN_SYMMETRIC:
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
                        case proto::ExpressionOperator::NOT_BETWEEN_ASYMMETRIC:
                        case proto::ExpressionOperator::NOT_BETWEEN_SYMMETRIC:
                        case proto::ExpressionOperator::NOT_GLOB:
                        case proto::ExpressionOperator::NOT_ILIKE:
                        case proto::ExpressionOperator::NOT_IN:
                        case proto::ExpressionOperator::NOT_LIKE:
                        case proto::ExpressionOperator::NOT_NULL:
                        case proto::ExpressionOperator::NOT_SIMILAR_TO:
                        case proto::ExpressionOperator::OVERLAPS:
                        case proto::ExpressionOperator::SIMILAR_TO:
                            break;
                    }
                }
                break;
            }

            // Finish select statement
            case proto::NodeType::OBJECT_SQL_SELECT: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                const proto::Node* from_node = attrs[proto::AttributeKey::SQL_SELECT_FROM];
                const proto::Node* with_node = attrs[proto::AttributeKey::SQL_SELECT_WITH_CTES];
                const proto::Node* into_node = attrs[proto::AttributeKey::SQL_SELECT_INTO];

                // Merge all node states
                NodeState sources;
                if (from_node && node_states[from_node - nodes.data()].has_value()) {
                    sources.Merge(std::move(node_states[from_node - nodes.data()].value()));
                }
                if (with_node && node_states[with_node - nodes.data()].has_value()) {
                    sources.Merge(std::move(node_states[with_node - nodes.data()].value()));
                }

                // Build a map with all table names that are in scope
                ankerl::unordered_dense::map<TableKey, TableID, TableKey::Hasher> local_tables;
                for (TableID table_id : sources.tables) {
                    proto::Table& table = tables[table_id];
                    proto::QualifiedTableName table_name = table.table_name();
                    local_tables.insert({table_name, table_id});
                }

                // Collect all columns that are in scope
                ankerl::unordered_dense::map<ColumnKey, std::pair<TableID, ColumnID>, ColumnKey::Hasher> local_columns;
                for (size_t table_ref_id : sources.table_references) {
                    proto::TableReference& table_ref = table_references[table_ref_id];

                    // Helper to register columns from a table
                    auto registerColumnsFrom = [&](size_t tid) {
                        proto::Table& resolved = tables[tid];
                        for (uint32_t cid = 0; cid < resolved.column_count(); ++cid) {
                            proto::TableColumn& col = table_columns[resolved.columns_begin() + cid];
                            proto::QualifiedColumnName col_name{table_ref.ast_node_id(), table_ref.alias_name(), cid};
                            local_columns.insert({col_name, {tid, cid}});
                        }
                    };

                    // Available locally?
                    if (auto iter = local_tables.find(table_ref.table_name()); iter != local_tables.end()) {
                        registerColumnsFrom(iter->second);
                    }

                    // Available globally?
                    if (auto iter = external_table_ids.find(table_ref.table_name()); iter != local_tables.end()) {
                        registerColumnsFrom(iter->second);
                    }
                }

                (void)from_node;
                (void)with_node;
                (void)into_node;
                break;
            }

            // Finish create table statement
            case proto::NodeType::OBJECT_SQL_CREATE: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                auto name_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_NAME];
                auto elements_node = attrs[proto::AttributeKey::SQL_CREATE_TABLE_ELEMENTS];

                (void)name_node;
                (void)elements_node;
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
                    merge_child_states(node, node_state);
                }
                break;
            }

            // By default, merge child states into the node state
            default:
                merge_child_states(node, node_state);
                break;
        }

        // Erase grand-child states
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
