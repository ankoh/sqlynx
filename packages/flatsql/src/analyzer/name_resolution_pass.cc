#include "flatsql/analyzer/name_resolution_pass.h"

#include "flatsql/proto/proto_generated.h"

namespace flatsql {

/// Constructor
NameResolutionPass::NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index)
    : parsed_program(parser), attribute_index(attribute_index), nodes(parsed_program.nodes) {}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}

/// Visit a chunk of nodes
void NameResolutionPass::Visit(std::span<proto::Node> morsel) {
    size_t morsel_offset = morsel.data() - nodes.data();
    for (size_t i = 0; i < morsel.size(); ++i) {
        proto::Node& node = morsel[i];
        size_t node_id = morsel_offset + i;

        // Check node type
        switch (node.node_type()) {
            case proto::NodeType::OBJECT_SQL_COLUMN_DEF: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                [[maybe_unused]] auto column_def_node = attrs[proto::AttributeKey::SQL_COLUMN_DEF_NAME];
                [[maybe_unused]] auto column_type_node = attrs[proto::AttributeKey::SQL_COLUMN_DEF_TYPE];
                // XXX Construct the column def
                break;
            }
            case proto::NodeType::OBJECT_SQL_COLUMN_REF: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                [[maybe_unused]] auto column_ref_node = attrs[proto::AttributeKey::SQL_COLUMN_REF_PATH];
                // XXX Construct the column ref
                break;
            }
            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                auto attrs = attribute_index.Load(nodes.subspan(node.children_begin_or_value(), node.children_count()));
                [[maybe_unused]] auto table_ref_node = attrs[proto::AttributeKey::SQL_TABLEREF_NAME];
                [[maybe_unused]] auto alias_node = attrs[proto::AttributeKey::SQL_TABLEREF_ALIAS];
                // XXX Construct the table ref
                break;
            }
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
            case proto::NodeType::NAME: {
                break;
            }
            default:
                break;
        }

        // Check attribute key
        switch (node.attribute_key()) {
            case proto::AttributeKey::SQL_COLUMN_REF_PATH: {
                assert(node.node_type() == proto::NodeType::ARRAY);
                [[maybe_unused]] auto path_nodes = nodes.subspan(node.children_begin_or_value(), node.children_count());
                for (size_t i = node.children_begin_or_value(); i != node.children_count(); ++i) {
                    // XXX Resolve node state
                }
                // XXX Combine the names from the children
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
