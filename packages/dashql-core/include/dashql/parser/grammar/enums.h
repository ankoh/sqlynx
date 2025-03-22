#pragma once

#include <charconv>

#include "dashql/parser/parser.h"
#include "dashql/buffers/index_generated.h"

namespace dashql {
namespace parser {

constexpr uint32_t NO_PARENT = std::numeric_limits<uint32_t>::max();

using ExprFunc = buffers::ExpressionOperator;

#define X(ENUM_TYPE, NODE_TYPE)                                                                                \
    inline buffers::Node Enum(buffers::Location loc, ENUM_TYPE e) {                                                \
        return buffers::Node(loc, NODE_TYPE, buffers::AttributeKey::NONE, NO_PARENT, static_cast<uint32_t>(e), 0); \
    }
X(buffers::AConstType, buffers::NodeType::ENUM_SQL_CONST_TYPE)
X(buffers::CharacterType, buffers::NodeType::ENUM_SQL_CHARACTER_TYPE)
X(buffers::ColumnConstraint, buffers::NodeType::ENUM_SQL_COLUMN_CONSTRAINT)
X(buffers::CombineModifier, buffers::NodeType::ENUM_SQL_COMBINE_MODIFIER)
X(buffers::CombineOperation, buffers::NodeType::ENUM_SQL_COMBINE_OPERATION)
X(buffers::ConstraintAttribute, buffers::NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE)
X(buffers::ExpressionOperator, buffers::NodeType::ENUM_SQL_EXPRESSION_OPERATOR)
X(buffers::ExtractTarget, buffers::NodeType::ENUM_SQL_EXTRACT_TARGET)
X(buffers::GroupByItemType, buffers::NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE)
X(buffers::IntervalType, buffers::NodeType::ENUM_SQL_INTERVAL_TYPE)
X(buffers::JoinType, buffers::NodeType::ENUM_SQL_JOIN_TYPE)
X(buffers::KeyActionCommand, buffers::NodeType::ENUM_SQL_KEY_ACTION_COMMAND)
X(buffers::KeyActionTrigger, buffers::NodeType::ENUM_SQL_KEY_ACTION_TRIGGER)
X(buffers::KeyMatch, buffers::NodeType::ENUM_SQL_KEY_MATCH)
X(buffers::KnownFunction, buffers::NodeType::ENUM_SQL_KNOWN_FUNCTION)
X(buffers::NumericType, buffers::NodeType::ENUM_SQL_NUMERIC_TYPE)
X(buffers::OnCommitOption, buffers::NodeType::ENUM_SQL_ON_COMMIT_OPTION)
X(buffers::OrderDirection, buffers::NodeType::ENUM_SQL_ORDER_DIRECTION)
X(buffers::OrderNullRule, buffers::NodeType::ENUM_SQL_ORDER_NULL_RULE)
X(buffers::RowLockingBlockBehavior, buffers::NodeType::ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR)
X(buffers::RowLockingStrength, buffers::NodeType::ENUM_SQL_ROW_LOCKING_STRENGTH)
X(buffers::SampleCountUnit, buffers::NodeType::ENUM_SQL_SAMPLE_UNIT_TYPE)
X(buffers::SubqueryQuantifier, buffers::NodeType::ENUM_SQL_SUBQUERY_QUANTIFIER)
X(buffers::TableConstraint, buffers::NodeType::ENUM_SQL_TABLE_CONSTRAINT)
X(buffers::TempType, buffers::NodeType::ENUM_SQL_TEMP_TYPE)
X(buffers::TrimDirection, buffers::NodeType::ENUM_SQL_TRIM_TARGET)
X(buffers::WindowBoundDirection, buffers::NodeType::ENUM_SQL_WINDOW_BOUND_DIRECTION)
X(buffers::WindowBoundMode, buffers::NodeType::ENUM_SQL_WINDOW_BOUND_MODE)
X(buffers::WindowExclusionMode, buffers::NodeType::ENUM_SQL_WINDOW_EXCLUSION_MODE)
X(buffers::WindowRangeMode, buffers::NodeType::ENUM_SQL_WINDOW_RANGE_MODE)
#undef X

const char* getEnumText(const buffers::Node& target);

}  // namespace parser
}  // namespace dashql
