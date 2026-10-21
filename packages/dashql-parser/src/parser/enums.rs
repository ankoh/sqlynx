//! The names of enum node values (`parser/grammar/enums.cc`).

use dashql_buffers::parser::*;

/// The name of the value of an enum node. Like the C++ `getEnumText`, names are looked up by the
/// value as an index (all these enums are contiguous), except for the sparse JoinType. Enums that
/// are not listed here are named "?".
pub fn enum_text(node: &Node) -> &'static str {
    let v = node.children_begin_or_value() as usize;
    macro_rules! by_index {
        ($t:ident) => {
            $t::ENUM_VALUES.get(v).and_then(|e| e.variant_name()).unwrap_or("?")
        };
    }
    match node.node_type() {
        NodeType::ENUM_SQL_CHARACTER_TYPE => by_index!(CharacterType),
        NodeType::ENUM_SQL_COLUMN_CONSTRAINT => by_index!(ColumnConstraint),
        NodeType::ENUM_SQL_COMBINE_MODIFIER => by_index!(CombineModifier),
        NodeType::ENUM_SQL_COMBINE_OPERATION => by_index!(CombineOperation),
        NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE => by_index!(ConstraintAttribute),
        NodeType::ENUM_SQL_CONST_TYPE => by_index!(AConstType),
        NodeType::ENUM_SQL_EXPRESSION_OPERATOR => by_index!(ExpressionOperator),
        NodeType::ENUM_SQL_EXTRACT_TARGET => by_index!(ExtractTarget),
        NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE => by_index!(GroupByItemType),
        NodeType::ENUM_SQL_INTERVAL_TYPE => by_index!(IntervalType),
        NodeType::ENUM_SQL_KEY_ACTION_COMMAND => by_index!(KeyActionCommand),
        NodeType::ENUM_SQL_KEY_ACTION_TRIGGER => by_index!(KeyActionTrigger),
        NodeType::ENUM_SQL_KEY_MATCH => by_index!(KeyMatch),
        NodeType::ENUM_SQL_KNOWN_FUNCTION => by_index!(KnownFunction),
        NodeType::ENUM_SQL_NUMERIC_TYPE => by_index!(NumericType),
        NodeType::ENUM_SQL_ON_COMMIT_OPTION => by_index!(OnCommitOption),
        NodeType::ENUM_SQL_ORDER_DIRECTION => by_index!(OrderDirection),
        NodeType::ENUM_SQL_ORDER_NULL_RULE => by_index!(OrderNullRule),
        NodeType::ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR => by_index!(RowLockingBlockBehavior),
        NodeType::ENUM_SQL_ROW_LOCKING_STRENGTH => by_index!(RowLockingStrength),
        NodeType::ENUM_SQL_SAMPLE_UNIT_TYPE => by_index!(SampleCountUnit),
        NodeType::ENUM_SQL_SUBQUERY_QUANTIFIER => by_index!(SubqueryQuantifier),
        NodeType::ENUM_SQL_TABLE_CONSTRAINT => by_index!(TableConstraint),
        NodeType::ENUM_SQL_TEMP_TYPE => by_index!(TempType),
        NodeType::ENUM_SQL_TRIM_TARGET => by_index!(TrimDirection),
        NodeType::ENUM_SQL_WINDOW_BOUND_DIRECTION => by_index!(WindowBoundDirection),
        NodeType::ENUM_SQL_WINDOW_BOUND_MODE => by_index!(WindowBoundMode),
        NodeType::ENUM_SQL_WINDOW_EXCLUSION_MODE => by_index!(WindowExclusionMode),
        NodeType::ENUM_SQL_WINDOW_RANGE_MODE => by_index!(WindowRangeMode),
        NodeType::ENUM_VIS_ENCODING_CHANNEL => by_index!(VisEncodingChannel),
        NodeType::ENUM_VIS_MARK_TYPE => by_index!(VisMarkType),
        NodeType::ENUM_VIS_FIELD_TYPE => by_index!(VisFieldType),
        NodeType::ENUM_VIS_SCALE_TYPE => by_index!(VisScaleType),
        NodeType::ENUM_SQL_JOIN_TYPE => JoinType(v as u8).variant_name().filter(|_| v <= u8::MAX as usize).unwrap_or("?"),
        _ => "?",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::actions::{enum_node, NO_PARENT};

    #[test]
    fn names_enum_values() {
        let loc = SymbolSpan::default();
        assert_eq!(enum_text(&enum_node(loc, ExpressionOperator::AND)), "AND");
        assert_eq!(enum_text(&enum_node(loc, JoinType::OUTER_FULL)), "OUTER_FULL");
        assert_eq!(enum_text(&enum_node(loc, KeyMatch::FULL)), "FULL");
        assert_eq!(enum_text(&enum_node(loc, TableConstraint::UNIQUE)), "UNIQUE");
        assert_eq!(enum_text(&enum_node(loc, SampleCountUnit::PERCENT)), "PERCENT");
        let _ = NO_PARENT;
    }
}
