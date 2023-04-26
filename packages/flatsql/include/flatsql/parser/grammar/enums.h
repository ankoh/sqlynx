#ifndef INCLUDE_FLATSQL_PARSER_GRAMMAR_ENUMS_H_
#define INCLUDE_FLATSQL_PARSER_GRAMMAR_ENUMS_H_

#include <charconv>

#include "flatsql/parser/parser_driver.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

constexpr uint32_t NO_PARENT = std::numeric_limits<uint32_t>::max();

using ExprFunc = proto::ExpressionOperator;

#define X(ENUM_TYPE, NODE_TYPE)                                                                                \
    inline proto::Node Enum(proto::Location loc, ENUM_TYPE e) {                                                \
        return proto::Node(loc, NODE_TYPE, proto::AttributeKey::NONE, NO_PARENT, static_cast<uint32_t>(e), 0); \
    }
X(proto::AConstType, proto::NodeType::ENUM_SQL_CONST_TYPE)
X(proto::CharacterType, proto::NodeType::ENUM_SQL_CHARACTER_TYPE)
X(proto::ColumnConstraint, proto::NodeType::ENUM_SQL_COLUMN_CONSTRAINT)
X(proto::CombineModifier, proto::NodeType::ENUM_SQL_COMBINE_MODIFIER)
X(proto::CombineOperation, proto::NodeType::ENUM_SQL_COMBINE_OPERATION)
X(proto::ConstraintAttribute, proto::NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE)
X(proto::ExpressionOperator, proto::NodeType::ENUM_SQL_EXPRESSION_OPERATOR)
X(proto::ExtractTarget, proto::NodeType::ENUM_SQL_EXTRACT_TARGET)
X(proto::GroupByItemType, proto::NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE)
X(proto::IntervalType, proto::NodeType::ENUM_SQL_INTERVAL_TYPE)
X(proto::JoinType, proto::NodeType::ENUM_SQL_JOIN_TYPE)
X(proto::KeyActionCommand, proto::NodeType::ENUM_SQL_KEY_ACTION_COMMAND)
X(proto::KeyActionTrigger, proto::NodeType::ENUM_SQL_KEY_ACTION_TRIGGER)
X(proto::KeyMatch, proto::NodeType::ENUM_SQL_KEY_MATCH)
X(proto::KnownFunction, proto::NodeType::ENUM_SQL_KNOWN_FUNCTION)
X(proto::NumericType, proto::NodeType::ENUM_SQL_NUMERIC_TYPE)
X(proto::OnCommitOption, proto::NodeType::ENUM_SQL_ON_COMMIT_OPTION)
X(proto::OrderDirection, proto::NodeType::ENUM_SQL_ORDER_DIRECTION)
X(proto::OrderNullRule, proto::NodeType::ENUM_SQL_ORDER_NULL_RULE)
X(proto::RowLockingBlockBehavior, proto::NodeType::ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR)
X(proto::RowLockingStrength, proto::NodeType::ENUM_SQL_ROW_LOCKING_STRENGTH)
X(proto::SampleCountUnit, proto::NodeType::ENUM_SQL_SAMPLE_UNIT_TYPE)
X(proto::SubqueryQuantifier, proto::NodeType::ENUM_SQL_SUBQUERY_QUANTIFIER)
X(proto::TableConstraint, proto::NodeType::ENUM_SQL_TABLE_CONSTRAINT)
X(proto::TempType, proto::NodeType::ENUM_SQL_TEMP_TYPE)
X(proto::TrimDirection, proto::NodeType::ENUM_SQL_TRIM_TARGET)
X(proto::WindowBoundDirection, proto::NodeType::ENUM_SQL_WINDOW_BOUND_DIRECTION)
X(proto::WindowBoundMode, proto::NodeType::ENUM_SQL_WINDOW_BOUND_MODE)
X(proto::WindowExclusionMode, proto::NodeType::ENUM_SQL_WINDOW_EXCLUSION_MODE)
X(proto::WindowRangeMode, proto::NodeType::ENUM_SQL_WINDOW_RANGE_MODE)
#undef X

const char* getEnumText(const proto::Node& target);

}  // namespace parser
}  // namespace flatsql

#endif  // INCLUDE_FLATSQL_PARSER_GRAMMAR_ENUMS_H_
