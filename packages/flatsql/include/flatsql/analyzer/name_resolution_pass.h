#pragma once

#include <unordered_set>

#include "flatsql/analyzer/attribute_index.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/analyzer/schema_info.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {

class NameResolutionPass : public PassManager::LTRDepthFirstPostOrderPass {
   protected:
    /// A name resolution state
    struct NameResolutionState {
        /// Table definitions
        std::vector<schema::TableReference> table_references;
        /// Column references
        std::vector<schema::ColumnReference> column_references;
        /// Table definitions
        std::vector<schema::TableDefinition> table_definitions;
    };

    /// The node state
    struct NodeState {
        /// The AST node
        sx::Node node;
        /// The name resolution state that is currently in scope
        NameResolutionState names_in_scope;
        /// The name resolution state that is currently out of scope
        NameResolutionState names_out_of_scope;
    };
    /// The parsed program
    ParsedProgram& parsed_program;
    /// The attribute index.
    AttributeIndex& attribute_index;
    /// The program nodes
    std::span<const proto::Node> nodes;
    /// We only need to hold the state of the immediate children of the next nodes.
    std::unordered_map<NodeID, NodeState> node_state;
    /// The external tables
    std::unordered_map<schema::QualifiedTableName, schema::ExternalTableInfo> external_tables;

   public:
    /// Constructor
    NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index);

    /// Prepare the analysis pass
    void Prepare() override;
    /// Visit a chunk of nodes
    void Visit(std::span<proto::Node> morsel) override;
    /// Finish the analysis pass
    void Finish() override;
};

}  // namespace flatsql
