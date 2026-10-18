#pragma once

#include <span>
#include <string>
#include <unordered_map>
#include <vector>

#include "dashql/buffers/index_generated.h"
#include "dashql/formatter/formatting_program.h"
#include "dashql/script.h"
#include "dashql/utils/ast_attributes.h"

namespace dashql {

enum class FormattingAssociativity { Left, Right, NonAssoc };

struct FormattingNodeState {
    size_t precedence = 0;
    FormattingAssociativity associativity = FormattingAssociativity::NonAssoc;
    bool needs_parentheses = false;
    bool is_statement_root = false;
    FmtReg reg = 0;
};

struct Formatter {
   public:
    using Associativity = FormattingAssociativity;
    using NodeState = FormattingNodeState;

   protected:
    const ScannedScript& scanned;
    /// Emit executable literals instead of obfuscated literal markers?
    bool replace_obfuscated_literals = false;
    const ParsedScript& parsed;
    const std::span<const buffers::parser::Node> ast;
    buffers::formatting::FormattingConfigT config;
    FormattingProgram fmt;
    std::vector<NodeState> node_states;
    std::vector<uint32_t> unformattable_nodes;

    NodeState& GetState(const buffers::parser::Node& node) { return node_states[&node - ast.data()]; }
    const NodeState& GetState(const buffers::parser::Node& node) const { return node_states[&node - ast.data()]; }
    FmtReg Reg(const buffers::parser::Node& node) const { return GetState(node).reg; }

    std::span<NodeState> GetArrayStates(const buffers::parser::Node& node) {
        assert(node.node_type() == buffers::parser::NodeType::ARRAY);
        return std::span{node_states}.subspan(node.children_begin_or_value(), node.children_count());
    }

    template <buffers::parser::AttributeKey... keys>
    AttributeLookupResult<keys...> GetAttributes(const buffers::parser::Node& node) const {
        assert(node.node_type() >= buffers::parser::NodeType::OBJECT_KEYS_);
        return LookupAttributes<keys...>(ast.subspan(node.children_begin_or_value(), node.children_count()));
    }

    void PreparePrecedence();
    void IdentifyParentheses(size_t node_id);
    void BuildDocs();
    void MarkExplainInnerStatementRoot(size_t root_id);

    FmtReg FormatNode(size_t node_id);
    FmtReg FormatArray(const buffers::parser::Node& node);
    FmtReg FormatSelect(size_t node_id);
    FmtReg FormatInsert(const buffers::parser::Node& node);
    FmtReg FormatDelete(const buffers::parser::Node& node);
    FmtReg FormatCreate(size_t node_id);
    FmtReg FormatCreateAs(const buffers::parser::Node& node);
    FmtReg FormatView(const buffers::parser::Node& node);
    FmtReg FormatCreateFunction(const buffers::parser::Node& node);
    FmtReg FormatDrop(const buffers::parser::Node& node, bool table);
    FmtReg FormatAttachDatabase(const buffers::parser::Node& node);
    FmtReg FormatAttachDatabaseOption(const buffers::parser::Node& node);
    FmtReg FormatFunctionParam(const buffers::parser::Node& node);
    FmtReg FormatSet(const buffers::parser::Node& node);
    FmtReg FormatVarargField(const buffers::parser::Node& node);
    FmtReg FormatExplain(size_t node_id);
    FmtReg FormatExplainExpressions(const buffers::parser::Node& node);
    FmtReg FormatResultTarget(const buffers::parser::Node& node);
    FmtReg FormatTableRef(const buffers::parser::Node& node);
    FmtReg FormatJoinedTable(const buffers::parser::Node& node);
    FmtReg FormatInto(const buffers::parser::Node& node);
    FmtReg FormatWindowDef(const buffers::parser::Node& node);
    FmtReg FormatRowLocking(const buffers::parser::Node& node);
    FmtReg FormatRowLockingStrength(const buffers::parser::Node& node);
    FmtReg FormatRowLockingBlockBehavior(const buffers::parser::Node& node);
    FmtReg FormatSample(const buffers::parser::Node& node, bool table_sample);
    FmtReg FormatSampleUnit(const buffers::parser::Node& node);
    FmtReg FormatGroupByItem(const buffers::parser::Node& node);
    FmtReg FormatOrder(const buffers::parser::Node& node);
    FmtReg FormatOrderDirection(const buffers::parser::Node& node);
    FmtReg FormatOrderNullRule(const buffers::parser::Node& node);
    FmtReg FormatTempType(const buffers::parser::Node& node);
    FmtReg FormatOnCommitOption(const buffers::parser::Node& node);
    FmtReg FormatTypeName(const buffers::parser::Node& node);
    FmtReg FormatIntervalType(const buffers::parser::Node& node);
    FmtReg FormatIntervalTypeEnum(const buffers::parser::Node& node);
    FmtReg FormatConstTypeCast(const buffers::parser::Node& node);
    FmtReg FormatConstIntervalCast(const buffers::parser::Node& node);
    FmtReg FormatConstFunctionCast(const buffers::parser::Node& node);
    FmtReg FormatNumericType(const buffers::parser::Node& node);
    FmtReg FormatNumericTypeBase(const buffers::parser::Node& node);
    FmtReg FormatCharacterType(const buffers::parser::Node& node);
    FmtReg FormatCharacterTypeBase(const buffers::parser::Node& node);
    FmtReg FormatGenericType(const buffers::parser::Node& node);
    FmtReg FormatTimestampType(const buffers::parser::Node& node);
    FmtReg FormatColumnRef(const buffers::parser::Node& node);
    FmtReg FormatParameterRef(const buffers::parser::Node& node);
    FmtReg FormatRelationExpression(const buffers::parser::Node& node);
    FmtReg FormatDescriptor(const buffers::parser::Node& node);
    FmtReg FormatSelectExpression(const buffers::parser::Node& node);
    FmtReg FormatColumnDef(const buffers::parser::Node& node);
    FmtReg FormatTableConstraintType(const buffers::parser::Node& node);
    FmtReg FormatTableConstraint(const buffers::parser::Node& node);
    FmtReg FormatKeyMatch(const buffers::parser::Node& node);
    FmtReg FormatKeyActionCommand(const buffers::parser::Node& node);
    FmtReg FormatKeyActionTrigger(const buffers::parser::Node& node);
    FmtReg FormatKeyAction(const buffers::parser::Node& node);
    FmtReg FormatColumnConstraintType(const buffers::parser::Node& node);
    FmtReg FormatColumnConstraint(const buffers::parser::Node& node);
    FmtReg FormatConstraintAttribute(const buffers::parser::Node& node);
    FmtReg FormatAlias(const buffers::parser::Node& node);
    FmtReg FormatTypecastExpression(const buffers::parser::Node& node);
    FmtReg FormatCase(const buffers::parser::Node& node);
    FmtReg FormatCaseClause(const buffers::parser::Node& node);
    FmtReg FormatExistsExpression(const buffers::parser::Node& node);
    FmtReg FormatCTE(const buffers::parser::Node& node);
    FmtReg FormatPropertyGraph(const buffers::parser::Node& node);
    FmtReg FormatGraphElementTable(const buffers::parser::Node& node);
    FmtReg FormatGraphVertexReference(const buffers::parser::Node& node);
    FmtReg FormatGraphLabel(const buffers::parser::Node& node);
    FmtReg FormatGraphProperties(const buffers::parser::Node& node);
    FmtReg FormatGraphProperty(const buffers::parser::Node& node);
    FmtReg FormatGraphTable(const buffers::parser::Node& node);
    FmtReg FormatGraphMatch(const buffers::parser::Node& node);
    FmtReg FormatGraphPathElement(const buffers::parser::Node& node);
    FmtReg FormatGraphQuantifier(const buffers::parser::Node& node);
    FmtReg FormatGraphLabelExpression(const buffers::parser::Node& node);
    FmtReg FormatGraphRows(const buffers::parser::Node& node);
    FmtReg FormatExtractTarget(const buffers::parser::Node& node);
    FmtReg FormatTrimDirection(const buffers::parser::Node& node);
    FmtReg FormatGenericOption(const buffers::parser::Node& node);
    FmtReg FormatFunctionExpression(const buffers::parser::Node& node);
    FmtReg FormatFunctionTable(const buffers::parser::Node& node);
    FmtReg FormatFunctionArg(const buffers::parser::Node& node);
    FmtReg FormatWindowFrame(const buffers::parser::Node& node);
    FmtReg FormatWindowBound(const buffers::parser::Node& node);
    FmtReg FormatWindowBoundMode(const buffers::parser::Node& node);
    FmtReg FormatWindowBoundDirection(const buffers::parser::Node& node);
    FmtReg FormatWindowRangeMode(const buffers::parser::Node& node);
    FmtReg FormatExpressionOperatorType(const buffers::parser::Node& node);
    FmtReg FormatExpression(size_t node_id);
    FmtReg FormatVisualize(size_t node_id);
    FmtReg FormatVisPropertyList(const buffers::parser::Node& node);
    FmtReg FormatVisEnum(const buffers::parser::Node& node);
    FmtReg FormatVarargArray(const buffers::parser::Node& node);
    FmtReg FormatLeaf(const buffers::parser::Node& node);
    FmtReg FormatUnimplemented(const buffers::parser::Node& node);

    FmtReg FormatCommaList(const buffers::parser::Node& node, bool indent_after_breaks = true);
    FmtReg FormatQualifiedName(const buffers::parser::Node& node);

    std::string WriteOutput() const;
    std::string Render(FmtReg reg) const;

   public:
    explicit Formatter(ParsedScript& parsed);

    /// Emit executable literals instead of the obfuscated literal markers of Hyper
    void ReplaceObfuscatedLiterals() { replace_obfuscated_literals = true; }

    size_t EstimateFormattedSize() const;
    std::string Format(const buffers::formatting::FormattingConfigT& config);
    std::string FormatNodeAt(size_t node_id, const buffers::formatting::FormattingConfigT& config);
    const std::vector<uint32_t>& GetUnformattableNodes() const { return unformattable_nodes; }
    bool IsFullyFormatted() const;
};

}  // namespace dashql
