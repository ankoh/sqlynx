//! The semantic values on the parser stack.
//!
//! The C++ parser uses bison variants. Here every value is `Copy`: node lists and n-ary expressions
//! live in arenas of the parse context and are referenced by id.

use crate::names::NameId;
use dashql_buffers::parser::{AttributeKey, JoinType, Node, NumericType};

/// The text of a keyword token
pub type Str = &'static str;

/// A temporary list of nodes in the parse context (the C++ `BackedUniquePtr<NodeList>`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeList(pub(crate) u32);

/// An expression that is either a materialized node or an n-ary expression that may still be
/// flattened into an enclosing AND / OR (the C++ `ExpressionVariant`)
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExprVariant {
    Node(Node),
    Nary(u32),
}

impl From<Node> for ExprVariant {
    fn from(node: Node) -> Self {
        ExprVariant::Node(node)
    }
}

/// A value on the parser stack
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Value {
    /// The value of untyped symbols, and of typed symbols whose action does not set one
    #[default]
    Empty,
    Node(Node),
    List(NodeList),
    Key(AttributeKey),
    Expr(ExprVariant),
    Bool(bool),
    Join(JoinType),
    Numeric(NumericType),
    Str(Str),
    Name(NameId),
}

macro_rules! value_from {
    ($t:ty, $variant:ident) => {
        impl From<$t> for Value {
            fn from(v: $t) -> Self {
                Value::$variant(v)
            }
        }
    };
}

value_from!(Node, Node);
value_from!(NodeList, List);
value_from!(AttributeKey, Key);
value_from!(ExprVariant, Expr);
value_from!(bool, Bool);
value_from!(JoinType, Join);
value_from!(NumericType, Numeric);
value_from!(Str, Str);
value_from!(NameId, Name);

impl From<()> for Value {
    fn from(_: ()) -> Self {
        Value::Empty
    }
}

/// Read a typed value from the stack.
///
/// Mirrors the conversions of the C++ variants: an `ExpressionVariant` accepts a node, and a symbol
/// whose action did not set a value holds a default-constructed one.
pub trait FromValue: Sized {
    fn from_value(v: Value) -> Self;
}

#[cold]
fn type_mismatch(expected: &str, v: Value) -> ! {
    panic!("parser value type mismatch: expected {expected}, found {v:?}")
}

impl FromValue for Value {
    fn from_value(v: Value) -> Self {
        v
    }
}

impl FromValue for Node {
    fn from_value(v: Value) -> Self {
        match v {
            Value::Node(n) => n,
            Value::Empty => Node::default(),
            v => type_mismatch("Node", v),
        }
    }
}

impl FromValue for ExprVariant {
    fn from_value(v: Value) -> Self {
        match v {
            Value::Expr(e) => e,
            Value::Node(n) => ExprVariant::Node(n),
            Value::Empty => ExprVariant::Node(Node::default()),
            v => type_mismatch("ExprVariant", v),
        }
    }
}

macro_rules! from_value {
    ($t:ty, $variant:ident) => {
        impl FromValue for $t {
            fn from_value(v: Value) -> Self {
                match v {
                    Value::$variant(x) => x,
                    Value::Empty => <$t>::default(),
                    v => type_mismatch(stringify!($t), v),
                }
            }
        }
    };
}

from_value!(AttributeKey, Key);
from_value!(bool, Bool);
from_value!(JoinType, Join);
from_value!(NumericType, Numeric);
from_value!(Str, Str);
from_value!(NameId, Name);

impl FromValue for NodeList {
    fn from_value(v: Value) -> Self {
        match v {
            Value::List(l) => l,
            v => type_mismatch("NodeList", v),
        }
    }
}
