#include "sqlynx/parser/grammar/enums.h"

#include <algorithm>

#include "sqlynx/proto/proto_generated.h"

namespace sqlynx {
namespace parser {

const char* getEnumText(const proto::Node& target) {
    auto nt = target.node_type();
    auto v = static_cast<uint32_t>(target.children_begin_or_value());
    switch (nt) {
#define X(ENUM_TYPE, TYPE_TABLE)     \
    case proto::NodeType::ENUM_TYPE: \
        return proto::TYPE_TABLE()->names[v];
        X(ENUM_SQL_CHARACTER_TYPE, CharacterTypeTypeTable)
        X(ENUM_SQL_COLUMN_CONSTRAINT, ColumnConstraintTypeTable)
        X(ENUM_SQL_COMBINE_MODIFIER, CombineModifierTypeTable)
        X(ENUM_SQL_COMBINE_OPERATION, CombineOperationTypeTable)
        X(ENUM_SQL_CONSTRAINT_ATTRIBUTE, ConstraintAttributeTypeTable)
        X(ENUM_SQL_CONST_TYPE, AConstTypeTypeTable)
        X(ENUM_SQL_EXPRESSION_OPERATOR, ExpressionOperatorTypeTable)
        X(ENUM_SQL_EXTRACT_TARGET, ExtractTargetTypeTable)
        X(ENUM_SQL_GROUP_BY_ITEM_TYPE, GroupByItemTypeTypeTable)
        X(ENUM_SQL_INTERVAL_TYPE, IntervalTypeTypeTable)
        X(ENUM_SQL_KNOWN_FUNCTION, KnownFunctionTypeTable)
        X(ENUM_SQL_NUMERIC_TYPE, NumericTypeTypeTable)
        X(ENUM_SQL_ON_COMMIT_OPTION, OnCommitOptionTypeTable)
        X(ENUM_SQL_ORDER_DIRECTION, OrderDirectionTypeTable)
        X(ENUM_SQL_ORDER_NULL_RULE, OrderNullRuleTypeTable)
        X(ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR, RowLockingBlockBehaviorTypeTable)
        X(ENUM_SQL_ROW_LOCKING_STRENGTH, RowLockingStrengthTypeTable)
        X(ENUM_SQL_SUBQUERY_QUANTIFIER, SubqueryQuantifierTypeTable)
        X(ENUM_SQL_TEMP_TYPE, TempTypeTypeTable)
        X(ENUM_SQL_TRIM_TARGET, TrimDirectionTypeTable)
        X(ENUM_SQL_WINDOW_BOUND_DIRECTION, WindowBoundDirectionTypeTable)
        X(ENUM_SQL_WINDOW_BOUND_MODE, WindowBoundModeTypeTable)
        X(ENUM_SQL_WINDOW_EXCLUSION_MODE, WindowExclusionModeTypeTable)
        X(ENUM_SQL_WINDOW_RANGE_MODE, WindowRangeModeTypeTable)
#undef X

        case proto::NodeType::ENUM_SQL_JOIN_TYPE: {
            auto tt = proto::JoinTypeTypeTable();
            auto iter =
                std::lower_bound(tt->values, tt->values + tt->num_elems, v, [](auto l, auto r) { return l < r; });
            if (iter >= (tt->values + tt->num_elems) || *iter != v) {
                return "?";
            }
            auto idx = iter - tt->values;
            return proto::JoinTypeTypeTable()->names[idx];
        }

        default:
            return "?";
    }
}

}  // namespace parser
}  // namespace sqlynx
