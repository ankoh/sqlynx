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
    using TableID = uint32_t;

    /// The name resolution pass works as follows:
    /// We traverse the AST in a depth-first post-order, means children before parents.
    ///
    /// For every node, we track:
    ///     A) Mapping (table name -> table id). From table decls, for table refs.
    ///     B) Mapping (table alias -> table id). From table refs, for column refs.
    ///     C) Mapping (column name -> table id). From table refs, for column refs.
    ///     D) Table refs in scope to resolve a table id via a table name
    ///     E) Column refs in scope to resolve a table id via a table alias
    ///
    struct NodeState {
        /// The (table name -> virtual table id) mapping created through table declarations
        std::unordered_map<NameID, TableID> table_names;
        /// The (table alias -> virtual table id) mapping created through table refs
        std::unordered_map<NameID, TableID> table_aliases;
        /// The (column name -> virtual table id) mapping created through table refs
        std::unordered_map<NameID, TableID> column_names;
        /// The table references in scope
        std::vector<proto::TableReference*> table_references;
        /// The column references in scope
        std::vector<proto::ColumnReference*> column_references;

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
    /// The join edge nodes
    decltype(AnalyzedProgram::join_edge_nodes) join_edge_nodes;

    /// The join edge count
    size_t join_edge_count;

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
