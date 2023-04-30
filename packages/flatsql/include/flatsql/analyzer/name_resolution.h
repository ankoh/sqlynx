#pragma once

#include <unordered_set>

#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/analyzer/schema_info.h"
#include "flatsql/program.h"

namespace flatsql {

class NameResolution : public PassManager::DepthFirstPostOrderPass {
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

    /// A name resolution state that tracks references and definitions falling out of scope
    struct ScopedNameResolutionState {
        /// The name resolution state that is currently in scope
        NameResolutionState names_in_scope;
        /// The name resolution state that is currently out of scope
        NameResolutionState names_out_of_scope;
    };
    /// The node state map.
    /// We only need to hold the state of the immediate children of all unvisited nodes.
    std::unordered_map<NodeID, ScopedNameResolutionState> node_state;
    /// The external tables
    std::unordered_map<schema::ObjectName, schema::ExternalTableInfo> external_tables;

   public:
    /// Constructor
    NameResolution(ParsedProgram& parser);

    /// Prepare the analysis pass
    void Prepare() override;
    /// Visit a chunk of nodes
    void Visit(size_t offset, std::span<proto::Node> nodes) override;
    /// Finish the analysis pass
    void Finish() override;
};

}  // namespace flatsql
