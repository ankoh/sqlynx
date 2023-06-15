#pragma once

#include <limits>
#include <tuple>
#include <unordered_map>
#include <unordered_set>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/attribute_index.h"
#include "flatsql/utils/overlay_list.h"

namespace flatsql {

class NameResolutionPass : public PassManager::LTRPass {
   public:
    /// The name resolution pass works as follows:
    /// We traverse the AST in a depth-first post-order, means children before parents.
    struct NodeState {
        /// The column definitions in the subtree
        OverlayList<proto::TableColumn> table_columns;
        /// The tables in scope
        OverlayList<proto::Table> tables;
        /// The table references in scope
        OverlayList<proto::TableReference> table_references;
        /// The column references in scope
        OverlayList<proto::ColumnReference> column_references;

        /// Merge two states
        void Merge(NodeState&& other);
    };

   protected:
    /// The scanned program
    ScannedScript& scanned_program;
    /// The parsed program
    ParsedScript& parsed_program;
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

    /// The state of all visited nodes with yet-to-visit parents
    std::vector<NodeState> node_states;
    /// The name path buffer
    std::vector<NameID> name_path_buffer;
    /// The pending table columns
    ChunkBuffer<OverlayList<proto::TableColumn>::Node, 16> pending_columns;
    /// The free-list for pending table columns
    OverlayList<proto::TableColumn> pending_columns_free_list;
    /// The tables that are in scope
    ankerl::unordered_dense::map<Analyzer::TableKey, Analyzer::ID, Analyzer::TableKey::Hasher> scope_tables;
    /// The columns that are in scope
    ankerl::unordered_dense::map<Analyzer::ColumnKey, std::pair<Analyzer::ID, size_t>, Analyzer::ColumnKey::Hasher>
        scope_columns;

    /// The tables
    ChunkBuffer<OverlayList<proto::Table>::Node, 16> tables;
    /// The ordered table columns
    ChunkBuffer<proto::TableColumn, 16> table_columns;
    /// The table references
    ChunkBuffer<OverlayList<proto::TableReference>::Node, 16> table_references;
    /// The column references
    ChunkBuffer<OverlayList<proto::ColumnReference>::Node, 16> column_references;
    /// The join edges
    ChunkBuffer<OverlayList<proto::QueryGraphEdge>::Node, 16> graph_edges;
    /// The join edge nodes
    ChunkBuffer<OverlayList<proto::QueryGraphEdgeNode>::Node, 16> graph_edge_nodes;

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
    NameResolutionPass(ParsedScript& parser, AttributeIndex& attribute_index);

    /// Register external tables from analyzed program
    void RegisterExternalTables(const AnalyzedScript& program);

    /// Prepare the analysis pass
    void Prepare() override;
    /// Visit a chunk of nodes
    void Visit(std::span<proto::Node> morsel) override;
    /// Finish the analysis pass
    void Finish() override;

    /// Export an analyzed program
    void Export(AnalyzedScript& program);
};

}  // namespace flatsql
