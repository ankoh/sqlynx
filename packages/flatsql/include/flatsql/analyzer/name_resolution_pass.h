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
        /// The table declarations that are alive
        std::vector<std::reference_wrapper<proto::TableDeclarationT>> table_declarations;
        /// The table references that are alive
        std::vector<std::reference_wrapper<proto::TableReference>> table_references;
        /// The column references that are alive
        std::vector<std::reference_wrapper<proto::ColumnReference>> column_references;
        /// The join edges that are alive
        std::vector<std::reference_wrapper<proto::HyperEdgeT>> join_edges;

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
    /// The table declarations
    /// We propagate new table definitions upwards only to apply them to other subtrees!
    /// Example:
    ///     WITH foo AS (SELECT 1) SELECT * FROM (SELECT 2) AS foo;
    ///     Table definitions of SQL_SELECT_WITH_CTES are only visible in other SELECT attrs.
    decltype(AnalyzedProgram::table_declarations) table_declarations;
    /// The table definitions
    decltype(AnalyzedProgram::table_references) table_references;
    /// The column references
    decltype(AnalyzedProgram::column_references) column_references;
    /// The join edges
    decltype(AnalyzedProgram::join_edges) join_edges;
    /// The state of all visited nodes with yet-to-visit parents
    WakeVector<NodeState> node_states;

   public:
    /// Constructor
    NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index, const AnalyzedProgram* schema = nullptr);

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
