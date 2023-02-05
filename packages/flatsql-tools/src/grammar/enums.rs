use flatsql_proto as proto;

pub fn get_enum_text(target: &proto::Node) -> &'static str {
    let v = target.children_begin_or_value();
    match target.node_type() {
        proto::NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE => {
            proto::GroupByItemType(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_TEMP_TYPE => proto::TempType(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_CONST_TYPE => proto::AConstType(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_CHARACTER_TYPE => proto::CharacterType(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_EXPRESSION_OPERATOR => {
            proto::ExpressionOperator(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_ORDER_DIRECTION => proto::OrderDirection(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_ORDER_NULL_RULE => proto::OrderNullRule(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_COMBINE_MODIFIER => {
            proto::CombineModifier(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_COMBINE_OPERATION => {
            proto::CombineOperation(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_NUMERIC_TYPE => proto::NumericType(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_WINDOW_BOUND_MODE => {
            proto::WindowBoundMode(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_WINDOW_RANGE_MODE => {
            proto::WindowRangeMode(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_WINDOW_EXCLUSION_MODE => {
            proto::WindowExclusionMode(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_WINDOW_BOUND_DIRECTION => {
            proto::WindowBoundDirection(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_ON_COMMIT_OPTION => proto::OnCommitOption(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE => {
            proto::ConstraintAttribute(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_COLUMN_CONSTRAINT => {
            proto::ColumnConstraint(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_INTERVAL_TYPE => proto::IntervalType(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_SUBQUERY_QUANTIFIER => {
            proto::SubqueryQuantifier(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_KNOWN_FUNCTION => proto::KnownFunction(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_TRIM_TARGET => proto::TrimDirection(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_EXTRACT_TARGET => proto::ExtractTarget(v as u8).variant_name().unwrap_or_default(),
        proto::NodeType::ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR => proto::RowLockingBlockBehavior(v as u8)
            .variant_name()
            .unwrap_or_default(),
        proto::NodeType::ENUM_SQL_ROW_LOCKING_STRENGTH => {
            proto::RowLockingStrength(v as u8).variant_name().unwrap_or_default()
        }
        proto::NodeType::ENUM_SQL_SAMPLE_UNIT_TYPE => {
            proto::SampleCountUnit(v as u8).variant_name().unwrap_or_default()
        }

        proto::NodeType::ENUM_SQL_JOIN_TYPE => proto::JoinType(v as u8).variant_name().unwrap_or_default(),

        _ => "?",
    }
}
