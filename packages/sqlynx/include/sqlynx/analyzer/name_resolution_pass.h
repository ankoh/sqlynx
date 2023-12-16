#pragma once

#include <limits>
#include <tuple>
#include <unordered_map>
#include <unordered_set>

#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/attribute_index.h"
#include "sqlynx/utils/overlay_list.h"

namespace sqlynx {

class NameResolutionPass : public PassManager::LTRPass {
   protected:
    /// A naming scope
    struct NameScope {
        /// The scope root
        size_t ast_scope_root;
        /// The parent scope
        NameScope* parent_scope;
        /// The child scopes
        OverlayList<NameScope> child_scopes;
    };
    /// A CRTP wrapper to attach a naming scope
    template <typename Inner> struct WithScope : public Inner {
        /// The scope where there object is defined (table, table column, table reference, column reference)
        NameScope* scope;
        /// Constructor
        template <typename... Args> WithScope(Args... args) : Inner(std::forward(args...)), scope(nullptr) {}
    };
    /// A node state during name resolution
    struct NodeState {
        /// The child scopes
        OverlayList<NameScope> child_scopes;
        /// The column definitions in the subtree
        OverlayList<AnalyzedScript::TableColumn> table_columns;
        /// The tables in scope
        OverlayList<WithScope<AnalyzedScript::Table>> tables;
        /// The table references in scope
        OverlayList<WithScope<AnalyzedScript::TableReference>> table_references;
        /// The column references in scope
        OverlayList<WithScope<AnalyzedScript::ColumnReference>> column_references;

        /// Clear a node state
        void Clear();
        /// Merge two states
        void Merge(NodeState&& other);
    };

   protected:
    /// The scanned program
    ScannedScript& scanned_program;
    /// The parsed program
    ParsedScript& parsed_program;
    /// The context id
    const uint32_t context_id;
    /// The current database name
    const std::string_view local_database_name;
    /// The current schema name
    const std::string_view local_schema_name;
    /// The schema search path
    const SchemaSearchPath& schema_search_path;
    /// The attribute index.
    AttributeIndex& attribute_index;

    /// The program nodes
    std::span<const proto::Node> nodes;

    /// The state of all visited nodes with yet-to-visit parents
    std::vector<NodeState> node_states;
    /// The naming scopes
    ChunkBuffer<OverlayList<NameScope>::Node, 16> name_scopes;
    /// The tables
    ChunkBuffer<OverlayList<WithScope<AnalyzedScript::Table>>::Node, 16> tables;
    /// The table references
    ChunkBuffer<OverlayList<WithScope<AnalyzedScript::TableReference>>::Node, 16> table_references;
    /// The column references
    ChunkBuffer<OverlayList<WithScope<AnalyzedScript::ColumnReference>>::Node, 16> column_references;

    /// The ordered table columns
    ChunkBuffer<AnalyzedScript::TableColumn, 16> table_columns;
    /// The join edges
    ChunkBuffer<AnalyzedScript::QueryGraphEdge, 16> graph_edges;
    /// The join edge nodes
    ChunkBuffer<AnalyzedScript::QueryGraphEdgeNode, 16> graph_edge_nodes;

    /// The temporary name path buffer
    std::vector<std::reference_wrapper<ScannedScript::Name>> name_path_buffer;
    /// The temporary pending table columns
    ChunkBuffer<OverlayList<AnalyzedScript::TableColumn>::Node, 16> pending_columns;
    /// The temporary free-list for pending table columns
    OverlayList<AnalyzedScript::TableColumn> pending_columns_free_list;

    /// Merge child states into a destination state
    std::span<std::reference_wrapper<ScannedScript::Name>> ReadNamePath(const sx::Node& node);
    /// Merge child states into a destination state
    AnalyzedScript::QualifiedTableName ReadQualifiedTableName(const sx::Node* node);
    /// Merge child states into a destination state
    AnalyzedScript::QualifiedColumnName ReadQualifiedColumnName(const sx::Node* column);
    /// Create a naming scope under that node
    NameScope& CreateScope(NodeState& target, uint32_t scope_root_node);
    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, const sx::Node& parent);
    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, std::initializer_list<const proto::Node*> children);

   public:
    /// Constructor
    NameResolutionPass(ParsedScript& parser, const SchemaSearchPath& schema_search_path,
                       AttributeIndex& attribute_index);

    /// Prepare the analysis pass
    void Prepare() override;
    /// Visit a chunk of nodes
    void Visit(std::span<proto::Node> morsel) override;
    /// Finish the analysis pass
    void Finish() override;

    /// Export an analyzed program
    void Export(AnalyzedScript& program);
};

}  // namespace sqlynx
