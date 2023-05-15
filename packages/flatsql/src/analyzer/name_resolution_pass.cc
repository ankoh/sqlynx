#include "flatsql/analyzer/name_resolution_pass.h"

#include "flatsql/analyzer/schema_info.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {

/// Constructor
NameResolutionPass::NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index)
    : parsed_program(parser), attribute_index(attribute_index), nodes(parsed_program.nodes) {}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}

/// Visit a chunk of nodes
void NameResolutionPass::Visit(std::span<proto::Node> morsel) {
    std::vector<NameID> tmp_name_path;

    // Helper to read a name path
    auto read_name_path = [this, &tmp_name_path](sx::Node& node) {
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
        proto::Node& node = morsel[i];
        NodeID node_id = morsel_offset + i;
        NameResolutionState node_state;

        // Check node type
        switch (node.node_type()) {
            // Read a column definition
            case proto::NodeType::OBJECT_SQL_COLUMN_DEF: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                [[maybe_unused]] auto column_def_node = attrs[proto::AttributeKey::SQL_COLUMN_DEF_NAME];
                [[maybe_unused]] auto column_type_node = attrs[proto::AttributeKey::SQL_COLUMN_DEF_TYPE];
                // XXX Construct the column def
                break;
            }

            // Read a column reference
            case proto::NodeType::OBJECT_SQL_COLUMN_REF: {
                schema::QualifiedColumnName name;
                // Read column ref path
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                auto column_ref_node = attrs[proto::AttributeKey::SQL_COLUMN_REF_PATH];
                if (column_ref_node && column_ref_node->node_type() == sx::NodeType::ARRAY) {
                    auto name_path = read_name_path(node);
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
                node_state.column_references.push_back(
                    schema::ColumnReference{.node_id = node_id, .column_name = name});
                break;
            }

            // Read a table reference
            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                schema::QualifiedTableName name;
                std::optional<NodeID> alias;

                // Read a table ref name
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                auto table_ref_node = attrs[proto::AttributeKey::SQL_TABLEREF_NAME];
                if (table_ref_node && table_ref_node->node_type() == sx::NodeType::ARRAY) {
                    auto name_path = read_name_path(node);
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
                node_state.table_references.push_back(
                    schema::TableReference{.node_id = node_id, .table_name = name, .table_alias = alias});
                break;
            }

            // Read an n-ary expression
            case proto::NodeType::OBJECT_SQL_NARY_EXPRESSION: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                [[maybe_unused]] auto op_node = attrs[proto::AttributeKey::SQL_EXPRESSION_OPERATOR];
                [[maybe_unused]] auto args_node = attrs[proto::AttributeKey::SQL_EXPRESSION_ARGS];
                assert(op_node);
                assert(op_node->node_type() == proto::NodeType::ENUM_SQL_EXPRESSION_OPERATOR);
                assert(args_node);
                assert(args_node->node_type() == proto::NodeType::ARRAY);
                // XXX Construct the nary expression
                break;
            }

            default:
                break;
        }
    }
}

/// Finish the analysis pass
void NameResolutionPass::Finish() {}

}  // namespace flatsql
