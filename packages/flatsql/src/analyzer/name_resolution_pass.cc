#include "flatsql/analyzer/name_resolution_pass.h"

#include <iterator>

#include "flatsql/analyzer/schema_info.h"
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
    merge(table_references, std::move(other.table_references));
    merge(column_references, std::move(other.column_references));
    merge(table_definitions, std::move(other.table_definitions));
}

/// Constructor
NameResolutionPass::NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index)
    : parsed_program(parser), attribute_index(attribute_index), nodes(parsed_program.nodes) {}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}

/// Visit a chunk of nodes
void NameResolutionPass::Visit(std::span<proto::Node> morsel) {
    std::vector<NameID> tmp_name_path;

    // Helper to read a name path
    auto read_name_path = [this, &tmp_name_path](const sx::Node& node) {
        // Collect all path nodes
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
                // XXX Construct the column def
                break;
            }

            // Read a column reference
            case proto::NodeType::OBJECT_SQL_COLUMN_REF: {
                schema::QualifiedColumnName name;
                // Read column ref path
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto column_ref_node = attrs[proto::AttributeKey::SQL_COLUMN_REF_PATH];
                if (column_ref_node && column_ref_node->node_type() == sx::NodeType::ARRAY) {
                    auto name_path = read_name_path(*column_ref_node);
                    name.node_id = column_ref_node - nodes.data();
                    // Build the qualified column name
                    switch (name_path.size()) {
                        case 4:
                            name.schema = name_path[0];
                            name.database = name_path[1];
                            name.table = name_path[2];
                            name.column = name_path[3];
                            break;
                        case 3:
                            name.database = name_path[0];
                            name.table = name_path[1];
                            name.column = name_path[2];
                            break;
                        case 2:
                            name.table = name_path[0];
                            name.column = name_path[1];
                            break;
                        case 1:
                            name.column = name_path[0];
                            break;
                        default:
                            break;
                    }
                }
                // Add column reference
                node_state.column_references.emplace_back(node_id, name);
                break;
            }

            // Read a table reference
            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                schema::QualifiedTableName name;
                std::optional<NodeID> alias;

                // Read a table ref name
                auto children = nodes.subspan(node.children_begin_or_value(), node.children_count());
                auto attrs = attribute_index.Load(children);
                auto table_ref_node = attrs[proto::AttributeKey::SQL_TABLEREF_NAME];
                if (table_ref_node && table_ref_node->node_type() == sx::NodeType::ARRAY) {
                    auto name_path = read_name_path(*table_ref_node);
                    name.node_id = table_ref_node - nodes.data();
                    // Build the qualified table name
                    switch (tmp_name_path.size()) {
                        case 3:
                            name.schema = name_path[0];
                            name.database = name_path[1];
                            name.table = name_path[2];
                            break;
                        case 2:
                            name.database = name_path[0];
                            name.table = name_path[1];
                            break;
                        case 1:
                            name.table = name_path[0];
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
                node_state.table_references.emplace_back(node_id, name, alias);
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
                            // XXX
                            break;

                        // Comparison operator? - Finish dependencies.
                        case proto::ExpressionOperator::EQUAL:
                        case proto::ExpressionOperator::GREATER_EQUAL:
                        case proto::ExpressionOperator::GREATER_THAN:
                        case proto::ExpressionOperator::LESS_EQUAL:
                        case proto::ExpressionOperator::LESS_THAN:
                        case proto::ExpressionOperator::NOT_EQUAL:
                            // XXX
                            break;

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
                        case proto::ExpressionOperator::TYPECAST: {
                            // Merge the child states directly
                            for (size_t i = 0; i < args_count; ++i) {
                                assert(node_states[args_begin + i].has_value());
                                auto& child_state = node_states[args_begin + i].value();
                                node_state.Merge(std::move(child_state));
                            }
                            break;
                        }
                    }
                }
                break;
            }

            default:
                break;
        }

        // Erase child states
        for (size_t i = 0; i < node.children_count(); ++i) {
            node_states.Erase(node.children_begin_or_value() + i);
        }
    }
}

/// Finish the analysis pass
void NameResolutionPass::Finish() {}

/// Export an analyzed program
void NameResolutionPass::Export(AnalyzedProgram& program) {}

}  // namespace flatsql
