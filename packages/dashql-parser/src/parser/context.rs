//! The parse context, a port of the C++ `src/parser/parse_context.cc`.
//!
//! The grammar actions build the AST through the parse context. Nodes are appended to a flat buffer
//! in post-order: `object` and `array` emit the children of a node and return the node itself,
//! which the enclosing rule emits later. Every method takes `&self` (the state sits in a
//! [`StateCell`]) so that the translated actions can nest calls like
//! `ctx.object(.., &[attr(.., ctx.array(..))])` with the same evaluation order as the C++ actions.

use super::value::{ExprVariant, NodeList};
use crate::names::NameRegistry;
use crate::scanner::Symbol;
use crate::span::TextSpan;
use dashql_buffers::parser::{AttributeKey, ExpressionOperator, Node, NodeType, NumericType, StatementType, SymbolSpan};

/// The cell of the parse context state.
///
/// Methods of the parse context borrow the state only within their own body and never call each
/// other while holding a borrow. Debug builds check this with a `RefCell`, release builds skip the
/// bookkeeping, which is a hot path of parsing (about a thousand borrows per statement).
#[cfg(debug_assertions)]
pub(crate) struct StateCell<T>(std::cell::RefCell<T>);

#[cfg(debug_assertions)]
impl<T> StateCell<T> {
    fn new(value: T) -> Self {
        Self(std::cell::RefCell::new(value))
    }
    pub(crate) fn borrow(&self) -> std::cell::Ref<'_, T> {
        self.0.borrow()
    }
    pub(crate) fn borrow_mut(&self) -> std::cell::RefMut<'_, T> {
        self.0.borrow_mut()
    }
    fn into_inner(self) -> T {
        self.0.into_inner()
    }
}

#[cfg(not(debug_assertions))]
pub(crate) struct StateCell<T>(std::cell::UnsafeCell<T>);

#[cfg(not(debug_assertions))]
impl<T> StateCell<T> {
    fn new(value: T) -> Self {
        Self(std::cell::UnsafeCell::new(value))
    }
    pub(crate) fn borrow(&self) -> &T {
        // SAFETY: borrows never overlap with a mutable borrow, checked by debug builds.
        unsafe { &*self.0.get() }
    }
    #[allow(clippy::mut_from_ref)]
    pub(crate) fn borrow_mut(&self) -> &mut T {
        // SAFETY: borrows never overlap, checked by debug builds.
        unsafe { &mut *self.0.get() }
    }
    fn into_inner(self) -> T {
        self.0.into_inner()
    }
}

/// The parent of nodes that have none (yet)
pub const NO_PARENT: u32 = u32::MAX;

/// A parsed statement
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Statement {
    pub statement_type: StatementType,
    /// The root node
    pub root: u32,
    /// The first node of the statement
    pub nodes_begin: u32,
    /// The number of nodes of the statement
    pub node_count: u32,
}

impl Default for Statement {
    fn default() -> Self {
        Self {
            statement_type: StatementType::NONE,
            root: u32::MAX,
            nodes_begin: 0,
            node_count: 0,
        }
    }
}

/// A parser error, located by symbol indexes
#[derive(Clone, Debug, PartialEq)]
pub struct ParseError {
    pub location: SymbolSpan,
    pub message: String,
    pub hint: String,
}

/// An n-ary expression whose materialization is deferred to flatten conjunctions and disjunctions
#[derive(Clone, Copy, Debug)]
struct NaryExpression {
    location: SymbolSpan,
    op: ExpressionOperator,
    op_node: Node,
    args: NodeList,
}

/// The mutable state of the parse context
#[derive(Default)]
pub(crate) struct State {
    pub(crate) nodes: Vec<Node>,
    pub(crate) statements: Vec<Statement>,
    pub(crate) errors: Vec<ParseError>,
    pub(crate) vis_spec_spans: Vec<(u32, u32)>,
    pub(crate) names: NameRegistry,
    /// The hint of the next error, produced while building a syntax error message
    pub(crate) pending_hint: String,
    /// Set by an action to drop the lookahead (`yyclearin`)
    pub(crate) clear_lookahead: bool,
    current_statement: Statement,
    lists: Vec<Vec<Node>>,
    /// Consumed lists whose allocation can be reused
    free_lists: Vec<u32>,
    nary_expressions: Vec<NaryExpression>,
}

impl State {
    /// A copy of the nodes of a list
    pub(crate) fn lists_snapshot(&self, list: NodeList) -> Vec<Node> {
        self.lists[list.0 as usize].clone()
    }
}

/// The parse context
pub struct ParseContext<'a> {
    /// The script text
    text: &'a str,
    /// The scanned symbols, located by byte spans
    symbols: &'a [Symbol],
    /// Is the VISUALISE syntax enabled?
    vis_enabled: bool,
    pub(crate) state: StateCell<State>,
}

/// Arguments that are node lists: list ids and node slices (the C++ initializer lists)
pub trait IntoNodeList {
    fn into_node_list(self, ctx: &ParseContext) -> NodeList;
}

impl IntoNodeList for NodeList {
    fn into_node_list(self, _ctx: &ParseContext) -> NodeList {
        self
    }
}

impl<const N: usize> IntoNodeList for &[Node; N] {
    fn into_node_list(self, ctx: &ParseContext) -> NodeList {
        ctx.list(&self[..])
    }
}

impl IntoNodeList for &[Node] {
    fn into_node_list(self, ctx: &ParseContext) -> NodeList {
        ctx.list(self)
    }
}

/// A node with replaced fields
fn with_parent(n: &Node, parent: u32) -> Node {
    Node::new(n.symbol_span(), n.node_type(), n.attribute_key(), parent, n.children_begin_or_value(), n.children_count())
}

/// The null node, skipped by `object` and `array`
pub fn null() -> Node {
    Node::new(&SymbolSpan::default(), NodeType::NONE, AttributeKey::NONE, NO_PARENT, 0, 0)
}

impl<'a> ParseContext<'a> {
    pub fn new(text: &'a str, symbols: &'a [Symbol], names: NameRegistry, vis_enabled: bool) -> Self {
        Self {
            text,
            symbols,
            vis_enabled,
            state: StateCell::new(State {
                names,
                nodes: Vec::with_capacity(symbols.len() * 3),
                ..Default::default()
            }),
        }
    }

    /// Is the VISUALISE syntax enabled?
    pub fn is_vis_enabled(&self) -> bool {
        self.vis_enabled
    }

    /// The scanned symbols
    pub fn symbols(&self) -> &'a [Symbol] {
        self.symbols
    }

    /// Finish parsing and return the state
    pub(crate) fn into_state(self) -> State {
        self.state.into_inner()
    }

    /// Resolve a span of symbol indexes to a span of bytes (`ScannedScript::ResolveTextSpan`)
    pub fn resolve_text_span(&self, span: SymbolSpan) -> TextSpan {
        resolve_text_span(self.text, self.symbols, span)
    }

    /// The text of a span of symbols
    fn text_at(&self, span: SymbolSpan) -> &'a str {
        let ts = self.resolve_text_span(span);
        &self.text[ts.offset as usize..ts.end() as usize]
    }

    // -----------------------------------------------------------------------------------------
    // Lists
    // -----------------------------------------------------------------------------------------

    /// Create a list
    pub fn list(&self, nodes: &[Node]) -> NodeList {
        let mut state = self.state.borrow_mut();
        if let Some(id) = state.free_lists.pop() {
            state.lists[id as usize].extend_from_slice(nodes);
            return NodeList(id);
        }
        state.lists.push(nodes.to_vec());
        NodeList(state.lists.len() as u32 - 1)
    }

    /// Release a consumed list, keeping its allocation for reuse
    fn recycle(&self, list: NodeList, mut nodes: Vec<Node>) {
        nodes.clear();
        let mut state = self.state.borrow_mut();
        state.lists[list.0 as usize] = nodes;
        state.free_lists.push(list.0);
    }

    /// Append a node
    pub fn push_back(&self, list: NodeList, node: Node) {
        self.state.borrow_mut().lists[list.0 as usize].push(node);
    }

    /// Prepend a node
    pub fn push_front(&self, list: NodeList, node: Node) {
        self.state.borrow_mut().lists[list.0 as usize].insert(0, node);
    }

    /// Is a list empty?
    pub fn list_is_empty(&self, list: NodeList) -> bool {
        self.state.borrow().lists[list.0 as usize].is_empty()
    }

    /// Move the nodes of a list
    fn take_list(&self, list: NodeList) -> Vec<Node> {
        std::mem::take(&mut self.state.borrow_mut().lists[list.0 as usize])
    }

    /// Append the nodes of `other` to `list` (`NodeList::append`)
    fn append(&self, list: NodeList, other: impl IntoNodeList) {
        let other = other.into_node_list(self);
        if other == list {
            return;
        }
        let nodes = self.take_list(other);
        self.state.borrow_mut().lists[list.0 as usize].extend_from_slice(&nodes);
        self.recycle(other, nodes);
    }

    /// `Concat(l, r)`
    pub fn concat2(&self, l: impl IntoNodeList, r: impl IntoNodeList) -> NodeList {
        let l = l.into_node_list(self);
        self.append(l, r);
        l
    }

    /// `Concat(v0, v1, v2)`
    pub fn concat3(&self, v0: impl IntoNodeList, v1: impl IntoNodeList, v2: impl IntoNodeList) -> NodeList {
        let v0 = v0.into_node_list(self);
        self.append(v0, v1);
        self.append(v0, v2);
        v0
    }

    /// `Concat(v0, v1, v2, v3)`
    pub fn concat4(
        &self,
        v0: impl IntoNodeList,
        v1: impl IntoNodeList,
        v2: impl IntoNodeList,
        v3: impl IntoNodeList,
    ) -> NodeList {
        let v0 = v0.into_node_list(self);
        self.append(v0, v1);
        self.append(v0, v2);
        self.append(v0, v3);
        v0
    }

    // -----------------------------------------------------------------------------------------
    // Nodes
    // -----------------------------------------------------------------------------------------

    /// Emit a node and set the parent of its children (`ParseContext::AddNode`)
    pub fn add_node(&self, node: Node) -> u32 {
        let mut state = self.state.borrow_mut();
        let node_id = state.nodes.len() as u32;
        state.nodes.push(with_parent(&node, node_id));
        let node_type = node.node_type();
        // ENUM_VIS_* nodes are numbered above OBJECT_KEYS_ too, but have no children (their value
        // is not a child range).
        if (node_type == NodeType::ARRAY || node_type.0 > NodeType::OBJECT_KEYS_.0) && node.children_count() > 0 {
            let begin = node.children_begin_or_value() as usize;
            let end = begin + node.children_count() as usize;
            for child in &mut state.nodes[begin..end] {
                *child = with_parent(child, node_id);
            }
        }
        node_id
    }

    /// Emit the children of a list and return their range, skipping null nodes
    fn emit_children(&self, list: NodeList) -> (u32, u32) {
        let begin = self.state.borrow().nodes.len() as u32;
        let nodes = self.take_list(list);
        for node in &nodes {
            if node.node_type() == NodeType::NONE {
                continue;
            }
            self.add_node(*node);
        }
        self.recycle(list, nodes);
        let n = self.state.borrow().nodes.len() as u32 - begin;
        (begin, n)
    }

    /// The span from the first to the last of `n` nodes starting at `begin`
    fn shrunk_location(&self, begin: u32, n: u32) -> SymbolSpan {
        let state = self.state.borrow();
        let first = state.nodes[begin as usize].symbol_span().offset();
        let last = state.nodes[(begin + n - 1) as usize].symbol_span();
        SymbolSpan::new(first, last.offset().wrapping_add(last.length()).wrapping_sub(first))
    }

    /// An array of nodes (`ParseContext::Array`)
    pub fn array(&self, loc: SymbolSpan, values: impl IntoNodeList) -> Node {
        self.array_ex(loc, values, true, false)
    }

    /// An array of nodes with explicit options
    pub fn array_ex(&self, mut loc: SymbolSpan, values: impl IntoNodeList, null_if_empty: bool, shrink_location: bool) -> Node {
        let list = values.into_node_list(self);
        let (begin, n) = self.emit_children(list);
        if n == 0 && null_if_empty {
            return null();
        }
        if n > 0 && shrink_location {
            loc = self.shrunk_location(begin, n);
        }
        Node::new(&loc, NodeType::ARRAY, AttributeKey::NONE, NO_PARENT, begin, n)
    }

    /// An array of expressions
    pub(crate) fn expression_array(&self, loc: SymbolSpan, exprs: &[ExprVariant]) -> Node {
        let nodes = self.list(&[]);
        for &expr in exprs {
            let node = self.expression(expr);
            self.push_back(nodes, node);
        }
        self.array(loc, nodes)
    }

    /// An object (`ParseContext::Object`)
    pub fn object(&self, loc: SymbolSpan, node_type: NodeType, attrs: impl IntoNodeList) -> Node {
        self.object_ex(loc, node_type, attrs, true, false)
    }

    /// An object with explicit options
    pub fn object_ex(
        &self,
        mut loc: SymbolSpan,
        node_type: NodeType,
        attrs: impl IntoNodeList,
        null_if_empty: bool,
        shrink_location: bool,
    ) -> Node {
        let list = attrs.into_node_list(self);
        let (begin, n) = self.emit_children(list);
        if n == 0 && null_if_empty {
            return null();
        }
        if n > 0 && shrink_location {
            loc = self.shrunk_location(begin, n);
        }
        Node::new(&loc, node_type, AttributeKey::NONE, NO_PARENT, begin, n)
    }

    /// Materialize an expression (`ParseContext::Expression`)
    pub fn expression(&self, expr: impl Into<ExprVariant>) -> Node {
        match expr.into() {
            ExprVariant::Node(node) => node,
            ExprVariant::Nary(id) => {
                let nary = self.state.borrow().nary_expressions[id as usize];
                let args = self.array(nary.location, nary.args);
                self.object(
                    nary.location,
                    NodeType::OBJECT_SQL_NARY_EXPRESSION,
                    &[
                        super::actions::attr(AttributeKey::SQL_EXPRESSION_OPERATOR, nary.op_node),
                        super::actions::attr(AttributeKey::SQL_EXPRESSION_ARGS, args),
                    ],
                )
            }
        }
    }

    /// Flatten an AND / OR expression with nested expressions of the same operator (`TryMerge`)
    pub(crate) fn try_merge(&self, loc: SymbolSpan, op_node: Node, args: &[ExprVariant]) -> Option<ExprVariant> {
        if op_node.node_type() != NodeType::ENUM_SQL_EXPRESSION_OPERATOR {
            return None;
        }
        let op = ExpressionOperator(op_node.children_begin_or_value() as u8);
        if op != ExpressionOperator::AND && op != ExpressionOperator::OR {
            return None;
        }
        let nary_args = self.list(&[]);
        let id = {
            let mut state = self.state.borrow_mut();
            state.nary_expressions.push(NaryExpression {
                location: loc,
                op,
                op_node,
                args: nary_args,
            });
            state.nary_expressions.len() as u32 - 1
        };
        for &arg in args {
            match arg {
                ExprVariant::Node(node) => self.push_back(nary_args, node),
                ExprVariant::Nary(child_id) => {
                    let child = self.state.borrow().nary_expressions[child_id as usize];
                    if child.op != op {
                        let node = self.expression(arg);
                        self.push_back(nary_args, node);
                    } else {
                        self.append(nary_args, child.args);
                    }
                }
            }
        }
        Some(ExprVariant::Nary(id))
    }

    // -----------------------------------------------------------------------------------------
    // Names
    // -----------------------------------------------------------------------------------------

    /// A name from a keyword. The C++ core registers the symbol span as the name location.
    pub fn name_from_keyword(&self, loc: SymbolSpan, text: &str) -> Node {
        let id = self.state.borrow_mut().names.register(text, TextSpan::new(loc.offset(), loc.length()));
        Node::new(&loc, NodeType::NAME, AttributeKey::NONE, NO_PARENT, id, 0)
    }

    /// A name from a string literal. The C++ core trims double quotes, so single quotes are kept.
    pub fn name_from_string_literal(&self, loc: SymbolSpan) -> Node {
        let text = self.text_at(loc).trim_matches('"');
        let id = self.state.borrow_mut().names.register(text, TextSpan::new(loc.offset(), loc.length()));
        Node::new(&loc, NodeType::NAME, AttributeKey::NONE, NO_PARENT, id, 0)
    }

    /// Mark a trailing dot
    pub fn trailing_dot(&self, loc: SymbolSpan) -> Node {
        self.add_error(loc, "name has a trailing dot");
        Node::new(&loc, NodeType::OBJECT_EXT_TRAILING_DOT, AttributeKey::NONE, NO_PARENT, 0, 0)
    }

    // -----------------------------------------------------------------------------------------
    // Checks
    // -----------------------------------------------------------------------------------------

    /// Read the precision of a float type
    pub fn read_float_type(&self, bits_loc: SymbolSpan) -> NumericType {
        let text = self.text_at(bits_loc);
        let digits: &str = &text[..text.bytes().take_while(u8::is_ascii_digit).count()];
        let bits: i64 = digits.parse().unwrap_or(0);
        if bits < 1 {
            self.add_error(bits_loc, "precision for float type must be least 1 bit");
        } else if bits < 24 {
            return NumericType::FLOAT4;
        } else if bits < 53 {
            return NumericType::FLOAT8;
        } else {
            self.add_error(bits_loc, "precision for float type must be less than 54 bits");
        }
        NumericType::FLOAT4
    }

    /// Require punctuation tokens to be adjacent in the source text
    pub fn require_adjacent(&self, left: SymbolSpan, right: SymbolSpan, spelling: &str) {
        let l = self.resolve_text_span(left);
        let r = self.resolve_text_span(right);
        if l.end() != r.offset {
            self.add_error(super::actions::loc(&[left, right]), &format!("expected adjacent punctuation \"{spelling}\""));
        }
    }

    /// Require a generic operator token to use an exact spelling
    pub fn require_operator(&self, loc: SymbolSpan, spelling: &str) {
        if self.text_at(loc) != spelling {
            self.add_error(loc, &format!("expected operator \"{spelling}\""));
        }
    }

    // -----------------------------------------------------------------------------------------
    // Statements and errors
    // -----------------------------------------------------------------------------------------

    /// Add a statement
    pub fn add_statement(&self, node: Node) {
        if node.node_type() == NodeType::NONE {
            return;
        }
        let root = self.add_node(node);
        let mut state = self.state.borrow_mut();
        let statement_type = match node.node_type() {
            NodeType::OBJECT_EXT_SET => StatementType::SET,
            NodeType::OBJECT_SQL_CREATE_AS => StatementType::CREATE_TABLE_AS,
            NodeType::OBJECT_SQL_CREATE => StatementType::CREATE_TABLE,
            NodeType::OBJECT_SQL_VIEW => StatementType::CREATE_VIEW,
            NodeType::OBJECT_SQL_CREATE_FUNCTION => StatementType::CREATE_FUNCTION,
            NodeType::OBJECT_SQL_SELECT => select_statement_type(&state.nodes, node),
            NodeType::OBJECT_SQL_DROP_TABLE => StatementType::DROP_TABLE,
            NodeType::OBJECT_SQL_DROP_VIEW => StatementType::DROP_VIEW,
            NodeType::OBJECT_SQL_ATTACH_DATABASE => StatementType::ATTACH_DATABASE,
            NodeType::OBJECT_SQL_INSERT => StatementType::INSERT,
            NodeType::OBJECT_SQL_DELETE => StatementType::DELETE,
            NodeType::OBJECT_VIS_VISUALISE => StatementType::VIS_VISUALISE,
            NodeType::OBJECT_EXT_EXPLAIN => StatementType::EXPLAIN,
            other => panic!("unexpected statement root {:?}", other.variant_name()),
        };
        let nodes_len = state.nodes.len() as u32;
        let mut statement = state.current_statement;
        statement.root = root;
        statement.statement_type = statement_type;
        statement.node_count = nodes_len - statement.nodes_begin;
        state.statements.push(statement);
        state.current_statement = Statement {
            nodes_begin: nodes_len,
            ..Default::default()
        };
    }

    /// Drop the nodes of the current statement after an error
    pub fn reset_statement(&self) {
        let mut state = self.state.borrow_mut();
        state.current_statement.nodes_begin = state.nodes.len() as u32;
    }

    /// Mark the body of a vis spec
    pub fn mark_vis_spec_span(&self, loc: SymbolSpan) {
        self.state.borrow_mut().vis_spec_spans.push((loc.offset(), loc.offset() + loc.length()));
    }

    /// Add an error without a hint (`ParseContext::AddError`)
    pub fn add_error(&self, loc: SymbolSpan, message: &str) {
        self.state.borrow_mut().errors.push(ParseError {
            location: loc,
            message: message.to_string(),
            hint: String::new(),
        });
    }

    /// Report an error from the parser or an action (`Parser::error`), attaching the pending hint
    pub fn error(&self, loc: SymbolSpan, message: &str) {
        let mut state = self.state.borrow_mut();
        let hint = std::mem::take(&mut state.pending_hint);
        state.errors.push(ParseError {
            location: loc,
            message: message.to_string(),
            hint,
        });
    }

    /// Drop the lookahead after the action (`yyclearin`)
    pub fn clear_lookahead(&self) {
        self.state.borrow_mut().clear_lookahead = true;
    }
}

/// SELECT or SELECT INTO, following the inputs of set operations
fn select_statement_type(nodes: &[Node], root: Node) -> StatementType {
    let mut current = root;
    while current.node_type() == NodeType::OBJECT_SQL_SELECT {
        let mut next = None;
        let begin = current.children_begin_or_value() as usize;
        for child in &nodes[begin..begin + current.children_count() as usize] {
            if child.attribute_key() == AttributeKey::SQL_SELECT_INTO && child.node_type() != NodeType::NONE {
                return StatementType::SELECT_INTO;
            }
            if child.attribute_key() == AttributeKey::SQL_COMBINE_INPUT
                && child.node_type() == NodeType::ARRAY
                && child.children_count() > 0
            {
                next = Some(nodes[child.children_begin_or_value() as usize]);
            }
        }
        match next {
            Some(n) => current = n,
            None => break,
        }
    }
    StatementType::SELECT
}

/// Resolve a span of symbol indexes to a span of bytes (`ScannedScript::ResolveTextSpan`)
pub fn resolve_text_span(text: &str, symbols: &[Symbol], span: SymbolSpan) -> TextSpan {
    if span.length() == 0 {
        return match symbols.get(span.offset() as usize) {
            Some(symbol) => TextSpan::new(symbol.location.offset, 0),
            None => TextSpan::new(text.len() as u32, 0),
        };
    }
    let first = symbols[span.offset() as usize].location;
    let last = symbols[(span.offset() + span.length() - 1) as usize].location;
    TextSpan::new(first.offset, last.end() - first.offset)
}
