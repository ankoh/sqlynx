#pragma once

#include <functional>
#include <limits>
#include <tuple>
#include <unordered_map>
#include <unordered_set>

#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/context.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/attribute_index.h"
#include "sqlynx/utils/overlay_list.h"

namespace sqlynx {

class NameResolutionPass : public PassManager::LTRPass {
   protected:
    /// A resolved table column
    struct ResolvedTableColumn {
        /// The alias name
        std::string_view alias_name;
        /// The column name
        std::string_view column_name;
        /// The table
        const Schema::Table& table;
        /// The table reference id
        ContextObjectID table_reference_id;
    };
    /// A naming scope
    struct NameScope {
        /// The scope root
        size_t ast_scope_root;
        /// The parent scope
        NameScope* parent_scope;
        /// The child scopes
        OverlayList<NameScope> child_scopes;
        /// The table references in scope
        OverlayList<AnalyzedScript::TableReference> table_references;
        /// The column references in scope
        OverlayList<AnalyzedScript::ColumnReference> column_references;
        /// The resolved table references
        ankerl::unordered_dense::map<std::reference_wrapper<AnalyzedScript::TableReference>, Schema::ResolvedTable>
            resolved_table_references;
        /// The resolved table columns
        std::vector<ResolvedTableColumn> resolved_table_columns;
    };
    /// A node state during name resolution
    struct NodeState {
        /// The child scopes
        OverlayList<NameScope> child_scopes;
        /// The column definitions in the subtree
        OverlayList<AnalyzedScript::TableColumn> table_columns;
        /// The table references in scope
        OverlayList<AnalyzedScript::TableReference> table_references;
        /// The column references in scope
        OverlayList<AnalyzedScript::ColumnReference> column_references;

        /// Clear a node state
        void Clear();
        /// Merge two states
        void Merge(NodeState&& other);
    };
    /// The output
    struct Output {
        /// The tables
        std::vector<AnalyzedScript::Table> tables;
        /// The tables
        std::vector<AnalyzedScript::TableColumn> table_columns;
        /// The tables by name
        ankerl::unordered_dense::map<Schema::QualifiedTableName, std::reference_wrapper<AnalyzedScript::Table>>
            tables_by_name;
    };

   protected:
    /// The scanned program
    ScannedScript& scanned_program;
    /// The parsed program
    ParsedScript& parsed_program;
    /// The context id
    const uint32_t context_id;
    /// The schema search path
    const SchemaSearchPath& schema_search_path;
    /// The attribute index.
    AttributeIndex& attribute_index;
    /// The program nodes
    std::span<const proto::Node> nodes;

    /// The state of all nodes
    std::vector<NodeState> node_states;

    /// The naming scopes
    ChunkBuffer<OverlayList<NameScope>::Node, 16> name_scopes;
    /// The root scopes
    ankerl::unordered_dense::set<NameScope*> root_scopes;
    /// The table references
    ChunkBuffer<OverlayList<AnalyzedScript::TableReference>::Node, 16> table_references;
    /// The column references
    ChunkBuffer<OverlayList<AnalyzedScript::ColumnReference>::Node, 16> column_references;

    /// The tables
    ChunkBuffer<AnalyzedScript::Table, 16> tables;
    /// The table columns
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

    /// The output of the name resolution pass
    Output out;

    /// Merge child states into a destination state
    std::span<std::reference_wrapper<ScannedScript::Name>> ReadNamePath(const sx::Node& node);
    /// Merge child states into a destination state
    AnalyzedScript::QualifiedTableName ReadQualifiedTableName(const sx::Node* node);
    /// Merge child states into a destination state
    AnalyzedScript::QualifiedColumnName ReadQualifiedColumnName(const sx::Node* column);

    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, const sx::Node& parent);
    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, std::initializer_list<const proto::Node*> children);
    /// Create a naming scope
    NameScope& CreateScope(NodeState& target, uint32_t scope_root_node);

    using ColumnRefsByAlias =
        ankerl::unordered_dense::map<std::string_view, std::reference_wrapper<AnalyzedScript::ColumnReference>>;
    using ColumnRefsByName =
        ankerl::unordered_dense::map<std::string_view, std::reference_wrapper<AnalyzedScript::ColumnReference>>;

    /// Resolve all table refs in a scope
    void ResolveTableRefsInScope(NameScope& scope);
    /// Resolve all column refs in a scope
    void ResolveColumnRefsInScope(NameScope& scope, ColumnRefsByAlias& refs_by_alias, ColumnRefsByName& refs_by_name);
    /// Resolve all names
    void ResolveNames();

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
