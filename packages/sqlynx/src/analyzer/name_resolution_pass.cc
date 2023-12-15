#include "sqlynx/analyzer/name_resolution_pass.h"

#include <functional>
#include <iterator>
#include <limits>
#include <optional>
#include <stack>

#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

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
    tables.Append(std::move(other.tables));
    table_columns.Append(std::move(other.table_columns));
    table_references.Append(std::move(other.table_references));
    column_references.Append(std::move(other.column_references));
}

/// Constructor
NameResolutionPass::NameResolutionPass(ParsedScript& parser, AttributeIndex& attribute_index)
    : scanned_program(*parser.scanned_script),
      parsed_program(parser),
      attribute_index(attribute_index),
      context_id(parser.context_id),
      nodes(parsed_program.nodes) {
    node_states.resize(nodes.size());
}

/// Register external tables from an analyzed program
void NameResolutionPass::RegisterExternalTables(const AnalyzedScript& external) {
    // Helper to remap an external name id
    auto map_name = [this](QualifiedID name, const AnalyzedScript& external) -> QualifiedID {
        if (name.IsNull()) return QualifiedID();
        if (auto iter = scanned_program.name_dictionary_ids.find(
                external.parsed_script->scanned_script->name_dictionary[name.GetIndex()].text);
            iter != scanned_program.name_dictionary_ids.end()) {
            QualifiedID mapped_id{scanned_program.context_id, iter->second};
            return mapped_id;
        }
        return name;
    };

    // Copy all over
    external_tables = external.tables;
    external_table_columns = external.table_columns;
    external_table_ids.clear();
    external_table_ids.reserve(external_tables.size());

    // Map external tables
    for (size_t table_id = 0; table_id < external_tables.size(); ++table_id) {
        auto& t = external_tables[table_id];
        AnalyzedScript::QualifiedTableName name = t.table_name;
        t.ast_node_id = std::nullopt;  // Clear ast node to not mix up node ids
        t.ast_statement_id = std::nullopt;
        external_table_ids.insert({name, QualifiedID(external.context_id, table_id)});
    }
    // Map columns
    for (auto& c : external_table_columns) {
        c.ast_node_id = std::nullopt;
    }
}

std::span<std::reference_wrapper<ScannedScript::Name>> NameResolutionPass::ReadNamePath(const sx::Node& node) {
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
        auto name = scanned_program.ReadName(child.children_begin_or_value());
        name_path_buffer.push_back(name);
    }
    return std::span{name_path_buffer};
}

AnalyzedScript::QualifiedTableName NameResolutionPass::ReadQualifiedTableName(const sx::Node* node) {
    AnalyzedScript::QualifiedTableName name;
    if (!node) {
        return name;
    }
    auto name_path = ReadNamePath(*node);
    name.ast_node_id = node - nodes.data();
    switch (name_path.size()) {
        case 3:
            name.database_name = name_path[0].get();
            name.schema_name = name_path[1].get();
            name.table_name = name_path[2].get();
            name_path[0].get() |= sx::NameTag::DATABASE_NAME;
            name_path[1].get() |= sx::NameTag::SCHEMA_NAME;
            name_path[2].get() |= sx::NameTag::TABLE_NAME;
            break;
        case 2:
            name.schema_name = name_path[0].get();
            name.table_name = name_path[1].get();
            name_path[0].get() |= sx::NameTag::SCHEMA_NAME;
            name_path[1].get() |= sx::NameTag::TABLE_NAME;
            break;
        case 1:
            name.table_name = name_path[0].get();
            name_path[0].get() |= sx::NameTag::TABLE_NAME;
            break;
        default:
            break;
    }
    return name;
}

AnalyzedScript::QualifiedColumnName NameResolutionPass::ReadQualifiedColumnName(const sx::Node* node) {
    AnalyzedScript::QualifiedColumnName name;
    if (!node) {
        return name;
    }
    auto name_path = ReadNamePath(*node);
    name.ast_node_id = node - nodes.data();
    // Build the qualified column name
    switch (name_path.size()) {
        case 2:
            name.table_alias = name_path[0].get();
            name.column_name = name_path[1].get();
            name_path[0].get() |= sx::NameTag::TABLE_ALIAS;
            name_path[1].get() |= sx::NameTag::COLUMN_NAME;
            break;
        case 1:
            name.column_name = name_path[0].get();
            name_path[0].get() |= sx::NameTag::COLUMN_NAME;
            break;
        default:
            break;
    }
    return name;
}

void NameResolutionPass::CloseScope(NodeState& target, uint32_t node_id) {
    target.table_columns.Clear();
    for (auto iter = target.tables.begin(); iter != target.tables.end(); ++iter) {
        if (!iter->ast_scope_root.has_value()) {
            iter->ast_scope_root = node_id;
        }
    }
    for (auto iter = target.table_references.begin(); iter != target.table_references.end(); ++iter) {
        if (!iter->ast_scope_root.has_value()) {
            iter->ast_scope_root = node_id;
        }
    }
    for (auto iter = target.column_references.begin(); iter != target.column_references.end(); ++iter) {
        if (!iter->ast_scope_root.has_value()) {
            iter->ast_scope_root = node_id;
        }
    }
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

void NameResolutionPass::ResolveNames(NodeState& state) {
    // Build a map with all table names that are in scope
    scope_tables.clear();
    size_t max_column_count = 0;
    for (auto iter = state.tables.begin(); iter != state.tables.end(); ++iter) {
        QualifiedID table_id{context_id, static_cast<uint32_t>(iter.GetBufferIndex())};
        // Table declarations are out of scope if they have a scope root set
        if (iter->ast_scope_root.has_value()) {
            continue;
        }
        // Register as local table if in scope
        AnalyzedScript::QualifiedTableName table_name = iter->table_name;
        max_column_count += iter->column_count;
        scope_tables.insert({table_name, table_id});
    }

    // Collect all columns that are in scope
    scope_columns.clear();
    scope_columns.reserve(max_column_count);
    for (auto iter = state.table_references.begin(); iter != state.table_references.end(); ++iter) {
        // Table references are out of scope if they have a scope root set
        if (iter->ast_scope_root.has_value()) {
            continue;
        }
        // Helper to register columns from a table
        auto register_columns_from = [&](QualifiedID tid) {
            if (tid.GetContext() == context_id) {
                AnalyzedScript::Table& resolved = tables[tid.GetIndex()].value;
                for (uint32_t cid = 0; cid < resolved.column_count; ++cid) {
                    AnalyzedScript::TableColumn& col = table_columns[resolved.columns_begin + cid];
                    AnalyzedScript::QualifiedColumnName col_name{iter->ast_node_id, iter->alias_name, col.column_name};
                    scope_columns.insert({col_name, {tid, cid}});
                }
            } else {
                AnalyzedScript::Table& resolved = external_tables[tid.GetIndex()];
                for (uint32_t cid = 0; cid < resolved.column_count; ++cid) {
                    AnalyzedScript::TableColumn& col = external_table_columns[resolved.columns_begin + cid];
                    AnalyzedScript::QualifiedColumnName col_name{iter->ast_node_id, iter->alias_name, col.column_name};
                    scope_columns.insert({col_name, {tid, cid}});
                }
            }
        };
        // Available in scope?
        if (auto tbl_iter = scope_tables.find(iter->table_name); tbl_iter != scope_tables.end()) {
            register_columns_from(tbl_iter->second);
            iter->table_id = tbl_iter->second;
        } else if (auto tbl_iter = external_table_ids.find(iter->table_name); tbl_iter != external_table_ids.end()) {
            // Available globally
            register_columns_from(tbl_iter->second);
            iter->table_id = tbl_iter->second;
        }
    }

    // Now scan all unresolved column refs and look them up in the map
    for (auto iter = state.column_references.begin(); iter != state.column_references.end(); ++iter) {
        // Out of scope or already resolved?
        if (iter->ast_scope_root.has_value() || !iter->table_id.IsNull()) {
            continue;
        }
        // Resolve the column ref
        if (auto column_iter = scope_columns.find(iter->column_name); column_iter != scope_columns.end()) {
            auto [tid, cid] = column_iter->second;
            iter->table_id = tid;
            iter->column_id = cid;
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
                std::string_view column_name_str;
                if (column_def_node && column_def_node->node_type() == sx::NodeType::NAME) {
                    auto& name = scanned_program.ReadName(column_def_node->children_begin_or_value());
                    name |= sx::NameTag::COLUMN_NAME;
                    column_name_str = name;
                }
                if (auto reused = pending_columns_free_list.PopFront()) {
                    *reused = AnalyzedScript::TableColumn(node_id, column_name_str);
                    node_state.table_columns.PushBack(*reused);
                } else {
                    auto& node = pending_columns.Append(AnalyzedScript::TableColumn(node_id, column_name_str));
                    node_state.table_columns.PushBack(node);
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
                // Add column reference
                auto& n = column_references.Append(AnalyzedScript::ColumnReference());
                n.buffer_index = column_references.GetSize() - 1;
                n.value.ast_node_id = node_id;
                n.value.ast_statement_id = std::nullopt;
                n.value.ast_scope_root = std::nullopt;
                n.value.table_id = QualifiedID();
                n.value.column_id = std::nullopt;
                n.value.column_name = column_name;
                node_state.column_references.PushBack(n);
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
                    // Read a table alias
                    std::string_view alias_str;
                    auto alias_node = attrs[proto::AttributeKey::SQL_TABLEREF_ALIAS];
                    if (alias_node && alias_node->node_type() == sx::NodeType::NAME) {
                        auto& alias = scanned_program.ReadName(alias_node->children_begin_or_value());
                        alias |= sx::NameTag::TABLE_ALIAS;
                        alias_str = alias;
                    }
                    // Add table reference
                    auto& n = table_references.Append(AnalyzedScript::TableReference());
                    n.buffer_index = column_references.GetSize() - 1;
                    n.value.ast_node_id = node_id;
                    n.value.ast_statement_id = std::nullopt;
                    n.value.ast_scope_root = std::nullopt;
                    n.value.table_id = QualifiedID();
                    n.value.table_name = name;
                    n.value.alias_name = alias_str;
                    node_state.table_references.PushBack(n);
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
                ResolveNames(node_state);
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
                size_t column_count = node_state.table_columns.GetSize();
                for (auto table_col : node_state.table_columns) {
                    table_columns.Append(table_col);
                }
                pending_columns_free_list.Append(std::move(node_state.table_columns));
                // Build the table
                auto& n = tables.Append(AnalyzedScript::Table());
                n.buffer_index = tables.GetSize() - 1;
                n.value.ast_node_id = node_id;
                n.value.ast_statement_id = std::nullopt;
                n.value.ast_scope_root = std::nullopt;
                n.value.table_name = table_name;
                n.value.columns_begin = columns_begin;
                n.value.column_count = column_count;
                node_state.tables.PushBack(n);
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
    }
}

/// Finish the analysis pass
void NameResolutionPass::Finish() {
    // Bail out if there are no statements
    if (parsed_program.statements.empty()) {
        return;
    }
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

/// Export an analyzed program
void NameResolutionPass::Export(AnalyzedScript& program) {
    program.table_columns = table_columns.Flatten();
    program.tables.reserve(tables.GetSize());
    program.table_references.reserve(table_references.GetSize());
    program.column_references.reserve(column_references.GetSize());
    program.graph_edges.reserve(graph_edges.GetSize());
    program.graph_edge_nodes.reserve(graph_edge_nodes.GetSize());
    for (auto& chunk : tables.GetChunks()) {
        for (auto& table : chunk) {
            program.tables.push_back(std::move(table.value));
        }
    }
    for (auto& chunk : table_references.GetChunks()) {
        for (auto& ref : chunk) {
            program.table_references.push_back(std::move(ref.value));
        }
    }
    for (auto& chunk : column_references.GetChunks()) {
        for (auto& ref : chunk) {
            program.column_references.push_back(std::move(ref.value));
        }
    }
    for (auto& chunk : graph_edges.GetChunks()) {
        for (auto& ref : chunk) {
            program.graph_edges.push_back(std::move(ref.value));
        }
    }
    for (auto& chunk : graph_edge_nodes.GetChunks()) {
        for (auto& ref : chunk) {
            program.graph_edge_nodes.push_back(std::move(ref.value));
        }
    }
}

}  // namespace sqlynx
