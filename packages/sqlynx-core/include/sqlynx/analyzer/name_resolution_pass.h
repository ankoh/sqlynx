#pragma once

#include <functional>
#include <unordered_map>

#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/external.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/text/names.h"
#include "sqlynx/utils/attribute_index.h"
#include "sqlynx/utils/hash.h"
#include "sqlynx/utils/overlay_list.h"

namespace sqlynx {

class NameResolutionPass : public PassManager::LTRPass {
   protected:
    /// A node state during name resolution
    struct NodeState {
        /// The child scopes
        OverlayList<AnalyzedScript::NameScope> child_scopes;
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

   protected:
    /// The scanned program
    ScannedScript& scanned_program;
    /// The parsed program
    ParsedScript& parsed_program;
    /// The external id of the current script
    const CatalogEntryID catalog_entry_id;
    /// The catalog
    Catalog& catalog;
    /// The attribute index
    AttributeIndex& attribute_index;
    /// The ast
    std::span<const proto::Node> ast;

    /// The database references
    decltype(AnalyzedScript::database_references) database_references;
    /// The schema references
    decltype(AnalyzedScript::schema_references) schema_references;
    /// The table declarations
    decltype(AnalyzedScript::table_declarations) table_declarations;
    /// The table references
    decltype(AnalyzedScript::table_references) table_references;
    /// The column references
    decltype(AnalyzedScript::column_references) column_references;
    /// The naming scopes
    decltype(AnalyzedScript::name_scopes) name_scopes;
    /// The query graph edges
    decltype(AnalyzedScript::graph_edges) graph_edges;
    /// The query graph edge nodes
    decltype(AnalyzedScript::graph_edge_nodes) graph_edge_nodes;

    /// The databases, indexed by name
    decltype(AnalyzedScript::databases_by_name) databases_by_name;
    /// The schema, indexed by name
    decltype(AnalyzedScript::schemas_by_name) schemas_by_name;
    /// The tables, indexed by name
    decltype(AnalyzedScript::tables_by_name) tables_by_name;

    /// The default database name
    RegisteredName& default_database_name;
    /// The default schema name
    RegisteredName& default_schema_name;

    /// The state of all nodes
    std::vector<NodeState> node_states;

    /// The root scopes
    ankerl::unordered_dense::set<AnalyzedScript::NameScope*> root_scopes;

    /// The temporary name path buffer
    std::vector<std::reference_wrapper<RegisteredName>> name_path_buffer;
    /// The temporary pending table columns
    ChunkBuffer<OverlayList<AnalyzedScript::TableColumn>::Node, 16> pending_columns;
    /// The temporary free-list for pending table columns
    OverlayList<AnalyzedScript::TableColumn> pending_columns_free_list;

    /// Merge child states into a destination state
    std::span<std::reference_wrapper<RegisteredName>> ReadNamePath(const sx::Node& node);
    /// Merge child states into a destination state
    std::optional<AnalyzedScript::QualifiedTableName> ReadQualifiedTableName(const sx::Node* node);
    /// Merge child states into a destination state
    std::optional<AnalyzedScript::QualifiedColumnName> ReadQualifiedColumnName(const sx::Node* column);

    /// Register a schema
    std::pair<CatalogDatabaseID, CatalogSchemaID> RegisterSchema(RegisteredName& database_name,
                                                                 RegisteredName& schema_name);

    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, const sx::Node& parent);
    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, std::initializer_list<const proto::Node*> children);
    /// Create a naming scope
    AnalyzedScript::NameScope& CreateScope(NodeState& target, uint32_t scope_root_node);

    using ColumnRefsByAlias =
        ankerl::unordered_dense::map<std::string_view, std::reference_wrapper<AnalyzedScript::ColumnReference>>;
    using ColumnRefsByName =
        ankerl::unordered_dense::map<std::string_view, std::reference_wrapper<AnalyzedScript::ColumnReference>>;

    /// Resolve all table refs in a scope
    void ResolveTableRefsInScope(AnalyzedScript::NameScope& scope);
    /// Resolve all column refs in a scope
    void ResolveColumnRefsInScope(AnalyzedScript::NameScope& scope, ColumnRefsByAlias& refs_by_alias,
                                  ColumnRefsByName& refs_by_name);
    /// Resolve all names
    void ResolveNames();

   public:
    /// Constructor
    NameResolutionPass(ParsedScript& parser, Catalog& registry, AttributeIndex& attribute_index);

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
