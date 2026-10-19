#pragma once

#include <functional>

#include "dashql/analyzer/pass_manager.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"
#include "dashql/text/names.h"
#include "dashql/utils/intrusive_list.h"

namespace dashql {

struct AnalysisState;

struct NameResolutionPass : public PassManager::LTRPass {
   protected:
    /// A node state during name resolution
    struct NodeState {
        /// The child scopes
        IntrusiveList<AnalyzedScript::NameScope> child_scopes;
        /// The column definitions in the subtree
        IntrusiveList<AnalyzedScript::TableColumn> table_columns;
        /// The table references in scope
        IntrusiveList<AnalyzedScript::TableReference> table_references;
        /// The column references in scope
        IntrusiveList<AnalyzedScript::Expression> column_references;
        /// The result targets in this subtree
        IntrusiveList<AnalyzedScript::ResultTarget> result_targets;
        /// The CTEs in this subtree
        IntrusiveList<AnalyzedScript::CTEDefinition> ctes;

        /// Clear a node state
        void Clear();
        /// Merge two states
        void Merge(NodeState&& other);
    };

   protected:
    /// The state of all nodes
    std::vector<NodeState> node_states;
    /// The root scopes
    ankerl::unordered_dense::set<AnalyzedScript::NameScope*> root_scopes;
    /// The temporary name path buffer
    std::vector<std::reference_wrapper<RegisteredName>> name_path_buffer;
    /// The temporary pending table columns
    ChunkBuffer<AnalyzedScript::TableColumn, 16> pending_columns;
    /// The temporary free-list for pending table columns
    IntrusiveList<AnalyzedScript::TableColumn> pending_columns_free_list;
    /// The pending result targets
    ChunkBuffer<AnalyzedScript::ResultTarget, 16> pending_result_targets;
    /// The pending CTEs
    ChunkBuffer<AnalyzedScript::CTEDefinition, 4> pending_cte_nodes;
    /// Declarations whose columns are derived after their SELECT scope is resolved.
    struct PendingDerivedTable {
        std::reference_wrapper<CatalogEntry::TableDeclaration> table;
        uint32_t select_node_id;
        std::vector<std::reference_wrapper<RegisteredName>> column_aliases;
    };
    std::vector<PendingDerivedTable> pending_derived_tables;
    /// Is the node nested inside syntax-only property graph syntax?
    bool IsInsideGraphSyntax(uint32_t ast_node_id) const;
    /// Return the statement that contains an AST node.
    uint32_t FindStatementId(uint32_t ast_node_id) const;

    /// Register a schema
    QualifiedCatalogObjectID RegisterSchema(RegisteredName& database_name, RegisteredName& schema_name);
    /// Register a table-like declaration backed by a SELECT scope.
    void RegisterDerivedTable(const buffers::parser::Node& declaration_node,
                              const buffers::parser::Node* name_node,
                              const buffers::parser::Node* columns_node,
                              const buffers::parser::Node& select_node);
    /// Materialize a pending declaration after its SELECT scope has output columns.
    void PopulateDerivedTable(PendingDerivedTable& pending, AnalyzedScript::NameScope& scope);

    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, const sx::parser::Node& parent);
    /// Merge child states into a destination state
    void MergeChildStates(NodeState& dst, std::initializer_list<const buffers::parser::Node*> children);
    /// Create a naming scope
    AnalyzedScript::NameScope& CreateScope(NodeState& target, uint32_t scope_root_node);

    /// Resolve all table refs in a scope
    void ResolveTableRefsInScope(AnalyzedScript::NameScope& scope);
    /// Resolve column refs against tables in a scope (single scope, no parent walk)
    void ResolveColumnRefsLocally(AnalyzedScript::NameScope& scope);
    /// Resolve column refs against child scope output columns
    void ResolveColumnRefsFromChildOutputs(AnalyzedScript::NameScope& scope);
    /// Resolve remaining unresolved column refs by walking up parent scopes (correlation)
    void ResolveColumnRefsFromParents(AnalyzedScript::NameScope& scope);
    /// Resolve qualified column refs whose qualifier is not a table in scope as field accesses of row-typed columns
    void ResolveRowFieldAccesses(AnalyzedScript::NameScope& scope);
    /// Associate still-unresolved column refs with unresolved tables in scope (schema inference).
    /// Emits InferenceConstraints into the AnalyzedScript for the solver to resolve in Finish().
    void AssociateUnresolvedColumns(AnalyzedScript::NameScope& scope);
    /// Populate a scope's output_columns from its result targets
    void PopulateOutputColumns(AnalyzedScript::NameScope& scope);
    /// Attach parsed CTE definitions to a SELECT or INSERT scope.
    void AttachCTEs(AnalyzedScript::NameScope& scope, IntrusiveList<AnalyzedScript::CTEDefinition>&& ctes);
    /// Bind explicit INSERT target columns after target-table resolution.
    void ResolveInsertTargetColumns();
    /// Resolve all names
    void ResolveNames();
    /// Solve the schema-inference constraints into per-table inferred schemas.
    /// Seeds forced memberships, propagates to a fixpoint, then resolves the residual ambiguity.
    void RunSchemaInference();

   public:
    /// Constructor
    NameResolutionPass(AnalysisState& state);

    /// Prepare the analysis pass
    void Prepare() override;
    /// Visit a chunk of nodes
    void Visit(std::span<const buffers::parser::Node> morsel) override;
    /// Finish the analysis pass
    void Finish() override;
};

}  // namespace dashql
