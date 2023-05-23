#pragma once

#include <unordered_set>

#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/attribute_index.h"
#include "flatsql/utils/wake_vector.h"

namespace flatsql {

class NameResolutionPass : public PassManager::LTRPass {
   public:
    /// A name resolution state
    struct NodeState {
        /// The table declarations
        /// We propagate new table definitions upwards only to apply them to other subtrees!
        /// Example:
        ///     WITH foo AS (SELECT 1) SELECT * FROM (SELECT 2) AS foo;
        ///     Table definitions of SQL_SELECT_WITH_CTES are only visible in other SELECT attrs.
        std::vector<std::unique_ptr<proto::TableDeclarationT>> table_declarations;
        /// Table definitions
        std::vector<proto::TableReference> table_references;
        /// Column references
        std::vector<proto::ColumnReference> column_references;
        /// The join edges
        std::vector<std::unique_ptr<proto::HyperEdgeT>> join_edges;

        /// XXX Make table definitions a map
        /// XXX Add column definition map

        /// Merge two states
        void Merge(NodeState&& other);
    };

   protected:
    /// The parsed program
    ParsedProgram& parsed_program;
    /// The attribute index.
    AttributeIndex& attribute_index;
    /// The program nodes
    std::span<const proto::Node> nodes;
    /// The state of all visited nodes with yet-to-visit parents
    WakeVector<NodeState> node_states;

   public:
    /// Constructor
    NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index);

    /// Prepare the analysis pass
    void Prepare() override;
    /// Visit a chunk of nodes
    void Visit(std::span<proto::Node> morsel) override;
    /// Finish the analysis pass
    void Finish() override;

    /// Export an analyzed program
    void Export(AnalyzedProgram& program);
};

}  // namespace flatsql
