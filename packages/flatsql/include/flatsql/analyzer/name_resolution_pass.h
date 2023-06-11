#pragma once

#include <limits>
#include <tuple>
#include <unordered_map>
#include <unordered_set>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/attribute_index.h"
#include "flatsql/utils/wake_vector.h"

namespace flatsql {

class NameResolutionPass : public PassManager::LTRPass {
   public:
    /// The name resolution pass works as follows:
    /// We traverse the AST in a depth-first post-order, means children before parents.
    struct NodeState {
        /// The column definitions in the subtree
        std::vector<proto::TableColumn> table_columns;
        /// The tables in scope
        std::vector<size_t> tables;
        /// The table references in scope
        std::vector<size_t> table_references;
        /// The column references in scope
        std::vector<size_t> column_references;

        /// Merge two states
        void Merge(NodeState&& other);
    };

   protected:
    /// The scanned program
    ScannedProgram& scanned_program;
    /// The parsed program
    ParsedProgram& parsed_program;
    /// The attribute index.
    AttributeIndex& attribute_index;
    /// The program nodes
    std::span<const proto::Node> nodes;

    /// The external tables
    std::vector<proto::Table> external_tables;
    /// The external table columns
    std::vector<proto::TableColumn> external_table_columns;
    /// The external name mapping
    ankerl::unordered_dense::map<NameID, Analyzer::ID> external_names;
    /// The external table map
    ankerl::unordered_dense::map<Analyzer::TableKey, Analyzer::ID, Analyzer::TableKey::Hasher> external_table_ids;

    /// The local tables
    decltype(AnalyzedProgram::tables) tables;
    /// The local table columns
    decltype(AnalyzedProgram::table_columns) table_columns;
    /// The table definitions
    decltype(AnalyzedProgram::table_references) table_references;
    /// The column references
    decltype(AnalyzedProgram::column_references) column_references;
    /// The query graph edges
    decltype(AnalyzedProgram::graph_edges) graph_edges;
    /// The query graph edge nodes
    decltype(AnalyzedProgram::graph_edge_nodes) graph_edge_nodes;

    /// The state of all visited nodes with yet-to-visit parents
    WakeVector<NodeState> node_states;
    /// Temporary name path
    std::vector<NameID> tmp_name_path;

    /// Merge child states into a destination state
    std::span<NameID> ReadNamePath(const sx::Node& node);
    /// Merge child states into a destination state
    proto::QualifiedTableName ReadQualifiedTableName(const sx::Node* node);
    /// Merge child states into a destination state
    proto::QualifiedColumnName ReadQualifiedColumnName(const sx::Node* column);
    /// Merge child states into a destination state
    void CloseScope(NodeState& target, size_t node_id);
    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, const sx::Node& parent);
    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, std::initializer_list<const proto::Node*> children);
    /// Resolve names in the given state
    void ResolveNames(NodeState& state);

   public:
    /// Constructor
    NameResolutionPass(ParsedProgram& parser, AttributeIndex& attribute_index);

    /// Register external tables from analyzed program
    void RegisterExternalTables(const AnalyzedProgram& program);

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
