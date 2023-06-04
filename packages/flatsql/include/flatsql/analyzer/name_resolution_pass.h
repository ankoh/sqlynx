#pragma once

#include <tuple>
#include <unordered_set>

#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/attribute_index.h"
#include "flatsql/utils/wake_vector.h"

namespace flatsql {

class NameResolutionPass : public PassManager::LTRPass {
   public:
    using TableID = uint32_t;

    /// The name resolution pass works as follows:
    /// We traverse the AST in a depth-first post-order, means children before parents.
    struct NodeState {
        /// The column definitions in the subtree
        std::vector<proto::TableColumnDeclaration> table_columns;
        /// The table references in scope
        std::vector<size_t> table_references;
        /// The column references in scope
        std::vector<size_t> column_references;

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
    decltype(AnalyzedProgram::table_declarations) table_declarations;
    /// The table definitions
    decltype(AnalyzedProgram::table_references) table_references;
    /// The column references
    decltype(AnalyzedProgram::column_references) column_references;
    /// The join edges
    decltype(AnalyzedProgram::join_edges) join_edges;
    /// The join edge nodes
    decltype(AnalyzedProgram::join_edge_nodes) join_edge_nodes;

    /// The state of all visited nodes with yet-to-visit parents
    WakeVector<NodeState> node_states;

   public:
    /// Constructor
    NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index, const AnalyzedProgram* schema);

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
