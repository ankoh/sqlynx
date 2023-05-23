#pragma once

#include <unordered_set>

#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/analyzer/schema_info.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/attribute_index.h"
#include "flatsql/utils/wake_vector.h"

namespace flatsql {

class NameResolutionPass : public PassManager::LTRPass {
   public:
    template <typename T> struct Resolvable : public T {
        using ExternalTableName = schema::QualifiedTableName;
        using LocalDefinition = NodeID;
        /// The target table (if resolved)
        std::optional<std::variant<ExternalTableName, LocalDefinition>> resolves_to;
        /// Is still in scope?
        bool in_scope;

        /// Constructor
        template <typename... Args> Resolvable(Args... args) : T(std::move(args)...) {}
        /// Is resolved?
        inline bool isResolved() const { return resolves_to.has_value(); }
        /// Is in scope?
        inline bool isInScope() const { return in_scope; }
    };

    /// A name resolution state
    struct NodeState {
        /// Table definitions
        std::vector<Resolvable<schema::TableReference>> table_references;
        /// Column references
        std::vector<Resolvable<schema::ColumnReference>> column_references;
        /// Table definitions
        /// We propagate new table definitions upwards only to apply them to other subtrees!
        /// Example:
        ///     WITH foo AS (SELECT 1) SELECT * FROM (SELECT 2) AS foo;
        ///     Table definitions of SQL_SELECT_WITH_CTES are only visible in other SELECT attrs.
        std::vector<schema::TableDefinition> table_definitions;
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
    /// The external tables
    std::unordered_map<schema::QualifiedTableName, std::shared_ptr<schema::ExternalTableInfo>> external_tables;

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
