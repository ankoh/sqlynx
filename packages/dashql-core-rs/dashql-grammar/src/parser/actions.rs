//! The vocabulary of the grammar actions, a port of `include/dashql/parser/grammar/nodes.h` and
//! `enums.h`. The generated rules module (`grammar/rules_rs`) imports everything from here.

pub use super::context::{null, IntoNodeList, ParseContext, NO_PARENT};
pub use super::value::{ExprVariant, FromValue, NodeList, Str, Value};
pub use crate::names::NameId;
pub use dashql_buffers::parser::{
    AConstType, AttributeKey, CharacterType, ColumnConstraint, CombineModifier, CombineOperation, ConstraintAttribute,
    ExpressionOperator, ExtractTarget, GroupByItemType, IntervalType, JoinType, KeyActionCommand, KeyActionTrigger,
    KeyMatch, KnownFunction, Node, NodeType, NumericType, OnCommitOption, OrderDirection, OrderNullRule,
    RowLockingBlockBehavior, RowLockingStrength, SampleCountUnit, SubqueryQuantifier, SymbolSpan, TableConstraint,
    TempType, TrimDirection, VisEncodingChannel, VisFieldType, VisMarkType, VisScaleType, WindowBoundDirection,
    WindowBoundMode, WindowExclusionMode, WindowRangeMode,
};

/// Attribute keys, as the C++ actions call them
pub type Key = AttributeKey;
/// Expression operators, as the C++ actions call them
pub type ExprFunc = ExpressionOperator;

/// An empty node list (the C++ `{}`)
pub const NO_NODES: &[Node; 0] = &[];

/// The parser stack as seen by an action
pub trait ReduceStack {
    /// The value of the i-th symbol from the top
    fn value_at(&self, i: usize) -> Value;
    /// The location of the i-th symbol from the top
    fn location_at(&self, i: usize) -> SymbolSpan;
}

/// An action failed
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReduceError {
    /// The action raised `YYERROR`
    YyError,
}

/// Set the attribute key of a node
pub fn attr(key: AttributeKey, node: Node) -> Node {
    Node::new(node.symbol_span(), node.node_type(), key, node.parent(), node.children_begin_or_value(), node.children_count())
}

/// An operator
pub fn operator_node(loc: SymbolSpan) -> Node {
    Node::new(&loc, NodeType::OPERATOR, AttributeKey::NONE, NO_PARENT, 0, 0)
}

/// A name from an identifier
pub fn name_from_identifier(loc: SymbolSpan, name: NameId) -> Node {
    Node::new(&loc, NodeType::NAME, AttributeKey::NONE, NO_PARENT, name, 0)
}

/// A boolean
pub fn bool_node(loc: SymbolSpan, v: bool) -> Node {
    Node::new(&loc, NodeType::BOOL, AttributeKey::NONE, NO_PARENT, v as u32, 0)
}

/// A constant literal
pub fn const_node(loc: SymbolSpan, t: AConstType) -> Node {
    let node_type = match t {
        AConstType::NULL_ => NodeType::LITERAL_NULL,
        AConstType::INTEGER => NodeType::LITERAL_INTEGER,
        AConstType::FLOAT => NodeType::LITERAL_FLOAT,
        AConstType::STRING => NodeType::LITERAL_STRING,
        AConstType::INTERVAL => NodeType::LITERAL_INTERVAL,
        _ => return null(),
    };
    Node::new(&loc, node_type, AttributeKey::NONE, NO_PARENT, 0, 0)
}

/// Enums that become enum nodes (`Enum(loc, e)`)
pub trait EnumNodeType: Copy {
    const NODE_TYPE: NodeType;
    fn value(self) -> u32;
}

macro_rules! enum_node_types {
    ($($t:ident => $node_type:ident),* $(,)?) => {
        $(
            impl EnumNodeType for $t {
                const NODE_TYPE: NodeType = NodeType::$node_type;
                fn value(self) -> u32 {
                    self.0 as u32
                }
            }
        )*
    };
}

enum_node_types! {
    AConstType => ENUM_SQL_CONST_TYPE,
    CharacterType => ENUM_SQL_CHARACTER_TYPE,
    ColumnConstraint => ENUM_SQL_COLUMN_CONSTRAINT,
    CombineModifier => ENUM_SQL_COMBINE_MODIFIER,
    CombineOperation => ENUM_SQL_COMBINE_OPERATION,
    ConstraintAttribute => ENUM_SQL_CONSTRAINT_ATTRIBUTE,
    ExpressionOperator => ENUM_SQL_EXPRESSION_OPERATOR,
    ExtractTarget => ENUM_SQL_EXTRACT_TARGET,
    GroupByItemType => ENUM_SQL_GROUP_BY_ITEM_TYPE,
    IntervalType => ENUM_SQL_INTERVAL_TYPE,
    JoinType => ENUM_SQL_JOIN_TYPE,
    KeyActionCommand => ENUM_SQL_KEY_ACTION_COMMAND,
    KeyActionTrigger => ENUM_SQL_KEY_ACTION_TRIGGER,
    KeyMatch => ENUM_SQL_KEY_MATCH,
    KnownFunction => ENUM_SQL_KNOWN_FUNCTION,
    NumericType => ENUM_SQL_NUMERIC_TYPE,
    OnCommitOption => ENUM_SQL_ON_COMMIT_OPTION,
    OrderDirection => ENUM_SQL_ORDER_DIRECTION,
    OrderNullRule => ENUM_SQL_ORDER_NULL_RULE,
    RowLockingBlockBehavior => ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR,
    RowLockingStrength => ENUM_SQL_ROW_LOCKING_STRENGTH,
    SampleCountUnit => ENUM_SQL_SAMPLE_UNIT_TYPE,
    SubqueryQuantifier => ENUM_SQL_SUBQUERY_QUANTIFIER,
    TableConstraint => ENUM_SQL_TABLE_CONSTRAINT,
    TempType => ENUM_SQL_TEMP_TYPE,
    TrimDirection => ENUM_SQL_TRIM_TARGET,
    WindowBoundDirection => ENUM_SQL_WINDOW_BOUND_DIRECTION,
    WindowBoundMode => ENUM_SQL_WINDOW_BOUND_MODE,
    WindowExclusionMode => ENUM_SQL_WINDOW_EXCLUSION_MODE,
    WindowRangeMode => ENUM_SQL_WINDOW_RANGE_MODE,
    VisEncodingChannel => ENUM_VIS_ENCODING_CHANNEL,
    VisMarkType => ENUM_VIS_MARK_TYPE,
    VisFieldType => ENUM_VIS_FIELD_TYPE,
    VisScaleType => ENUM_VIS_SCALE_TYPE,
}

/// An enum value
pub fn enum_node<E: EnumNodeType>(loc: SymbolSpan, e: E) -> Node {
    Node::new(&loc, E::NODE_TYPE, AttributeKey::NONE, NO_PARENT, e.value(), 0)
}

/// The span covering all spans (`Loc({..})`)
pub fn loc(spans: &[SymbolSpan]) -> SymbolSpan {
    let begin = spans.iter().map(|s| s.offset()).min().unwrap_or(0);
    let end = spans.iter().map(|s| s.offset() + s.length()).max().unwrap_or(0);
    SymbolSpan::new(begin, end - begin)
}

/// Merge join types
pub fn merge_join(left: JoinType, right: JoinType) -> JoinType {
    JoinType(left.0 | right.0)
}

/// An index or slice indirection with a single index
pub fn indirection_index(ctx: &ParseContext, loc: SymbolSpan, index: Node) -> Node {
    ctx.object(loc, NodeType::OBJECT_SQL_INDIRECTION_INDEX, &[attr(Key::SQL_INDIRECTION_INDEX_VALUE, index)])
}

/// A slice indirection with bounds
pub fn indirection_index_bounds(ctx: &ParseContext, loc: SymbolSpan, lower: Node, upper: Node) -> Node {
    ctx.object(
        loc,
        NodeType::OBJECT_SQL_INDIRECTION_INDEX,
        &[attr(Key::SQL_INDIRECTION_INDEX_LOWER_BOUND, lower), attr(Key::SQL_INDIRECTION_INDEX_UPPER_BOUND, upper)],
    )
}

/// A temp table name
pub fn into_node(ctx: &ParseContext, loc: SymbolSpan, temp_type: Node, name: Node) -> Node {
    ctx.object(loc, NodeType::OBJECT_SQL_INTO, &[attr(Key::SQL_TEMP_TYPE, temp_type), attr(Key::SQL_TEMP_NAME, name)])
}

/// A column reference
pub fn column_ref(ctx: &ParseContext, loc: SymbolSpan, path: NodeList) -> Node {
    let path_nodes = ctx.array(loc, path);
    ctx.object(loc, NodeType::OBJECT_SQL_COLUMN_REF, &[attr(Key::SQL_COLUMN_REF_PATH, path_nodes)])
}

/// An expression without arguments
pub fn expr0(ctx: &ParseContext, loc: SymbolSpan, func: Node) -> Node {
    ctx.object(loc, NodeType::OBJECT_SQL_NARY_EXPRESSION, &[attr(Key::SQL_EXPRESSION_OPERATOR, func)])
}

/// A unary expression
pub fn expr1(ctx: &ParseContext, loc: SymbolSpan, func: Node, arg: impl Into<ExprVariant>) -> Node {
    let args = ctx.expression_array(loc, &[arg.into()]);
    ctx.object(
        loc,
        NodeType::OBJECT_SQL_NARY_EXPRESSION,
        &[attr(Key::SQL_EXPRESSION_OPERATOR, func), attr(Key::SQL_EXPRESSION_ARGS, args)],
    )
}

/// A postfix expression
pub fn expr_postfix(ctx: &ParseContext, loc: SymbolSpan, func: Node, arg: impl Into<ExprVariant>) -> ExprVariant {
    let args = [arg.into()];
    if let Some(merged) = ctx.try_merge(loc, func, &args) {
        return merged;
    }
    let postfix = bool_node(loc, true);
    let args = ctx.expression_array(loc, &args);
    ExprVariant::Node(ctx.object(
        loc,
        NodeType::OBJECT_SQL_NARY_EXPRESSION,
        &[
            attr(Key::SQL_EXPRESSION_OPERATOR, func),
            attr(Key::SQL_EXPRESSION_POSTFIX, postfix),
            attr(Key::SQL_EXPRESSION_ARGS, args),
        ],
    ))
}

fn nary_expr(ctx: &ParseContext, loc: SymbolSpan, func: Node, args: &[ExprVariant]) -> ExprVariant {
    if let Some(merged) = ctx.try_merge(loc, func, args) {
        return merged;
    }
    let args = ctx.expression_array(loc, args);
    ExprVariant::Node(ctx.object(
        loc,
        NodeType::OBJECT_SQL_NARY_EXPRESSION,
        &[attr(Key::SQL_EXPRESSION_OPERATOR, func), attr(Key::SQL_EXPRESSION_ARGS, args)],
    ))
}

/// A binary expression
pub fn expr2(
    ctx: &ParseContext,
    loc: SymbolSpan,
    func: Node,
    left: impl Into<ExprVariant>,
    right: impl Into<ExprVariant>,
) -> ExprVariant {
    nary_expr(ctx, loc, func, &[left.into(), right.into()])
}

/// A ternary expression
pub fn expr3(
    ctx: &ParseContext,
    loc: SymbolSpan,
    func: Node,
    arg0: impl Into<ExprVariant>,
    arg1: impl Into<ExprVariant>,
    arg2: impl Into<ExprVariant>,
) -> ExprVariant {
    nary_expr(ctx, loc, func, &[arg0.into(), arg1.into(), arg2.into()])
}

/// Negate an expression
pub fn negate(ctx: &ParseContext, loc: SymbolSpan, loc_minus: SymbolSpan, value: impl Into<ExprVariant>) -> Node {
    let op = enum_node(loc_minus, ExpressionOperator::NEGATE);
    let args = ctx.expression_array(loc, &[value.into()]);
    ctx.object(
        loc,
        NodeType::OBJECT_SQL_NARY_EXPRESSION,
        &[attr(Key::SQL_EXPRESSION_OPERATOR, op), attr(Key::SQL_EXPRESSION_ARGS, args)],
    )
}

/// A vararg field. Like the C++ `VarArgField`, every level wraps the value, not the inner level.
pub fn vararg_field(ctx: &ParseContext, loc: SymbolSpan, path: NodeList, value: Node) -> Node {
    let mut root = value;
    let keys = ctx.state.borrow().lists_snapshot(path);
    for key in keys.into_iter().rev() {
        root = ctx.object(
            loc,
            NodeType::OBJECT_EXT_VARARG_FIELD,
            &[attr(Key::EXT_VARARG_FIELD_KEY, key), attr(Key::EXT_VARARG_FIELD_VALUE, value)],
        );
    }
    root
}
