//! The SQL formatter, a port of the C++ `src/formatter`.
//!
//! The formatter visits the AST in post-order and builds a document for every node in a
//! [`FormattingProgram`], so the documents of the children always exist when a parent is visited.
//! Nodes that cannot be formatted are rendered as `'<NODE_TYPE>'` placeholders and recorded as
//! unformattable. The statements are then rendered with the comments of the script in between.
//!
//! The output was byte-identical to the C++ formatter, quirks included (docs/rust-port/quirks.md).
//! Function names follow the C++ methods (`FormatTableRef` is `format_table_ref`), the statement
//! formatters live in the submodules like in the C++ files `formatter_<kind>.cc`.

mod comments;
mod create;
mod delete;
mod explain;
mod insert;
mod pgq;
pub mod program;
mod select;
mod vis;

pub use program::*;

use dashql_parser::attrs;
use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode};
use dashql_buffers::parser::{
    AttributeKey, CharacterType, ColumnConstraint, ConstraintAttribute, ExpressionOperator, ExtractTarget,
    GroupByItemType, IntervalType, JoinType, KeyActionCommand, KeyActionTrigger, KeyMatch, KnownFunction, Node,
    NodeType, NumericType, OrderDirection, OrderNullRule, RowLockingBlockBehavior, RowLockingStrength, SampleCountUnit,
    SubqueryQuantifier, SymbolSpan, TableConstraint, TempType, TrimDirection, WindowBoundDirection, WindowBoundMode,
    WindowRangeMode,
};
use dashql_parser::parser::context::resolve_text_span;
use dashql_parser::parser::ParsedScript;
use dashql_parser::scanner::ScannedScript;
use dashql_parser::span::TextSpan;
use std::cell::{Cell, RefCell};

type K = AttributeKey;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FormattingAssociativity {
    Left,
    Right,
    #[default]
    NonAssoc,
}

use FormattingAssociativity as Associativity;

/// The formatting state of an AST node
#[derive(Clone, Copy, Debug, Default)]
pub struct FormattingNodeState {
    /// The operator precedence of an n-ary expression or its argument array, 0 if none
    pub precedence: usize,
    /// The operator associativity of an n-ary expression or its argument array
    pub associativity: FormattingAssociativity,
    /// Must the n-ary expression be parenthesized within its parent expression?
    pub needs_parentheses: bool,
    /// Is the node the root of a statement, or the statement of an EXPLAIN?
    pub is_statement_root: bool,
    /// The formatted document of the node
    pub reg: FmtReg,
}

fn get_operator_precedence(op: ExpressionOperator) -> (usize, Associativity) {
    use ExpressionOperator as O;
    match op {
        O::OR => (3, Associativity::Left),
        O::AND => (4, Associativity::Left),
        O::NOT => (5, Associativity::Right),
        O::IS_NULL
        | O::NOT_NULL
        | O::IS_TRUE
        | O::IS_FALSE
        | O::IS_UNKNOWN
        | O::IS_DISTINCT_FROM
        | O::IS_OF
        | O::IS_NOT_TRUE
        | O::IS_NOT_FALSE
        | O::IS_NOT_UNKNOWN
        | O::IS_NOT_DISTINCT_FROM
        | O::IS_NOT_OF
        | O::EQUAL
        | O::NOT_EQUAL
        | O::GREATER_EQUAL
        | O::GREATER_THAN
        | O::LESS_EQUAL
        | O::LESS_THAN => (6, Associativity::NonAssoc),
        O::BETWEEN_SYMMETRIC
        | O::BETWEEN_ASYMMETRIC
        | O::NOT_BETWEEN_SYMMETRIC
        | O::NOT_BETWEEN_ASYMMETRIC
        | O::IN
        | O::NOT_IN
        | O::GLOB
        | O::NOT_GLOB
        | O::LIKE
        | O::NOT_LIKE
        | O::ILIKE
        | O::NOT_ILIKE
        | O::SIMILAR_TO
        | O::NOT_SIMILAR_TO
        | O::OVERLAPS => (7, Associativity::NonAssoc),
        O::PLUS | O::MINUS => (12, Associativity::Left),
        O::MULTIPLY | O::DIVIDE | O::MODULUS => (13, Associativity::Left),
        O::XOR => (14, Associativity::Left),
        O::AT_TIMEZONE => (15, Associativity::Left),
        O::COLLATE => (16, Associativity::Left),
        O::NEGATE => (17, Associativity::Right),
        O::TYPECAST => (20, Associativity::Left),
        // DEFAULT (the C++ switch has no case for values outside the enum)
        _ => (0, Associativity::NonAssoc),
    }
}

/// Break before AND and OR, after every other operator
fn breaks_before_operator(op: ExpressionOperator) -> bool {
    matches!(op, ExpressionOperator::OR | ExpressionOperator::AND)
}

fn get_operator_text(op: ExpressionOperator) -> &'static str {
    use ExpressionOperator as O;
    match op {
        O::NEGATE => "-",
        O::NOT => "not",
        O::PLUS => "+",
        O::MINUS => "-",
        O::MULTIPLY => "*",
        O::DIVIDE => "/",
        O::MODULUS => "%",
        O::AND => "and",
        O::OR => "or",
        O::XOR => "#",
        O::EQUAL => "=",
        O::NOT_EQUAL => "<>",
        O::LESS_THAN => "<",
        O::GREATER_THAN => ">",
        O::LESS_EQUAL => "<=",
        O::GREATER_EQUAL => ">=",
        O::LIKE => "like",
        O::NOT_LIKE => "not like",
        O::ILIKE => "ilike",
        O::NOT_ILIKE => "not ilike",
        O::SIMILAR_TO => "similar to",
        O::NOT_SIMILAR_TO => "not similar to",
        O::OVERLAPS => "overlaps",
        O::GLOB => "glob",
        O::NOT_GLOB => "not glob",
        O::IS_NULL => "is null",
        O::NOT_NULL => "is not null",
        O::IS_TRUE => "is true",
        O::IS_FALSE => "is false",
        O::IS_UNKNOWN => "is unknown",
        O::IS_NOT_TRUE => "is not true",
        O::IS_NOT_FALSE => "is not false",
        O::IS_NOT_UNKNOWN => "is not unknown",
        O::IS_DISTINCT_FROM => "is distinct from",
        O::IS_NOT_DISTINCT_FROM => "is not distinct from",
        O::IN => "in",
        O::NOT_IN => "not in",
        O::BETWEEN_ASYMMETRIC => "between",
        O::BETWEEN_SYMMETRIC => "between symmetric",
        O::NOT_BETWEEN_ASYMMETRIC => "not between",
        O::NOT_BETWEEN_SYMMETRIC => "not between symmetric",
        O::COLLATE => "collate",
        O::AT_TIMEZONE => "at time zone",
        O::DEFAULT => "default",
        _ => "",
    }
}

fn get_known_function_text(function: KnownFunction) -> &'static str {
    use KnownFunction as F;
    match function {
        F::COLLATION_FOR => "collation for",
        F::CURRENT_DATE => "current_date",
        F::CURRENT_TIME => "current_time",
        F::CURRENT_TIMESTAMP => "current_timestamp",
        F::LOCALTIME => "localtime",
        F::LOCALTIMESTAMP => "localtimestamp",
        F::CURRENT_ROLE => "current_role",
        F::CURRENT_USER => "current_user",
        F::SESSION_USER => "session_user",
        F::USER => "user",
        F::CURRENT_CATALOG => "current_catalog",
        F::CURRENT_SCHEMA => "current_schema",
        F::CAST => "cast",
        F::EXTRACT => "extract",
        F::OVERLAY => "overlay",
        F::POSITION => "position",
        F::SUBSTRING => "substring",
        F::TREAT => "treat",
        F::TRIM => "trim",
        F::NULLIF => "nullif",
        F::COALESCE => "coalesce",
        _ => "",
    }
}

/// The value of an enum node
fn value_u8(node: &Node) -> u8 {
    node.children_begin_or_value() as u8
}

/// Is the node a true BOOL?
fn is_true(node: Option<&Node>) -> bool {
    node.is_some_and(|n| n.node_type() == NodeType::BOOL && n.children_begin_or_value() != 0)
}

/// A part of the formatted script
#[derive(Clone, Copy, Debug)]
enum OutputPart {
    /// A parsed statement without errors, the index in the statements of the parsed script
    Statement(usize),
    /// A statement with syntax errors, the text span that is copied as written
    Damaged(TextSpan),
}

/// The SQL formatter
pub struct Formatter<'a> {
    /// The scanned script
    scanned: &'a ScannedScript,
    /// Emit executable literals instead of obfuscated literal markers?
    replace_obfuscated_literals: bool,
    /// The parsed script
    parsed: &'a ParsedScript,
    /// The AST nodes of the parsed script
    ast: &'a [Node],
    /// The formatting config of the current run
    config: FormattingConfigT,
    /// The document arena that holds the formatted nodes
    fmt: FormattingProgram<'a>,
    /// The formatting states, indexed by AST node id
    node_states: Vec<FormattingNodeState>,
    /// The ids of the nodes that were rendered as placeholders
    unformattable_nodes: RefCell<Vec<u32>>,
    /// Was a part of the script with syntax errors copied as written?
    copied_damaged_text: Cell<bool>,
}

impl<'a> Formatter<'a> {
    pub fn new(parsed: &'a ParsedScript) -> Self {
        let mut formatter = Self {
            scanned: &parsed.scanned,
            replace_obfuscated_literals: false,
            parsed,
            ast: &parsed.nodes,
            config: FormattingConfigT::default(),
            fmt: FormattingProgram::new(),
            node_states: vec![FormattingNodeState::default(); parsed.nodes.len()],
            unformattable_nodes: RefCell::new(Vec::new()),
            copied_damaged_text: Cell::new(false),
        };
        formatter.mark_statement_roots();
        formatter
    }

    /// Emit executable literals instead of the obfuscated literal markers of Hyper
    pub fn replace_obfuscated_literals(&mut self) {
        self.replace_obfuscated_literals = true;
    }

    pub fn estimate_formatted_size(&self) -> usize {
        self.scanned.text.len() + 64
    }

    /// The nodes that could not be formatted by the last call of `format` or `format_node_at`
    pub fn unformattable_nodes(&self) -> Vec<u32> {
        self.unformattable_nodes.borrow().clone()
    }

    /// Was everything formatted? Parts with syntax errors are copied as written and nodes that cannot be
    /// formatted are rendered as placeholders.
    pub fn is_fully_formatted(&self) -> bool {
        self.unformattable_nodes.borrow().is_empty() && !self.copied_damaged_text.get()
    }

    /// Format the script
    pub fn format(&mut self, config: &FormattingConfigT) -> String {
        bytes_to_string(self.format_bytes(config))
    }

    /// Format the script, the output may contain partial UTF-8 sequences where comments were wrapped
    pub fn format_bytes(&mut self, config: &FormattingConfigT) -> Vec<u8> {
        self.prepare(config);
        self.mark_statement_roots();
        self.prepare_precedence();
        for i in 0..self.ast.len() {
            self.identify_parentheses(self.ast.len() - 1 - i);
        }
        self.build_docs();
        self.write_output()
    }

    /// Format a single node (without the statement roots that only `format` marks)
    pub fn format_node_at(&mut self, node_id: usize, config: &FormattingConfigT) -> String {
        if node_id >= self.ast.len() {
            return String::new();
        }
        self.prepare(config);
        self.prepare_precedence();
        for i in 0..self.ast.len() {
            self.identify_parentheses(self.ast.len() - 1 - i);
        }
        self.build_docs();
        self.render(self.node_states[node_id].reg)
    }

    fn prepare(&mut self, config: &FormattingConfigT) {
        self.config = config.clone();
        self.fmt.reset();
        self.fmt.set_config(config);
        self.node_states.clear();
        self.node_states.resize(self.ast.len(), FormattingNodeState::default());
        self.unformattable_nodes.borrow_mut().clear();
        self.copied_damaged_text.set(false);
    }

    fn mark_statement_roots(&mut self) {
        for statement in &self.parsed.statements {
            if (statement.root as usize) < self.node_states.len() {
                self.node_states[statement.root as usize].is_statement_root = true;
                self.mark_explain_inner_statement_root(statement.root as usize);
            }
        }
    }

    fn mark_explain_inner_statement_root(&mut self, root_id: usize) {
        let root_node = &self.ast[root_id];
        if root_node.node_type() != NodeType::OBJECT_EXT_EXPLAIN {
            return;
        }
        if let Some(child) = self.children(root_node).iter().find(|c| c.attribute_key() == K::EXT_EXPLAIN_STATEMENT) {
            let inner_id = self.node_id(child);
            if inner_id < self.node_states.len() {
                self.node_states[inner_id].is_statement_root = true;
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // AST access
    // -----------------------------------------------------------------------------------------

    /// The id of a node of the AST
    fn node_id(&self, node: &Node) -> usize {
        (node as *const Node as usize - self.ast.as_ptr() as usize) / std::mem::size_of::<Node>()
    }

    fn state(&self, node: &Node) -> &FormattingNodeState {
        &self.node_states[self.node_id(node)]
    }

    /// The document of a node
    fn reg(&self, node: &Node) -> FmtReg {
        self.state(node).reg
    }

    /// The children of a node (`ast.subspan(children_begin_or_value, children_count)`)
    fn children(&self, node: &Node) -> &'a [Node] {
        let count = node.children_count() as usize;
        if count == 0 {
            return &[];
        }
        let begin = node.children_begin_or_value() as usize;
        &self.ast[begin..begin + count]
    }

    /// The documents of the elements of an array (`GetArrayStates`)
    fn array_regs(&self, node: &Node) -> Vec<FmtReg> {
        let count = node.children_count() as usize;
        if count == 0 {
            return Vec::new();
        }
        let begin = node.children_begin_or_value() as usize;
        self.node_states[begin..begin + count].iter().map(|s| s.reg).collect()
    }

    /// Look up attributes of an object (`GetAttributes`, `utils/ast_attributes.h`).
    ///
    /// Like the C++ lookup, a single key finds the first child with that key, several keys find
    /// the last child with each key.
    fn attrs<const N: usize>(&self, node: &Node, keys: [AttributeKey; N]) -> [Option<&'a Node>; N] {
        let mut out = [None; N];
        for child in self.children(node) {
            for (slot, key) in out.iter_mut().zip(keys.iter()) {
                if child.attribute_key() == *key {
                    *slot = Some(child);
                    if N == 1 {
                        return out;
                    }
                }
            }
        }
        out
    }

    /// The text of a symbol span
    fn text_at(&self, span: &SymbolSpan) -> &'a str {
        let text: &'a str = &self.scanned.text;
        let ts = resolve_text_span(text, &self.scanned.symbols, *span);
        let begin = (ts.offset as usize).min(text.len());
        let end = (begin + ts.length as usize).min(text.len());
        &text[begin..end]
    }

    fn is_pretty(&self) -> bool {
        self.config.mode == FormattingMode::PRETTY
    }

    /// ForceBreak in pretty mode, `otherwise` in the other modes
    fn pretty_policy(&self, otherwise: FormattingJoinPolicy) -> FormattingJoinPolicy {
        if self.is_pretty() {
            FormattingJoinPolicy::ForceBreak
        } else {
            otherwise
        }
    }

    // -----------------------------------------------------------------------------------------
    // Precedence
    // -----------------------------------------------------------------------------------------

    fn prepare_precedence(&mut self) {
        for i in 0..self.ast.len() {
            let node = &self.ast[i];
            if node.node_type() != NodeType::OBJECT_SQL_NARY_EXPRESSION {
                continue;
            }
            let [op_node, args_node] = attrs!(self.children(node), [K::SQL_EXPRESSION_OPERATOR, K::SQL_EXPRESSION_ARGS]);
            let Some(op_node) = op_node else { continue };

            let (precedence, associativity) = if op_node.node_type() == NodeType::ENUM_SQL_EXPRESSION_OPERATOR {
                get_operator_precedence(ExpressionOperator(value_u8(op_node)))
            } else if matches!(op_node.node_type(), NodeType::OPERATOR | NodeType::ARRAY) {
                (11, Associativity::Left)
            } else {
                continue;
            };
            let state = &mut self.node_states[i];
            state.precedence = precedence;
            state.associativity = associativity;
            if let Some(args_node) = args_node {
                let args_id = self.node_id(args_node);
                let args_state = &mut self.node_states[args_id];
                args_state.precedence = precedence;
                args_state.associativity = associativity;
            }
        }
    }

    fn identify_parentheses(&mut self, node_id: usize) {
        let node = &self.ast[node_id];
        if node.node_type() != NodeType::OBJECT_SQL_NARY_EXPRESSION {
            return;
        }
        let parent_id = node.parent() as usize;
        if parent_id >= self.ast.len() {
            return;
        }
        let parent = &self.ast[parent_id];
        if parent.node_type() != NodeType::ARRAY {
            return;
        }
        let args_begin = parent.children_begin_or_value() as usize;
        let args_count = parent.children_count() as usize;
        if node_id < args_begin || node_id >= args_begin + args_count {
            return;
        }

        let arg_index = node_id - args_begin;
        let parent_state = self.node_states[parent_id];
        let state = &mut self.node_states[node_id];
        let need_parens = if args_count == 1 {
            true
        } else {
            let left_or_none = matches!(parent_state.associativity, Associativity::Left | Associativity::NonAssoc);
            let right_or_none = matches!(parent_state.associativity, Associativity::Right | Associativity::NonAssoc);
            state.precedence < parent_state.precedence
                || (state.precedence == parent_state.precedence
                    && ((arg_index == 0 && right_or_none)
                        || (arg_index == args_count - 1 && left_or_none)
                        || (arg_index > 0 && arg_index + 1 < args_count)))
        };
        state.needs_parentheses = need_parens;
    }

    // -----------------------------------------------------------------------------------------
    // Leaves and lists
    // -----------------------------------------------------------------------------------------

    fn format_leaf(&self, node: &'a Node) -> FmtReg {
        let text = self.text_at(node.symbol_span());
        if self.replace_obfuscated_literals {
            let text_offset = resolve_text_span(&self.scanned.text, &self.scanned.symbols, *node.symbol_span()).offset;
            if let Some(literal) = self.find_obfuscated_literal(text_offset) {
                return self.fmt.verbatim(&literal.replacement);
            }
        }
        if matches!(node.node_type(), NodeType::BOOL | NodeType::LITERAL_NULL | NodeType::OPERATOR) {
            return self.fmt.text(text);
        }
        self.fmt.verbatim(text)
    }

    /// The obfuscated literal whose marker starts at a text offset (`FindObfuscatedLiteral`)
    fn find_obfuscated_literal(&self, offset: u32) -> Option<&'a dashql_parser::scanner::ObfuscatedLiteral> {
        let literals: &'a [dashql_parser::scanner::ObfuscatedLiteral] = &self.scanned.obfuscated_literals;
        let i = literals.partition_point(|l| l.location.offset < offset);
        literals.get(i).filter(|l| l.location.offset == offset)
    }

    fn format_unimplemented(&self, node: &Node) -> FmtReg {
        self.unformattable_nodes.borrow_mut().push(self.node_id(node) as u32);
        let type_name = node.node_type().variant_name().unwrap_or("");
        let f = &self.fmt;
        f.concat(&[f.text("'<"), f.verbatim(type_name), f.text(">'")])
    }

    /// Format a node or record the child as unformattable (`reg_or_placeholder`)
    fn reg_or_placeholder(&self, child: &Node) -> FmtReg {
        let reg = self.reg(child);
        if reg == 0 {
            return self.format_unimplemented(child);
        }
        reg
    }

    fn comma_separators(&self) -> (FmtReg, FmtReg) {
        let f = &self.fmt;
        let inline_separator = f.text(", ");
        let break_separator = f.concat(&[f.text(","), f.break_()]);
        (inline_separator, break_separator)
    }

    fn format_comma_list(&self, node: &Node, indent_after_breaks: bool) -> FmtReg {
        let parts = self.array_regs(node);
        let (inline_separator, break_separator) = self.comma_separators();
        self.fmt.join(&parts, inline_separator, break_separator, None, indent_after_breaks)
    }

    /// A comma-separated join that breaks on overflow
    fn comma_join_on_overflow(&self, items: &[FmtReg], indent_after_breaks: bool) -> FmtReg {
        let (inline_separator, break_separator) = self.comma_separators();
        self.fmt.join(
            items,
            inline_separator,
            break_separator,
            Some(FormattingJoinPolicy::BreakOnOverflow),
            indent_after_breaks,
        )
    }

    /// A space-separated join
    fn space_join(&self, items: &[FmtReg], policy: FormattingJoinPolicy, indent_after_breaks: bool) -> FmtReg {
        let f = &self.fmt;
        f.join(items, f.text(" "), f.break_(), Some(policy), indent_after_breaks)
    }

    fn format_qualified_name(&self, node: &Node) -> FmtReg {
        let f = &self.fmt;
        // An index like `a[1]` follows its name without a dot
        let mut parts: Vec<FmtReg> = Vec::new();
        for (child, reg) in self.children(node).iter().zip(self.array_regs(node)) {
            match parts.pop() {
                Some(previous) if child.node_type() == NodeType::OBJECT_SQL_INDIRECTION_INDEX => {
                    parts.push(f.concat(&[previous, reg]))
                }
                Some(previous) => {
                    parts.push(previous);
                    parts.push(reg);
                }
                None => parts.push(reg),
            }
        }
        if parts.is_empty() {
            return self.fmt.empty();
        }
        let inline_separator = f.text(".");
        let break_separator = f.concat(&[f.break_(), f.text(".")]);
        f.join(&parts, inline_separator, break_separator, None, true)
    }

    fn format_array(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        if node.attribute_key() == K::NONE {
            let parent_id = node.parent() as usize;
            let parent = self.ast.get(parent_id);
            let parent_key = parent.map(|p| p.attribute_key());
            if parent_key == Some(K::SQL_SELECT_VALUES) {
                return f.parenthesized(self.format_comma_list(node, true));
            }
            if parent_key == Some(K::SQL_EXPRESSION_ARGS) {
                return self.format_comma_list(node, true);
            }
            if parent_key == Some(K::SQL_ROW_LOCKING_OF) {
                return self.format_qualified_name(node);
            }
            if parent_key == Some(K::SQL_GRAPH_MATCH_PATTERNS) {
                let parts = self.array_regs(node);
                return f.join(&parts, f.empty(), f.break_(), Some(FormattingJoinPolicy::BreakOnOverflow), true);
            }
            if parent.is_some_and(|p| p.node_type() == NodeType::OBJECT_SQL_NARY_EXPRESSION) {
                return self.format_comma_list(node, true);
            }
        }

        match node.attribute_key() {
            K::SQL_SELECT_TARGETS
            | K::SQL_SELECT_FROM
            | K::SQL_SELECT_GROUPS
            | K::SQL_SELECT_ORDER
            | K::SQL_WINDOW_FRAME_PARTITION
            | K::SQL_WINDOW_FRAME_ORDER
            | K::SQL_FUNCTION_WITHIN_GROUP
            | K::SQL_FUNCTION_ARGUMENTS
            | K::SQL_FUNCTION_ORDER
            | K::SQL_EXPRESSION_ARGS
            | K::SQL_DESCRIPTOR_COLUMNS
            | K::SQL_ROW_TYPE_FIELDS
            | K::SQL_CASE_CLAUSES
            | K::SQL_CREATE_TABLE_ELEMENTS
            | K::SQL_CREATE_AS_COLUMNS
            | K::SQL_VIEW_COLUMNS
            | K::SQL_CREATE_FUNCTION_PARAMS
            | K::SQL_SELECT_WINDOWS
            | K::SQL_SELECT_ROW_LOCKING
            | K::SQL_ROW_LOCKING_OF
            | K::SQL_GROUP_BY_ITEM_ARG
            | K::SQL_NUMERIC_TYPE_MODIFIERS
            | K::SQL_GENERIC_TYPE_MODIFIERS
            | K::SQL_TYPENAME_ARRAY
            | K::SQL_ATTACH_DATABASE_OPTIONS
            | K::SQL_INSERT_COLUMNS
            | K::SQL_INSERT_RETURNING
            | K::SQL_DELETE_USING
            | K::SQL_DELETE_RETURNING
            | K::SQL_CTE_COLUMNS
            | K::SQL_GRAPH_ELEMENT_TABLE_LABELS
            | K::SQL_GRAPH_MATCH_PATTERNS
            | K::SQL_RESULT_TARGET_EXCLUDE
            | K::SQL_TYPETEST_TYPES
            | K::SQL_FUNCTION_TABLE_ROWS_FROM
            | K::SQL_COLUMN_DEF_OPTIONS
            | K::SQL_CONST_CAST_FUNC_ARGS_LIST
            | K::SQL_ROWSFROM_ITEM_COLUMNS
            | K::SQL_TABLE_CONSTRAINT_DEFINITION
            | K::SQL_COLUMN_CONSTRAINT_DEFINITION => self.format_comma_list(node, true),
            K::SQL_PROPERTY_GRAPH_VERTEX_TABLES
            | K::SQL_PROPERTY_GRAPH_EDGE_TABLES
            | K::SQL_GRAPH_ELEMENT_TABLE_KEY
            | K::SQL_GRAPH_VERTEX_REFERENCE_KEY
            | K::SQL_GRAPH_VERTEX_REFERENCE_COLUMNS
            | K::SQL_GRAPH_PROPERTIES_COLUMNS
            | K::SQL_GRAPH_PROPERTIES_EXCLUDE
            | K::SQL_GRAPH_TABLE_COLUMNS => self.format_comma_list(node, false),
            K::SQL_SUBQUERY_OPERATOR | K::SQL_DEFINITION_ARG_VALUE | K::SQL_EXPRESSION_OPERATOR => {
                self.format_operator_path(node)
            }
            K::SQL_TABLE_CONSTRAINT_ATTRIBUTES | K::SQL_COLUMN_DEF_CONSTRAINTS => self.format_space_list(node),
            K::EXT_EXPLAIN_OPTIONS => self.format_comma_list(node, false),
            K::EXT_EXPLAIN_EXPRESSIONS => {
                let parts = self.array_regs(node);
                let (inline_separator, break_separator) = self.comma_separators();
                f.join(&parts, inline_separator, break_separator, Some(FormattingJoinPolicy::ForceBreak), false)
            }
            K::EXT_VARARG_FIELD_VALUE | K::SQL_GENERIC_OPTION_VALUE => {
                f.parenthesized(self.format_comma_list(node, true))
            }
            K::SQL_INDIRECTION_PATH | K::SQL_SELECT_EXPRESSION_INDIRECTION => self.format_indirection_path(node),
            K::SQL_ROW_EXPRESSION_VALUES => {
                let values = self.array_regs(node);
                if values.iter().any(|&v| v == 0) {
                    return self.format_unimplemented(node);
                }
                self.comma_join_on_overflow(&values, true)
            }
            K::SQL_WINDOW_FRAME_BOUNDS => {
                let bounds = self.array_regs(node);
                if bounds.len() == 1 && bounds[0] != 0 {
                    return bounds[0];
                }
                if bounds.len() == 2 && bounds[0] != 0 && bounds[1] != 0 {
                    return f.concat(&[f.text("between "), bounds[0], f.text(" and "), bounds[1]]);
                }
                self.format_unimplemented(node)
            }
            K::SQL_SELECT_VALUES => {
                let rows = self.array_regs(node);
                if rows.iter().any(|&r| r == 0) {
                    return self.format_unimplemented(node);
                }
                let policy = self.pretty_policy(FormattingJoinPolicy::BreakOnOverflow);
                let indent_after_breaks = !self.is_pretty();
                let (inline_separator, break_separator) = self.comma_separators();
                f.join(&rows, inline_separator, break_separator, Some(policy), indent_after_breaks)
            }
            K::SQL_TEMP_NAME
            | K::SQL_CREATE_TABLE_NAME
            | K::SQL_FUNCTION_NAME
            | K::SQL_CONST_CAST_FUNC_NAME
            | K::SQL_COLUMN_CONSTRAINT_COLLATE
            | K::SQL_TABLEREF_NAME
            | K::SQL_PARAMETER_NAME
            | K::SQL_TABLE_CONSTRAINT_REFERENCES_NAME
            | K::SQL_COLUMN_REF_PATH
            | K::SQL_COLUMN_DEF_COLLATE
            | K::SQL_CREATE_AS_NAME
            | K::SQL_VIEW_NAME
            | K::SQL_CREATE_FUNCTION_NAME
            | K::SQL_DROP_NAME
            | K::EXT_VARARG_FIELD_KEY
            | K::SQL_GRAPH_TABLE_GRAPH => self.format_qualified_name(node),
            K::SQL_SELECT_DISTINCT
            | K::SQL_SELECT_WITH_CTES
            | K::SQL_COMBINE_INPUT
            | K::SQL_JOIN_INPUT
            | K::SQL_TABLE_CONSTRAINT_COLUMNS
            | K::SQL_TABLE_CONSTRAINT_REFERENCES_COLUMNS
            | K::SQL_JOIN_USING
            | K::SQL_FUNCTION_TRIM_INPUT
            | K::SQL_ALIAS_COLUMN_NAMES
            | K::SQL_ALIAS_COLUMN_DEFS
            | K::EXT_VARARG_ARRAY_VALUES => self.format_comma_list(node, true),
            _ => self.format_unimplemented(node),
        }
    }

    // -----------------------------------------------------------------------------------------
    // Table references
    // -----------------------------------------------------------------------------------------

    fn format_table_ref(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, alias, table, lateral, sample, only] = attrs!(self.children(node), [
                K::SQL_TABLEREF_NAME,
                K::SQL_TABLEREF_ALIAS,
                K::SQL_TABLEREF_TABLE,
                K::SQL_TABLEREF_LATERAL,
                K::SQL_TABLEREF_SAMPLE,
                K::SQL_TABLEREF_ONLY,
            ],
        );

        let mut base_reg = 0;
        if let Some(table) = table {
            base_reg = self.reg(table);
            if table.node_type() == NodeType::OBJECT_SQL_SELECT {
                base_reg = f.parenthesized(base_reg);
            }
        } else if let Some(name) = name {
            base_reg = self.reg(name);
        }
        if base_reg == 0 {
            return self.format_unimplemented(node);
        }
        if is_true(only) {
            base_reg = f.concat(&[f.text("only "), base_reg]);
        }
        if is_true(lateral) {
            base_reg = f.concat(&[f.text("lateral "), base_reg]);
        }
        if let Some(alias) = alias {
            let alias_reg = self.reg(alias);
            if alias_reg == 0 {
                return self.format_unimplemented(node);
            }
            base_reg = f.concat(&[base_reg, f.text(" "), alias_reg]);
        }
        if let Some(sample) = sample {
            let sample_reg = self.reg(sample);
            if sample_reg == 0 {
                return self.format_unimplemented(node);
            }
            base_reg = f.concat(&[base_reg, f.text(" "), sample_reg]);
        }
        base_reg
    }

    fn format_into(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [temp, name] = attrs!(self.children(node), [K::SQL_TEMP_TYPE, K::SQL_TEMP_NAME]);
        let Some(name) = name else { return self.format_unimplemented(node) };
        let mut parts = vec![f.text("into ")];
        if let Some(temp) = temp {
            if TempType(value_u8(temp)) != TempType::NONE {
                parts.push(self.reg(temp));
                parts.push(f.text(" "));
            }
        }
        parts.push(self.reg(name));
        f.concat(&parts)
    }

    fn format_window_def(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, frame] = attrs!(self.children(node), [K::SQL_WINDOW_DEF_NAME, K::SQL_WINDOW_DEF_FRAME]);
        let (Some(name), Some(frame)) = (name, frame) else { return self.format_unimplemented(node) };
        // An empty window specification is still a pair of parentheses
        let frame_reg = self.reg(frame);
        let frame_reg = if frame_reg == 0 { f.text("()") } else { f.parenthesized(frame_reg) };
        f.concat(&[self.reg(name), f.text(" as "), frame_reg])
    }

    fn format_row_locking_strength(&self, node: &'a Node) -> FmtReg {
        let text = match RowLockingStrength(value_u8(node)) {
            RowLockingStrength::UPDATE => "for update",
            RowLockingStrength::NO_KEY_UPDATE => "for no key update",
            RowLockingStrength::SHARE => "for share",
            RowLockingStrength::KEY_SHARE => "for key share",
            RowLockingStrength::READ_ONLY => "for read only",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_row_locking_block_behavior(&self, node: &'a Node) -> FmtReg {
        let text = match RowLockingBlockBehavior(value_u8(node)) {
            RowLockingBlockBehavior::NOWAIT => "nowait",
            RowLockingBlockBehavior::SKIP_LOCKED => "skip locked",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_row_locking(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [strength, of, behavior] =
            attrs!(self.children(node), [K::SQL_ROW_LOCKING_STRENGTH, K::SQL_ROW_LOCKING_OF, K::SQL_ROW_LOCKING_BLOCK_BEHAVIOR]);
        let Some(strength) = strength else { return self.format_unimplemented(node) };
        let mut parts = vec![self.reg(strength)];
        if let Some(of) = of.filter(|of| of.children_count() > 0) {
            parts.push(f.text(" of "));
            parts.push(self.reg(of));
        }
        if let Some(behavior) = behavior {
            parts.push(f.text(" "));
            parts.push(self.reg(behavior));
        }
        f.concat(&parts)
    }

    fn format_sample_unit(&self, node: &'a Node) -> FmtReg {
        let text = match SampleCountUnit(value_u8(node)) {
            SampleCountUnit::PERCENT => "%",
            SampleCountUnit::ROWS => " rows",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_sample(&self, node: &'a Node, table_sample: bool) -> FmtReg {
        let f = &self.fmt;
        let [value, unit, function, repeat, seed] = attrs!(self.children(node), [
                K::SQL_SAMPLE_COUNT_VALUE,
                K::SQL_SAMPLE_COUNT_UNIT,
                K::SQL_SAMPLE_FUNCTION,
                K::SQL_SAMPLE_REPEAT,
                K::SQL_SAMPLE_SEED,
            ],
        );
        let (Some(value), Some(unit)) = (value, unit) else { return self.format_unimplemented(node) };

        // Hyper only knows the word PERCENT for a table sample, DuckDB's `using sample` also takes `%`
        let is_percent = unit.node_type() == NodeType::ENUM_SQL_SAMPLE_UNIT_TYPE
            && SampleCountUnit(value_u8(unit)) == SampleCountUnit::PERCENT;
        let unit_reg = if table_sample && is_percent { f.text(" percent") } else { self.reg(unit) };
        let count = f.concat(&[self.reg(value), unit_reg]);
        let mut body = count;
        match (function, seed) {
            (Some(function), Some(seed)) => {
                let args = f.concat(&[self.reg(function), f.text(", "), self.reg(seed)]);
                body = f.concat(&[count, f.text(" "), f.parenthesized(args)]);
            }
            (Some(function), None) => body = f.concat(&[self.reg(function), f.parenthesized(count)]),
            _ => {}
        }
        if let Some(repeat) = repeat {
            body = f.concat(&[body, f.text(" repeatable "), f.parenthesized(self.reg(repeat))]);
        }
        f.concat(&[f.text(if table_sample { "tablesample " } else { "using sample " }), body])
    }

    fn format_joined_table(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [inputs, join_type, join_on, join_using] =
            attrs!(self.children(node), [K::SQL_JOIN_INPUT, K::SQL_JOIN_TYPE, K::SQL_JOIN_ON, K::SQL_JOIN_USING]);
        let (Some(inputs), Some(join_type)) = (inputs, join_type) else { return self.format_unimplemented(node) };
        if inputs.node_type() != NodeType::ARRAY || inputs.children_count() != 2 {
            return self.format_unimplemented(node);
        }

        let left_reg = self.reg(&self.ast[inputs.children_begin_or_value() as usize]);
        let right_reg = self.reg(&self.ast[inputs.children_begin_or_value() as usize + 1]);
        if left_reg == 0 || right_reg == 0 {
            return self.format_unimplemented(node);
        }

        let join_text = match JoinType(value_u8(join_type)) {
            JoinType::NONE => "cross join",
            JoinType::INNER => "join",
            JoinType::LEFT | JoinType::OUTER_LEFT => "left join",
            JoinType::RIGHT | JoinType::OUTER_RIGHT => "right join",
            JoinType::FULL | JoinType::OUTER_FULL => "full join",
            JoinType::SEMI => "semi join",
            JoinType::ANTI => "anti join",
            JoinType::NATURAL_INNER => "natural join",
            JoinType::NATURAL_LEFT | JoinType::NATURAL_OUTER_LEFT => "natural left join",
            JoinType::NATURAL_RIGHT | JoinType::NATURAL_OUTER_RIGHT => "natural right join",
            JoinType::NATURAL_FULL | JoinType::NATURAL_OUTER_FULL => "natural full join",
            _ => return self.format_unimplemented(node),
        };

        let mut join_clause_parts = vec![f.concat(&[f.text(join_text), f.text(" "), right_reg])];
        if let Some(join_on) = join_on {
            let on_reg = self.reg(join_on);
            if on_reg == 0 {
                return self.format_unimplemented(node);
            }
            join_clause_parts.push(f.concat(&[f.text("on "), on_reg]));
        } else if let Some(join_using) = join_using {
            let using_reg = self.reg(join_using);
            if using_reg == 0 {
                return self.format_unimplemented(node);
            }
            join_clause_parts.push(f.concat(&[f.text("using "), f.parenthesized(using_reg)]));
        }
        let join_clause = self.space_join(&join_clause_parts, FormattingJoinPolicy::BreakOnOverflow, true);

        let clause_policy = self.pretty_policy(FormattingJoinPolicy::BreakAllOrNone);
        let mut is_left_nested_join = false;
        let table_ref_id = node.parent() as usize;
        if table_ref_id < self.ast.len() {
            let parent_id = self.ast[table_ref_id].parent() as usize;
            is_left_nested_join = parent_id < self.ast.len()
                && self.ast[parent_id].node_type() == NodeType::ARRAY
                && self.ast[parent_id].attribute_key() == K::SQL_JOIN_INPUT
                && table_ref_id == self.ast[parent_id].children_begin_or_value() as usize;
        }
        self.space_join(&[left_reg, join_clause], clause_policy, !is_left_nested_join)
    }

    fn format_group_by_item(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [item_type, arg] = attrs!(self.children(node), [K::SQL_GROUP_BY_ITEM_TYPE, K::SQL_GROUP_BY_ITEM_ARG]);
        let Some(item_type) = item_type.filter(|t| t.node_type() == NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE) else {
            return f.empty();
        };
        let arg_reg = match arg {
            Some(arg) if arg.node_type() != NodeType::NONE => self.reg(arg),
            _ => 0,
        };
        let wrap = |keyword: &'static str| {
            if arg_reg == 0 {
                return f.empty();
            }
            f.concat(&[f.text(keyword), f.parenthesized(arg_reg)])
        };
        match GroupByItemType(value_u8(item_type)) {
            GroupByItemType::EXPRESSION => arg_reg,
            GroupByItemType::EMPTY => f.text("()"),
            GroupByItemType::CUBE => wrap("cube"),
            GroupByItemType::ROLLUP => wrap("rollup"),
            GroupByItemType::GROUPING_SETS => wrap("grouping sets"),
            _ => f.empty(),
        }
    }

    // -----------------------------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------------------------

    fn format_type_name(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [type_node, array, setof] =
            attrs!(self.children(node), [K::SQL_TYPENAME_TYPE, K::SQL_TYPENAME_ARRAY, K::SQL_TYPENAME_SETOF]);
        let Some(type_node) = type_node else { return self.format_unimplemented(node) };

        let mut type_reg = self.reg(type_node);
        if let Some(array) = array.filter(|a| a.node_type() == NodeType::ARRAY) {
            // Hyper does not accept row(...)[], only array(row(...))
            let row_element = type_node.node_type() == NodeType::OBJECT_SQL_ROW_TYPE;
            // The keyword form `text array` has no children, a type without array has no text
            let keyword_form = array.children_count() == 0 && array.symbol_span().length() > 0;
            let bounds: Vec<Option<&Node>> =
                if keyword_form { vec![None] } else { self.children(array).iter().map(Some).collect() };
            for bound in bounds {
                let unbounded = bound.map_or(true, |b| b.node_type() == NodeType::BOOL);
                if self.config.dialect == FormattingDialect::TRINO {
                    if !unbounded {
                        return self.format_unimplemented(node);
                    }
                    type_reg = f.concat(&[f.text("array("), type_reg, f.text(")")]);
                } else if row_element && unbounded {
                    type_reg = f.concat(&[f.text("array("), type_reg, f.text(")")]);
                } else {
                    let bound_reg = bound.filter(|b| b.node_type() != NodeType::BOOL).map_or(f.empty(), |b| self.reg(b));
                    type_reg = f.concat(&[type_reg, f.text("["), bound_reg, f.text("]")]);
                }
            }
        }

        let mut parts = Vec::with_capacity(2);
        if is_true(setof) {
            parts.push(f.text("setof "));
        }
        parts.push(type_reg);
        f.concat(&parts)
    }

    fn format_interval_type_enum(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_INTERVAL_TYPE {
            return self.format_unimplemented(node);
        }
        let text = match IntervalType(value_u8(node)) {
            IntervalType::YEAR => "year",
            IntervalType::MONTH => "month",
            IntervalType::DAY => "day",
            IntervalType::HOUR => "hour",
            IntervalType::MINUTE => "minute",
            IntervalType::SECOND | IntervalType::INTERVAL_SECOND => "second",
            IntervalType::YEAR_TO_MONTH => "year to month",
            IntervalType::DAY_TO_HOUR => "day to hour",
            IntervalType::DAY_TO_MINUTE => "day to minute",
            IntervalType::DAY_TO_SECOND => "day to second",
            IntervalType::HOUR_TO_MINUTE => "hour to minute",
            IntervalType::HOUR_TO_SECOND => "hour to second",
            IntervalType::MINUTE_TO_SECOND => "minute to second",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    /// The type of `interval '1' day` is the interval qualifier alone, a type name needs the keyword
    fn format_interval_type(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [interval_type, precision] = attrs!(self.children(node), [K::SQL_INTERVAL_TYPE, K::SQL_INTERVAL_PRECISION]);
        let is_qualifier = node.attribute_key() == K::SQL_CONST_CAST_INTERVAL;
        let mut parts = Vec::with_capacity(4);
        if !is_qualifier {
            parts.push(f.text("interval"));
        }
        if let Some(interval_type) = interval_type {
            if !is_qualifier {
                parts.push(f.text(" "));
            }
            parts.push(self.reg(interval_type));
        } else if is_qualifier {
            return self.format_unimplemented(node);
        }
        if let Some(precision) = precision {
            parts.push(f.parenthesized(self.reg(precision)));
        }
        f.concat(&parts)
    }

    fn format_const_type_cast(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [type_node, value] = attrs!(self.children(node), [K::SQL_CONST_CAST_TYPE, K::SQL_CONST_CAST_VALUE]);
        let (Some(type_node), Some(value)) = (type_node, value) else { return self.format_unimplemented(node) };
        let type_reg = self.reg(type_node);
        let value_reg = self.reg(value);
        if type_reg == 0 || value_reg == 0 {
            return self.format_unimplemented(node);
        }
        f.concat(&[type_reg, f.text(" "), value_reg])
    }

    fn format_const_interval_cast(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [value, interval] = attrs!(self.children(node), [K::SQL_CONST_CAST_VALUE, K::SQL_CONST_CAST_INTERVAL]);
        let Some(value) = value else { return self.format_unimplemented(node) };
        let mut parts = vec![f.text("interval "), self.reg(value)];
        if let Some(interval) = interval {
            parts.push(f.text(" "));
            parts.push(self.reg(interval));
        }
        f.concat(&parts)
    }

    /// The arguments of a function call, None if an argument cannot be formatted
    fn format_call_arguments(&self, args: Option<&'a Node>) -> Option<Vec<FmtReg>> {
        let mut arg_items = Vec::new();
        if let Some(args) = args {
            if args.node_type() != NodeType::ARRAY {
                return None;
            }
            for arg in self.children(args) {
                let reg = self.reg(arg);
                if reg == 0 {
                    return None;
                }
                arg_items.push(reg);
            }
        }
        Some(arg_items)
    }

    fn format_const_function_cast(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, args, order, value] = attrs!(self.children(node), [
                K::SQL_CONST_CAST_FUNC_NAME,
                K::SQL_CONST_CAST_FUNC_ARGS_LIST,
                K::SQL_CONST_CAST_FUNC_ARGS_ORDER,
                K::SQL_CONST_CAST_VALUE,
            ],
        );
        let (Some(name), Some(value)) = (name, value) else { return self.format_unimplemented(node) };
        let name_reg = self.reg(name);
        let value_reg = self.reg(value);
        if name_reg == 0 || value_reg == 0 {
            return self.format_unimplemented(node);
        }

        let Some(arg_items) = self.format_call_arguments(args) else { return self.format_unimplemented(node) };
        let mut call_parts = Vec::with_capacity(3);
        if !arg_items.is_empty() {
            call_parts.push(self.comma_join_on_overflow(&arg_items, true));
        }
        if let Some(order) = order {
            let order_reg = self.reg(order);
            if order_reg == 0 {
                return self.format_unimplemented(node);
            }
            call_parts.push(f.text(if call_parts.is_empty() { "order by " } else { " order by " }));
            call_parts.push(order_reg);
        }

        let mut call_reg = name_reg;
        if !call_parts.is_empty() {
            let call_body = f.concat(&call_parts);
            if call_body == 0 {
                return self.format_unimplemented(node);
            }
            call_reg = f.concat(&[name_reg, f.parenthesized(call_body)]);
        }
        f.concat(&[call_reg, f.text(" "), value_reg])
    }

    fn format_numeric_type_base(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_NUMERIC_TYPE {
            return self.format_unimplemented(node);
        }
        let text = match NumericType(value_u8(node)) {
            NumericType::INT1 => "tinyint",
            NumericType::INT2 => "smallint",
            NumericType::INT4 => "integer",
            NumericType::INT8 => "bigint",
            NumericType::FLOAT4 => "real",
            NumericType::FLOAT8 => "double precision",
            NumericType::NUMERIC => "numeric",
            NumericType::BOOL => "boolean",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    /// `(m1, m2, ...)` of a type with modifiers
    fn format_type_modifiers(&self, modifiers: &'a Node) -> FmtReg {
        let values: Vec<FmtReg> = self.children(modifiers).iter().map(|m| self.reg(m)).collect();
        let (inline_separator, break_separator) = self.comma_separators();
        let joined = self.fmt.join(&values, inline_separator, break_separator, None, true);
        self.fmt.parenthesized(joined)
    }

    fn format_numeric_type(&self, node: &'a Node) -> FmtReg {
        let [base, modifiers] = attrs!(self.children(node), [K::SQL_NUMERIC_TYPE_BASE, K::SQL_NUMERIC_TYPE_MODIFIERS]);
        let Some(base) = base else { return self.format_unimplemented(node) };
        let mut parts = vec![self.reg(base)];
        if let Some(modifiers) = modifiers.filter(|m| m.node_type() == NodeType::ARRAY && m.children_count() > 0) {
            parts.push(self.format_type_modifiers(modifiers));
        }
        self.fmt.concat(&parts)
    }

    fn format_character_type_base(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_CHARACTER_TYPE {
            return self.format_unimplemented(node);
        }
        let text = match CharacterType(value_u8(node)) {
            CharacterType::VARCHAR => "varchar",
            CharacterType::BLANK_PADDED_CHAR => "char",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_character_type(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [character_type, length] = attrs!(self.children(node), [K::SQL_CHARACTER_TYPE, K::SQL_CHARACTER_TYPE_LENGTH]);
        let Some(character_type) = character_type else { return self.format_unimplemented(node) };
        let mut parts = vec![self.reg(character_type)];
        if let Some(length) = length {
            parts.push(f.parenthesized(self.reg(length)));
        }
        f.concat(&parts)
    }

    fn format_generic_type(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, modifiers] = attrs!(self.children(node), [K::SQL_GENERIC_TYPE_NAME, K::SQL_GENERIC_TYPE_MODIFIERS]);
        let Some(name) = name else { return self.format_unimplemented(node) };

        let name_text = self.text_at(name.symbol_span());
        if name_text.eq_ignore_ascii_case("array") {
            if let Some(modifiers) = modifiers.filter(|m| m.node_type() == NodeType::ARRAY && m.children_count() == 1) {
                let element_node = &self.ast[modifiers.children_begin_or_value() as usize];
                let element = self.reg(element_node);
                // Hyper does not accept row(...)[], only array(row(...))
                let [element_type] = attrs!(self.children(element_node), [K::SQL_TYPENAME_TYPE]);
                let row_element = element_type.is_some_and(|t| t.node_type() == NodeType::OBJECT_SQL_ROW_TYPE);
                if self.config.dialect == FormattingDialect::HYPER && !row_element {
                    return f.concat(&[element, f.text("[]")]);
                }
                return f.concat(&[f.text("array("), element, f.text(")")]);
            }
        }

        let mut parts = vec![self.reg(name)];
        if let Some(modifiers) = modifiers.filter(|m| m.node_type() == NodeType::ARRAY && m.children_count() > 0) {
            parts.push(self.format_type_modifiers(modifiers));
        }
        f.concat(&parts)
    }

    fn format_timestamp_type(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [precision, with_tz] = attrs!(self.children(node), [K::SQL_TIME_TYPE_PRECISION, K::SQL_TIME_TYPE_WITH_TIMEZONE]);
        let is_time = node.node_type() == NodeType::OBJECT_SQL_TIME_TYPE;
        let mut parts = vec![f.text(if is_time { "time" } else { "timestamp" })];
        if let Some(precision) = precision {
            parts.push(f.parenthesized(self.reg(precision)));
        }
        if is_true(with_tz) {
            parts.push(f.text(" with time zone"));
        }
        f.concat(&parts)
    }

    // -----------------------------------------------------------------------------------------
    // Ordering and enums
    // -----------------------------------------------------------------------------------------

    fn format_order(&self, node: &'a Node) -> FmtReg {
        let [value, direction, nullrule] =
            attrs!(self.children(node), [K::SQL_ORDER_VALUE, K::SQL_ORDER_DIRECTION, K::SQL_ORDER_NULLRULE]);
        let Some(value) = value else { return self.format_unimplemented(node) };
        let mut parts = vec![self.reg(value)];
        if let Some(direction) = direction {
            parts.push(self.reg(direction));
        }
        if let Some(nullrule) = nullrule {
            parts.push(self.reg(nullrule));
        }
        self.space_join(&parts, FormattingJoinPolicy::BreakAllOrNone, true)
    }

    fn format_order_direction(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_ORDER_DIRECTION {
            return self.format_unimplemented(node);
        }
        let text = match OrderDirection(value_u8(node)) {
            OrderDirection::ASCENDING => "asc",
            OrderDirection::DESCENDING => "desc",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_order_null_rule(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_ORDER_NULL_RULE {
            return self.format_unimplemented(node);
        }
        let text = match OrderNullRule(value_u8(node)) {
            OrderNullRule::NULLS_FIRST => "nulls first",
            OrderNullRule::NULLS_LAST => "nulls last",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_extract_target(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_EXTRACT_TARGET {
            return self.format_unimplemented(node);
        }
        let text = match ExtractTarget(value_u8(node)) {
            ExtractTarget::YEAR => "year",
            ExtractTarget::MONTH => "month",
            ExtractTarget::DAY => "day",
            ExtractTarget::HOUR => "hour",
            ExtractTarget::MINUTE => "minute",
            ExtractTarget::SECOND => "second",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_trim_direction(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_TRIM_TARGET {
            return self.format_unimplemented(node);
        }
        let text = match TrimDirection(value_u8(node)) {
            TrimDirection::BOTH => "both",
            TrimDirection::LEADING => "leading",
            TrimDirection::TRAILING => "trailing",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    // -----------------------------------------------------------------------------------------
    // References and rows
    // -----------------------------------------------------------------------------------------

    fn format_column_ref(&self, node: &'a Node) -> FmtReg {
        let [path] = attrs!(self.children(node), [K::SQL_COLUMN_REF_PATH]);
        match path {
            Some(path) => self.reg(path),
            None => self.format_unimplemented(node),
        }
    }

    fn format_parameter_ref(&self, node: &'a Node) -> FmtReg {
        let [prefix, name] = attrs!(self.children(node), [K::SQL_PARAMETER_PREFIX, K::SQL_PARAMETER_NAME]);
        let Some(prefix) = prefix else { return self.format_unimplemented(node) };
        let prefix_reg = self.reg(prefix);
        if prefix_reg == 0 {
            return self.format_unimplemented(node);
        }
        // Positional parameters (?) have no name
        let Some(name) = name else { return prefix_reg };
        let name_reg = self.reg(name);
        if name_reg == 0 {
            return self.format_unimplemented(node);
        }
        self.fmt.concat(&[prefix_reg, name_reg])
    }

    /// `<keyword>(<attribute>)`, unformattable without the attribute
    fn format_keyword_call(&self, node: &'a Node, key: AttributeKey, keyword: &'static str) -> FmtReg {
        let [child] = attrs!(self.children(node), [key]);
        let Some(child) = child else { return self.format_unimplemented(node) };
        let child_reg = self.reg(child);
        if child_reg == 0 {
            return self.format_unimplemented(node);
        }
        let f = &self.fmt;
        f.concat(&[f.text(keyword), f.parenthesized(child_reg)])
    }

    fn format_relation_expression(&self, node: &'a Node) -> FmtReg {
        self.format_keyword_call(node, K::SQL_TABLEREF_NAME, "table")
    }

    fn format_descriptor(&self, node: &'a Node) -> FmtReg {
        self.format_keyword_call(node, K::SQL_DESCRIPTOR_COLUMNS, "descriptor")
    }

    fn format_indirection(&self, node: &'a Node) -> FmtReg {
        let [value, path] = attrs!(self.children(node), [K::SQL_INDIRECTION_VALUE, K::SQL_INDIRECTION_PATH]);
        let (Some(value), Some(path)) = (value, path) else { return self.format_unimplemented(node) };
        let value_reg = self.reg(value);
        let path_reg = self.reg(path);
        if value_reg == 0 || path_reg == 0 {
            return self.format_unimplemented(node);
        }
        self.fmt.concat(&[self.fmt.parenthesized(value_reg), path_reg])
    }

    fn format_row_type(&self, node: &'a Node) -> FmtReg {
        self.format_keyword_call(node, K::SQL_ROW_TYPE_FIELDS, "row")
    }

    fn format_row_expression(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [is_explicit, values] = attrs!(self.children(node), [K::SQL_ROW_EXPRESSION_EXPLICIT, K::SQL_ROW_EXPRESSION_VALUES]);
        let Some(values) = values.filter(|v| v.node_type() == NodeType::ARRAY) else {
            return self.format_unimplemented(node);
        };
        if values.children_count() == 0 {
            return f.text("row()");
        }
        let values_reg = self.reg(values);
        if values_reg == 0 {
            return self.format_unimplemented(node);
        }
        // (x) is just x, so a single value always needs the row keyword
        if is_explicit.is_some() || values.children_count() == 1 {
            return f.concat(&[f.text("row"), f.parenthesized(values_reg)]);
        }
        f.parenthesized(values_reg)
    }

    // -----------------------------------------------------------------------------------------
    // Column definitions and constraints
    // -----------------------------------------------------------------------------------------

    fn format_column_def(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        #[rustfmt::skip]
        let [name, type_node, options, constraints, collate] = attrs!(self.children(node), [
            K::SQL_COLUMN_DEF_NAME,
            K::SQL_COLUMN_DEF_TYPE,
            K::SQL_COLUMN_DEF_OPTIONS,
            K::SQL_COLUMN_DEF_CONSTRAINTS,
            K::SQL_COLUMN_DEF_COLLATE,
        ]);
        let (Some(name), Some(type_node)) = (name, type_node) else { return self.format_unimplemented(node) };

        let mut parts = Vec::with_capacity(6);
        parts.push(self.reg_or_placeholder(name));
        parts.push(f.text(" "));
        parts.push(self.reg_or_placeholder(type_node));
        if let Some(collate) = collate {
            parts.push(f.text(" collate "));
            parts.push(self.reg_or_placeholder(collate));
        }

        if let Some(options) = options {
            if options.node_type() != NodeType::ARRAY {
                parts.push(f.text(" "));
                parts.push(self.format_unimplemented(options));
            } else if options.children_count() > 0 {
                let option_parts: Vec<FmtReg> =
                    self.children(options).iter().map(|o| self.reg_or_placeholder(o)).collect();
                let option_list = self.comma_join_on_overflow(&option_parts, true);
                parts.push(f.text(" options "));
                parts.push(f.parenthesized(option_list));
            }
        }

        if let Some(constraints) = constraints {
            if constraints.node_type() != NodeType::ARRAY {
                parts.push(f.text(" "));
                parts.push(self.format_unimplemented(constraints));
            } else if constraints.children_count() > 0 {
                let constraint_parts: Vec<FmtReg> =
                    self.children(constraints).iter().map(|c| self.reg_or_placeholder(c)).collect();
                let constraint_list = self.space_join(&constraint_parts, FormattingJoinPolicy::BreakOnOverflow, true);
                parts.push(f.text(" "));
                parts.push(constraint_list);
            }
        }
        f.concat(&parts)
    }

    fn format_table_constraint_type(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_TABLE_CONSTRAINT {
            return self.format_unimplemented(node);
        }
        let text = match TableConstraint(value_u8(node)) {
            TableConstraint::CHECK => "check",
            TableConstraint::UNIQUE => "unique",
            TableConstraint::PRIMARY_KEY => "primary key",
            TableConstraint::FOREIGN_KEY => "foreign key",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_key_match(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_KEY_MATCH {
            return self.format_unimplemented(node);
        }
        let text = match KeyMatch(value_u8(node)) {
            KeyMatch::FULL => "match full",
            KeyMatch::PARTIAL => "match partial",
            KeyMatch::SIMPLE => "match simple",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_key_action_command(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_KEY_ACTION_COMMAND {
            return self.format_unimplemented(node);
        }
        let text = match KeyActionCommand(value_u8(node)) {
            KeyActionCommand::NO_ACTION => "no action",
            KeyActionCommand::RESTRICT => "restrict",
            KeyActionCommand::CASCADE => "cascade",
            KeyActionCommand::SET_NULL => "set null",
            KeyActionCommand::SET_DEFAULT => "set default",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_key_action_trigger(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_KEY_ACTION_TRIGGER {
            return self.format_unimplemented(node);
        }
        let text = match KeyActionTrigger(value_u8(node)) {
            KeyActionTrigger::UPDATE => "on update",
            KeyActionTrigger::DELETE => "on delete",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_key_action(&self, node: &'a Node) -> FmtReg {
        let [trigger, command] = attrs!(self.children(node), [K::SQL_KEY_ACTION_TRIGGER, K::SQL_KEY_ACTION_COMMAND]);
        let (Some(trigger), Some(command)) = (trigger, command) else { return self.format_unimplemented(node) };
        self.space_join(&[self.reg(trigger), self.reg(command)], FormattingJoinPolicy::BreakAllOrNone, true)
    }

    /// A space-separated list of constraint parts
    fn format_space_list(&self, list: &'a Node) -> FmtReg {
        if list.node_type() != NodeType::ARRAY {
            return self.format_unimplemented(list);
        }
        if list.children_count() == 0 {
            return self.fmt.empty();
        }
        let parts: Vec<FmtReg> = self.children(list).iter().map(|c| self.reg_or_placeholder(c)).collect();
        self.space_join(&parts, FormattingJoinPolicy::BreakOnOverflow, true)
    }

    fn format_table_constraint(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        #[rustfmt::skip]
        let [
            constraint_type, constraint_name, constraint_argument, constraint_index, constraint_columns,
            constraint_references_name, constraint_references_columns, constraint_attributes, constraint_definition,
            constraint_key_actions, constraint_key_match,
        ] = attrs!(self.children(node), [
                K::SQL_TABLE_CONSTRAINT_TYPE,
                K::SQL_TABLE_CONSTRAINT_NAME,
                K::SQL_TABLE_CONSTRAINT_ARGUMENT,
                K::SQL_TABLE_CONSTRAINT_INDEX,
                K::SQL_TABLE_CONSTRAINT_COLUMNS,
                K::SQL_TABLE_CONSTRAINT_REFERENCES_NAME,
                K::SQL_TABLE_CONSTRAINT_REFERENCES_COLUMNS,
                K::SQL_TABLE_CONSTRAINT_ATTRIBUTES,
                K::SQL_TABLE_CONSTRAINT_DEFINITION,
                K::SQL_TABLE_CONSTRAINT_KEY_ACTIONS,
                K::SQL_TABLE_CONSTRAINT_KEY_MATCH,
            ],
        );
        let Some(constraint_type) = constraint_type.filter(|t| t.node_type() == NodeType::ENUM_SQL_TABLE_CONSTRAINT)
        else {
            return self.format_unimplemented(node);
        };
        let or_placeholder = |child: Option<&'a Node>| match child {
            Some(child) => self.reg_or_placeholder(child),
            None => self.format_unimplemented(node),
        };

        let mut parts = Vec::with_capacity(16);
        if let Some(constraint_name) = constraint_name {
            parts.push(f.text("constraint "));
            parts.push(self.reg_or_placeholder(constraint_name));
            parts.push(f.text(" "));
        }

        let ctype = TableConstraint(value_u8(constraint_type));
        parts.push(self.reg_or_placeholder(constraint_type));
        match ctype {
            TableConstraint::CHECK => {
                parts.push(f.text(" "));
                parts.push(f.parenthesized(or_placeholder(constraint_argument)));
            }
            TableConstraint::UNIQUE | TableConstraint::PRIMARY_KEY => {
                if let Some(constraint_index) = constraint_index {
                    parts.push(f.text(" using index "));
                    parts.push(self.reg_or_placeholder(constraint_index));
                } else {
                    parts.push(f.text(" "));
                    parts.push(f.parenthesized(or_placeholder(constraint_columns)));
                }
            }
            TableConstraint::FOREIGN_KEY => {
                parts.push(f.text(" "));
                parts.push(f.parenthesized(or_placeholder(constraint_columns)));
                parts.push(f.text(" references "));
                parts.push(or_placeholder(constraint_references_name));
                if let Some(columns) =
                    constraint_references_columns.filter(|c| c.node_type() == NodeType::ARRAY && c.children_count() > 0)
                {
                    parts.push(f.text(" "));
                    parts.push(f.parenthesized(self.reg_or_placeholder(columns)));
                }
            }
            _ => {}
        }

        if let Some(constraint_key_match) = constraint_key_match {
            parts.push(f.text(" "));
            parts.push(self.reg_or_placeholder(constraint_key_match));
        }
        if let Some(constraint_key_actions) = constraint_key_actions {
            let actions = self.format_space_list(constraint_key_actions);
            if actions != 0 {
                parts.push(f.text(" "));
                parts.push(actions);
            }
        }
        if let Some(constraint_attributes) = constraint_attributes {
            let attributes = self.format_space_list(constraint_attributes);
            if attributes != 0 {
                parts.push(f.text(" "));
                parts.push(attributes);
            }
        }
        if let Some(constraint_definition) = constraint_definition {
            let definition = self.reg_or_placeholder(constraint_definition);
            if definition != 0 {
                parts.push(f.text(" with "));
                parts.push(f.parenthesized(definition));
            }
        }
        f.concat(&parts)
    }

    fn format_column_constraint_type(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_COLUMN_CONSTRAINT {
            return self.format_unimplemented(node);
        }
        let text = match ColumnConstraint(value_u8(node)) {
            ColumnConstraint::NOT_NULL => "not null",
            ColumnConstraint::NULL_ => "null",
            ColumnConstraint::UNIQUE => "unique",
            ColumnConstraint::PRIMARY_KEY => "primary key",
            ColumnConstraint::CHECK => "check",
            ColumnConstraint::DEFAULT => "default",
            ColumnConstraint::COLLATE => "collate",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_column_constraint(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        #[rustfmt::skip]
        let [
            constraint_type, constraint_name, constraint_value, constraint_no_inherit, constraint_definition,
            constraint_collate,
        ] = attrs!(self.children(node), [
                K::SQL_COLUMN_CONSTRAINT_TYPE,
                K::SQL_COLUMN_CONSTRAINT_NAME,
                K::SQL_COLUMN_CONSTRAINT_VALUE,
                K::SQL_COLUMN_CONSTRAINT_NO_INHERIT,
                K::SQL_COLUMN_CONSTRAINT_DEFINITION,
                K::SQL_COLUMN_CONSTRAINT_COLLATE,
            ],
        );
        let Some(constraint_type) = constraint_type.filter(|t| t.node_type() == NodeType::ENUM_SQL_COLUMN_CONSTRAINT)
        else {
            return self.format_unimplemented(node);
        };
        let or_placeholder = |child: Option<&'a Node>| match child {
            Some(child) => self.reg_or_placeholder(child),
            None => self.format_unimplemented(node),
        };

        let mut parts = Vec::with_capacity(8);
        if let Some(constraint_name) = constraint_name {
            parts.push(f.text("constraint "));
            parts.push(self.reg_or_placeholder(constraint_name));
            parts.push(f.text(" "));
        }

        let ctype = ColumnConstraint(value_u8(constraint_type));
        parts.push(self.reg_or_placeholder(constraint_type));
        match ctype {
            ColumnConstraint::CHECK => {
                parts.push(f.text(" "));
                parts.push(f.parenthesized(or_placeholder(constraint_value)));
                if is_true(constraint_no_inherit) {
                    parts.push(f.text(" no inherit"));
                }
            }
            ColumnConstraint::DEFAULT => {
                parts.push(f.text(" "));
                parts.push(or_placeholder(constraint_value));
            }
            ColumnConstraint::COLLATE => {
                parts.push(f.text(" "));
                parts.push(or_placeholder(constraint_collate));
            }
            _ => {}
        }

        if let Some(constraint_definition) = constraint_definition {
            let def_reg = self.reg_or_placeholder(constraint_definition);
            if def_reg != 0 {
                parts.push(f.text(" with "));
                parts.push(f.parenthesized(def_reg));
            }
        }
        f.concat(&parts)
    }

    fn format_constraint_attribute(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE {
            return self.format_unimplemented(node);
        }
        let text = match ConstraintAttribute(value_u8(node)) {
            ConstraintAttribute::DEFERRABLE => "deferrable",
            ConstraintAttribute::NOT_DEFERRABLE => "not deferrable",
            ConstraintAttribute::INITIALLY_DEFERRED => "initially deferred",
            ConstraintAttribute::INITIALLY_IMMEDIATE => "initially immediate",
            ConstraintAttribute::NOT_VALID => "not valid",
            ConstraintAttribute::NO_INHERIT => "no inherit",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    fn format_generic_option(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [key, value] = attrs!(self.children(node), [K::SQL_GENERIC_OPTION_KEY, K::SQL_GENERIC_OPTION_VALUE]);
        let Some(key) = key else { return self.format_unimplemented(node) };
        let key_reg = self.reg(key);
        match value {
            Some(value) if value.node_type() != NodeType::NONE => f.concat(&[key_reg, f.text(" "), self.reg(value)]),
            _ => key_reg,
        }
    }

    // -----------------------------------------------------------------------------------------
    // Functions
    // -----------------------------------------------------------------------------------------

    fn format_function_arg(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [arg_name, arg_value] = attrs!(self.children(node), [K::SQL_FUNCTION_ARG_NAME, K::SQL_FUNCTION_ARG_VALUE]);
        let Some(arg_value) = arg_value else { return self.format_unimplemented(node) };
        let value_reg = self.reg(arg_value);
        if value_reg == 0 {
            return self.format_unimplemented(node);
        }
        let Some(arg_name) = arg_name else { return value_reg };
        let name_reg = self.reg(arg_name);
        if name_reg == 0 {
            return self.format_unimplemented(node);
        }
        f.concat(&[name_reg, f.text(" => "), value_reg])
    }

    /// `name(<a> <keyword> <b>)` of the special function syntaxes, None if a part is missing
    fn format_special_call(
        &self,
        name_reg: FmtReg,
        args: &'a Node,
        keys: [AttributeKey; 2],
        keyword: &'static str,
    ) -> Option<FmtReg> {
        let f = &self.fmt;
        let [a, b] = self.attrs(args, keys);
        let a_reg = self.reg(a?);
        let b_reg = self.reg(b?);
        if a_reg == 0 || b_reg == 0 {
            return None;
        }
        Some(f.concat(&[name_reg, f.parenthesized(f.concat(&[a_reg, f.text(keyword), b_reg]))]))
    }

    fn format_function_expression(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        #[rustfmt::skip]
        let [
            star, all, distinct, variadic, over, within_group, filter, name, args, order, cast_args, extract_args,
            overlay_args, position_args, substring_args, treat_args, trim_args,
        ] = attrs!(self.children(node), [
                K::SQL_FUNCTION_ARGUMENTS_STAR,
                K::SQL_FUNCTION_ALL,
                K::SQL_FUNCTION_DISTINCT,
                K::SQL_FUNCTION_VARIADIC,
                K::SQL_FUNCTION_OVER,
                K::SQL_FUNCTION_WITHIN_GROUP,
                K::SQL_FUNCTION_FILTER,
                K::SQL_FUNCTION_NAME,
                K::SQL_FUNCTION_ARGUMENTS,
                K::SQL_FUNCTION_ORDER,
                K::SQL_FUNCTION_CAST_ARGS,
                K::SQL_FUNCTION_EXTRACT_ARGS,
                K::SQL_FUNCTION_OVERLAY_ARGS,
                K::SQL_FUNCTION_POSITION_ARGS,
                K::SQL_FUNCTION_SUBSTRING_ARGS,
                K::SQL_FUNCTION_TREAT_ARGS,
                K::SQL_FUNCTION_TRIM_ARGS,
            ],
        );
        let Some(name) = name else { return self.format_unimplemented(node) };
        if all.is_some() && distinct.is_some() {
            return self.format_unimplemented(node);
        }

        let known_function_text = || {
            if name.node_type() != NodeType::ENUM_SQL_KNOWN_FUNCTION {
                return None;
            }
            Some(get_known_function_text(KnownFunction(value_u8(name)))).filter(|t| !t.is_empty())
        };

        if cast_args.is_some()
            || extract_args.is_some()
            || overlay_args.is_some()
            || position_args.is_some()
            || substring_args.is_some()
            || treat_args.is_some()
            || trim_args.is_some()
        {
            let Some(name_text) = known_function_text() else { return self.format_unimplemented(node) };
            let name_reg = f.text(name_text);

            let special = if let Some(cast_args) = cast_args {
                self.format_special_call(
                    name_reg,
                    cast_args,
                    [K::SQL_FUNCTION_CAST_VALUE, K::SQL_FUNCTION_CAST_TYPE],
                    " as ",
                )
            } else if let Some(extract_args) = extract_args {
                self.format_special_call(
                    name_reg,
                    extract_args,
                    [K::SQL_FUNCTION_EXTRACT_TARGET, K::SQL_FUNCTION_EXTRACT_INPUT],
                    " from ",
                )
            } else if let Some(position_args) = position_args {
                self.format_special_call(
                    name_reg,
                    position_args,
                    [K::SQL_FUNCTION_POSITION_SEARCH, K::SQL_FUNCTION_POSITION_INPUT],
                    " in ",
                )
            } else if let Some(treat_args) = treat_args {
                self.format_special_call(
                    name_reg,
                    treat_args,
                    [K::SQL_FUNCTION_TREAT_VALUE, K::SQL_FUNCTION_TREAT_TYPE],
                    " as ",
                )
            } else if let Some(substring_args) = substring_args {
                self.format_substring_args(name_reg, substring_args)
            } else if let Some(trim_args) = trim_args {
                self.format_trim_args(name_reg, trim_args)
            } else if let Some(overlay_args) = overlay_args {
                self.format_overlay_args(name_reg, overlay_args)
            } else {
                None
            };
            return special.unwrap_or_else(|| self.format_unimplemented(node));
        }

        let name_reg = if name.node_type() == NodeType::ARRAY {
            self.reg(name)
        } else if let Some(name_text) = known_function_text() {
            f.text(name_text)
        } else {
            return self.format_unimplemented(node);
        };
        if name_reg == 0 {
            return self.format_unimplemented(node);
        }

        let mut call_parts = Vec::with_capacity(4);
        if star.is_some() {
            if args.is_some() || variadic.is_some() || all.is_some() || distinct.is_some() || order.is_some() {
                return self.format_unimplemented(node);
            }
            call_parts.push(f.text("*"));
        } else {
            let Some(mut arg_items) = self.format_call_arguments(args) else { return self.format_unimplemented(node) };
            if let Some(variadic) = variadic {
                let variadic_reg = self.reg(variadic);
                if variadic_reg == 0 {
                    return self.format_unimplemented(node);
                }
                arg_items.push(f.concat(&[f.text("variadic "), variadic_reg]));
            }
            if all.is_some() || distinct.is_some() {
                if arg_items.is_empty() {
                    return self.format_unimplemented(node);
                }
                call_parts.push(f.text(if all.is_some() { "all " } else { "distinct " }));
            }
            if !arg_items.is_empty() {
                call_parts.push(self.comma_join_on_overflow(&arg_items, true));
            }
        }

        if let Some(order) = order {
            let order_reg = self.reg(order);
            if order_reg == 0 {
                return self.format_unimplemented(node);
            }
            call_parts.push(f.text(if call_parts.is_empty() { "order by " } else { " order by " }));
            call_parts.push(order_reg);
        }

        let call_body = f.concat(&call_parts);
        let mut result = if call_body == 0 {
            if name.node_type() == NodeType::ENUM_SQL_KNOWN_FUNCTION {
                name_reg
            } else {
                f.concat(&[name_reg, f.text("()")])
            }
        } else {
            f.concat(&[name_reg, f.parenthesized(call_body)])
        };

        if let Some(filter) = filter {
            let filter_reg = self.reg(filter);
            if filter_reg == 0 {
                return self.format_unimplemented(node);
            }
            let body = f.concat(&[f.text("where "), filter_reg]);
            result = f.concat(&[result, f.text(" filter "), f.parenthesized(body)]);
        }
        if let Some(within_group) = within_group {
            let wg_reg = self.reg(within_group);
            if wg_reg == 0 {
                return self.format_unimplemented(node);
            }
            let body = f.concat(&[f.text("order by "), wg_reg]);
            result = f.concat(&[result, f.text(" within group "), f.parenthesized(body)]);
        }
        if let Some(over) = over {
            let over_reg = self.reg(over);
            result = if over_reg == 0 {
                f.concat(&[result, f.text(" over ()")])
            } else if over.node_type() == NodeType::NAME {
                // A reference to a named window, `over w`
                f.concat(&[result, f.text(" over "), over_reg])
            } else {
                f.concat(&[result, f.text(" over "), f.parenthesized(over_reg)])
            };
        }
        result
    }

    fn format_substring_args(&self, name_reg: FmtReg, args: &'a Node) -> Option<FmtReg> {
        let f = &self.fmt;
        let [sub_input, sub_from, sub_for] = attrs!(self.children(args), [K::SQL_FUNCTION_SUBSTRING_INPUT, K::SQL_FUNCTION_SUBSTRING_FROM, K::SQL_FUNCTION_SUBSTRING_FOR],
        );
        let input_reg = self.reg(sub_input?);
        if input_reg == 0 {
            return None;
        }
        // `substring(x from 2)`, `substring(x for 3)` or both
        let mut parts = vec![input_reg];
        if let Some(sub_from) = sub_from {
            let from_reg = self.reg(sub_from);
            if from_reg == 0 {
                return None;
            }
            parts.push(f.text(" from "));
            parts.push(from_reg);
        }
        if let Some(sub_for) = sub_for {
            let for_reg = self.reg(sub_for);
            if for_reg == 0 {
                return None;
            }
            parts.push(f.text(" for "));
            parts.push(for_reg);
        } else if sub_from.is_none() {
            return None;
        }
        Some(f.concat(&[name_reg, f.parenthesized(f.concat(&parts))]))
    }

    fn format_trim_args(&self, name_reg: FmtReg, args: &'a Node) -> Option<FmtReg> {
        let f = &self.fmt;
        let [trim_input, trim_dir, trim_chars] = attrs!(self.children(args), [K::SQL_FUNCTION_TRIM_INPUT, K::SQL_FUNCTION_TRIM_DIRECTION, K::SQL_FUNCTION_TRIM_CHARACTERS]);
        let input_reg = self.reg(trim_input?);
        if input_reg == 0 {
            return None;
        }
        let mut parts = Vec::with_capacity(6);
        if let Some(trim_dir) = trim_dir {
            let dir_reg = self.reg(trim_dir);
            if dir_reg == 0 {
                return None;
            }
            parts.push(dir_reg);
            parts.push(f.text(" "));
        }
        if let Some(trim_chars) = trim_chars {
            let chars_reg = self.reg(trim_chars);
            if chars_reg == 0 {
                return None;
            }
            parts.push(chars_reg);
            parts.push(f.text(" "));
        }
        if trim_dir.is_some() || trim_chars.is_some() {
            parts.push(f.text("from "));
        }
        parts.push(input_reg);
        Some(f.concat(&[name_reg, f.parenthesized(f.concat(&parts))]))
    }

    fn format_overlay_args(&self, name_reg: FmtReg, args: &'a Node) -> Option<FmtReg> {
        let f = &self.fmt;
        let [ov_input, ov_placing, ov_from, ov_for] = attrs!(self.children(args), [
                K::SQL_FUNCTION_OVERLAY_INPUT,
                K::SQL_FUNCTION_OVERLAY_PLACING,
                K::SQL_FUNCTION_OVERLAY_FROM,
                K::SQL_FUNCTION_OVERLAY_FOR,
            ],
        );
        let (ov_input, ov_placing, ov_from) = (ov_input?, ov_placing?, ov_from?);
        let input_reg = self.reg(ov_input);
        let placing_reg = self.reg(ov_placing);
        let from_reg = self.reg(ov_from);
        if input_reg == 0 || placing_reg == 0 || from_reg == 0 {
            return None;
        }
        let mut parts = vec![input_reg, f.text(" placing "), placing_reg, f.text(" from "), from_reg];
        if let Some(ov_for) = ov_for {
            let for_reg = self.reg(ov_for);
            if for_reg == 0 {
                return None;
            }
            parts.push(f.text(" for "));
            parts.push(for_reg);
        }
        Some(f.concat(&[name_reg, f.parenthesized(f.concat(&parts))]))
    }

    fn format_function_table(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [function, rows_from, with_ordinality] = attrs!(self.children(node), [K::SQL_FUNCTION_TABLE_FUNCTION, K::SQL_FUNCTION_TABLE_ROWS_FROM, K::SQL_FUNCTION_TABLE_WITH_ORDINALITY],
        );
        let mut base_reg = 0;
        if let Some(function) = function {
            base_reg = self.reg(function);
        } else if let Some(rows_from) = rows_from {
            let items = self.array_regs(rows_from);
            if items.iter().any(|&i| i == 0) {
                return self.format_unimplemented(node);
            }
            let list = self.comma_join_on_overflow(&items, true);
            base_reg = f.concat(&[f.text("rows from "), f.parenthesized(list)]);
        }
        if base_reg == 0 {
            return self.format_unimplemented(node);
        }
        if is_true(with_ordinality) {
            base_reg = f.concat(&[base_reg, f.text(" with ordinality")]);
        }
        base_reg
    }

    // -----------------------------------------------------------------------------------------
    // Windows
    // -----------------------------------------------------------------------------------------

    fn format_window_frame(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [partition, order, mode, bounds, exclude, name] = attrs!(self.children(node), [
                K::SQL_WINDOW_FRAME_PARTITION,
                K::SQL_WINDOW_FRAME_ORDER,
                K::SQL_WINDOW_FRAME_MODE,
                K::SQL_WINDOW_FRAME_BOUNDS,
                K::SQL_WINDOW_FRAME_EXCLUDE,
                K::SQL_WINDOW_FRAME_NAME,
            ],
        );
        if exclude.is_some() || mode.is_none() != bounds.is_none() {
            return self.format_unimplemented(node);
        }

        let mut clauses = Vec::with_capacity(4);
        if let Some(name) = name {
            let name_reg = self.reg(name);
            if name_reg == 0 {
                return self.format_unimplemented(node);
            }
            clauses.push(name_reg);
        }
        if let Some(partition) = partition {
            let part_reg = self.reg(partition);
            if part_reg == 0 {
                return self.format_unimplemented(node);
            }
            clauses.push(f.concat(&[f.text("partition by "), part_reg]));
        }
        if let Some(order) = order {
            let order_reg = self.reg(order);
            if order_reg == 0 {
                return self.format_unimplemented(node);
            }
            clauses.push(f.concat(&[f.text("order by "), order_reg]));
        }
        if let (Some(mode), Some(bounds)) = (mode, bounds) {
            let mode_reg = self.reg(mode);
            let bounds_reg = self.reg(bounds);
            if mode_reg == 0 || bounds_reg == 0 {
                return self.format_unimplemented(node);
            }
            clauses.push(f.concat(&[mode_reg, f.text(" "), bounds_reg]));
        }
        if clauses.is_empty() {
            return f.empty();
        }
        self.space_join(&clauses, FormattingJoinPolicy::BreakOnOverflow, true)
    }

    fn format_window_bound(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [mode, direction, value] =
            attrs!(self.children(node), [K::SQL_WINDOW_BOUND_MODE, K::SQL_WINDOW_BOUND_DIRECTION, K::SQL_WINDOW_BOUND_VALUE]);
        let Some(mode) = mode else { return self.format_unimplemented(node) };
        match (WindowBoundMode(value_u8(mode)), direction, value) {
            (WindowBoundMode::UNBOUNDED, Some(direction), None) => {
                f.concat(&[self.reg(mode), f.text(" "), self.reg(direction)])
            }
            (WindowBoundMode::CURRENT_ROW, None, None) => self.reg(mode),
            (WindowBoundMode::VALUE, Some(direction), Some(value)) => {
                f.concat(&[self.reg(value), f.text(" "), self.reg(direction)])
            }
            _ => self.format_unimplemented(node),
        }
    }

    fn format_window_bound_mode(&self, node: &'a Node) -> FmtReg {
        match WindowBoundMode(value_u8(node)) {
            WindowBoundMode::UNBOUNDED => self.fmt.text("unbounded"),
            WindowBoundMode::CURRENT_ROW => self.fmt.text("current row"),
            WindowBoundMode::VALUE => self.fmt.empty(),
            _ => self.format_unimplemented(node),
        }
    }

    fn format_window_bound_direction(&self, node: &'a Node) -> FmtReg {
        match WindowBoundDirection(value_u8(node)) {
            WindowBoundDirection::PRECEDING => self.fmt.text("preceding"),
            WindowBoundDirection::FOLLOWING => self.fmt.text("following"),
            _ => self.format_unimplemented(node),
        }
    }

    fn format_window_range_mode(&self, node: &'a Node) -> FmtReg {
        match WindowRangeMode(value_u8(node)) {
            WindowRangeMode::RANGE => self.fmt.text("range"),
            WindowRangeMode::ROWS => self.fmt.text("rows"),
            WindowRangeMode::GROUPS => self.fmt.text("groups"),
            _ => self.format_unimplemented(node),
        }
    }

    // -----------------------------------------------------------------------------------------
    // Expressions
    // -----------------------------------------------------------------------------------------

    fn format_alias(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, col_names, col_defs] =
            attrs!(self.children(node), [K::SQL_ALIAS_NAME, K::SQL_ALIAS_COLUMN_NAMES, K::SQL_ALIAS_COLUMN_DEFS]);
        let Some(name) = name else { return self.format_unimplemented(node) };
        let name_reg = self.reg(name);
        if name_reg == 0 {
            return self.format_unimplemented(node);
        }
        for columns in [col_names, col_defs].into_iter().flatten() {
            if columns.node_type() == NodeType::ARRAY && columns.children_count() > 0 {
                let cols = self.format_comma_list(columns, true);
                return f.concat(&[name_reg, f.parenthesized(cols)]);
            }
        }
        name_reg
    }

    fn format_typecast_expression(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [value, type_node] = attrs!(self.children(node), [K::SQL_TYPECAST_VALUE, K::SQL_TYPECAST_TYPE]);
        let (Some(value), Some(type_node)) = (value, type_node) else { return self.format_unimplemented(node) };
        let mut value_reg = self.reg(value);
        let type_reg = self.reg(type_node);
        if value_reg == 0 || type_reg == 0 {
            return self.format_unimplemented(node);
        }
        if value.node_type() == NodeType::OBJECT_SQL_NARY_EXPRESSION {
            value_reg = f.parenthesized(value_reg);
        }
        f.concat(&[value_reg, f.text("::"), type_reg])
    }

    fn format_case(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [argument, clauses, default_value] =
            attrs!(self.children(node), [K::SQL_CASE_ARGUMENT, K::SQL_CASE_CLAUSES, K::SQL_CASE_DEFAULT]);
        let Some(clauses) = clauses else { return self.format_unimplemented(node) };

        let mut parts = Vec::new();
        if let Some(argument) = argument {
            let arg_reg = self.reg(argument);
            if arg_reg == 0 {
                return self.format_unimplemented(node);
            }
            parts.push(f.concat(&[f.text("case "), arg_reg]));
        } else {
            parts.push(f.text("case"));
        }
        for clause in self.array_regs(clauses) {
            if clause == 0 {
                return self.format_unimplemented(node);
            }
            parts.push(clause);
        }
        if let Some(default_value) = default_value {
            let default_reg = self.reg(default_value);
            if default_reg == 0 {
                return self.format_unimplemented(node);
            }
            parts.push(f.concat(&[f.text("else "), default_reg]));
        }
        parts.push(f.text("end"));

        if self.is_pretty() {
            let body = self.space_join(&parts[..parts.len() - 1], FormattingJoinPolicy::ForceBreak, true);
            return self.space_join(&[body, parts[parts.len() - 1]], FormattingJoinPolicy::ForceBreak, false);
        }
        self.space_join(&parts, FormattingJoinPolicy::BreakOnOverflow, true)
    }

    fn format_case_clause(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [when_value, then_value] = attrs!(self.children(node), [K::SQL_CASE_CLAUSE_WHEN, K::SQL_CASE_CLAUSE_THEN]);
        let (Some(when_value), Some(then_value)) = (when_value, then_value) else {
            return self.format_unimplemented(node);
        };
        let when_reg = self.reg(when_value);
        let then_reg = self.reg(then_value);
        if when_reg == 0 || then_reg == 0 {
            return self.format_unimplemented(node);
        }
        f.concat(&[f.text("when "), when_reg, f.text(" then "), then_reg])
    }

    fn format_exists_expression(&self, node: &'a Node) -> FmtReg {
        self.format_keyword_call(node, K::SQL_EXISTS_EXPRESSION_STATEMENT, "exists ")
    }

    /// `OPERATOR(schema.op)`, the elements are the qualifying names and the operator
    fn format_operator_path(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let parts = self.array_regs(node);
        if parts.is_empty() || parts.iter().any(|&p| p == 0) {
            return self.format_unimplemented(node);
        }
        let joined = f.join(&parts, f.text("."), f.text("."), None, false);
        f.concat(&[f.text("operator"), f.parenthesized(joined)])
    }

    /// `a = any (select ...)`
    fn format_subquery_expression(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        #[rustfmt::skip]
        let [arg0, arg1, operator, quantifier] = attrs!(self.children(node), [
            K::SQL_SUBQUERY_ARG0, K::SQL_SUBQUERY_ARG1, K::SQL_SUBQUERY_OPERATOR, K::SQL_SUBQUERY_QUANTIFIER,
        ]);
        let (Some(arg0), Some(arg1), Some(operator), Some(quantifier)) = (arg0, arg1, operator, quantifier) else {
            return self.format_unimplemented(node);
        };
        let (arg0_reg, arg1_reg, op_reg) = (self.reg(arg0), self.reg(arg1), self.reg(operator));
        if arg0_reg == 0 || arg1_reg == 0 || op_reg == 0 {
            return self.format_unimplemented(node);
        }
        // The right hand side is either a subquery, which parenthesizes itself, or an expression
        let arg1_reg =
            if arg1.node_type() == NodeType::OBJECT_SQL_SELECT_EXPRESSION { arg1_reg } else { f.parenthesized(arg1_reg) };
        f.concat(&[arg0_reg, f.text(" "), op_reg, f.text(" "), self.reg(quantifier), f.text(" "), arg1_reg])
    }

    fn format_subquery_quantifier(&self, node: &'a Node) -> FmtReg {
        let text = match SubqueryQuantifier(value_u8(node)) {
            SubqueryQuantifier::ANY => "any",
            SubqueryQuantifier::SOME => "some",
            SubqueryQuantifier::ALL => "all",
            _ => return self.format_unimplemented(node),
        };
        self.fmt.text(text)
    }

    /// `[value]` or `[lower:upper]`, a missing bound of a slice stays empty
    fn format_indirection_index(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [value, lower, upper] = attrs!(self.children(node), [
            K::SQL_INDIRECTION_INDEX_VALUE,
            K::SQL_INDIRECTION_INDEX_LOWER_BOUND,
            K::SQL_INDIRECTION_INDEX_UPPER_BOUND,
        ]);
        let reg_of = |bound: Option<&'a Node>| bound.map_or(f.empty(), |b| self.reg(b));
        if let Some(value) = value {
            return f.concat(&[f.text("["), self.reg(value), f.text("]")]);
        }
        f.concat(&[f.text("["), reg_of(lower), f.text(":"), reg_of(upper), f.text("]")])
    }

    /// The elements of a path after a value: `.field` and `[index]`
    fn format_indirection_path(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let mut parts = Vec::with_capacity(node.children_count() as usize * 2);
        for element in self.children(node) {
            let reg = self.reg(element);
            match element.node_type() {
                NodeType::NAME if reg != 0 => {
                    parts.push(f.text("."));
                    parts.push(reg);
                }
                NodeType::OBJECT_SQL_INDIRECTION_INDEX if reg != 0 => parts.push(reg),
                _ => return self.format_unimplemented(node),
            }
        }
        f.concat(&parts)
    }

    /// `a is [not] of (type, ...)`
    fn format_typetest_expression(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [negate, value, types] =
            attrs!(self.children(node), [K::SQL_TYPETEST_NEGATE, K::SQL_TYPETEST_VALUE, K::SQL_TYPETEST_TYPES]);
        let (Some(value), Some(types)) = (value, types) else { return self.format_unimplemented(node) };
        let (value_reg, types_reg) = (self.reg(value), self.reg(types));
        if value_reg == 0 || types_reg == 0 {
            return self.format_unimplemented(node);
        }
        let keyword = if is_true(negate) { " is not of " } else { " is of " };
        f.concat(&[value_reg, f.text(keyword), f.parenthesized(types_reg)])
    }

    /// `f(...) [as (column definitions)]` of `rows from (...)`
    fn format_rows_from_item(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [function, columns] = attrs!(self.children(node), [K::SQL_ROWSFROM_ITEM_FUNCTION, K::SQL_ROWSFROM_ITEM_COLUMNS]);
        let Some(function) = function else { return self.format_unimplemented(node) };
        let function_reg = self.reg(function);
        if function_reg == 0 {
            return self.format_unimplemented(node);
        }
        match columns.filter(|c| c.node_type() == NodeType::ARRAY) {
            Some(columns) => f.concat(&[function_reg, f.text(" as "), f.parenthesized(self.reg(columns))]),
            None => function_reg,
        }
    }

    /// `bit [varying] [(length)]`
    fn format_bit_type(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [varying, length] = attrs!(self.children(node), [K::SQL_BIT_TYPE_VARYING, K::SQL_BIT_TYPE_LENGTH]);
        let mut parts = vec![f.text(if is_true(varying) { "bit varying" } else { "bit" })];
        if let Some(length) = length {
            parts.push(f.parenthesized(self.reg(length)));
        }
        f.concat(&parts)
    }

    /// `key = value` of a definition list
    fn format_definition_arg(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [key, value] = attrs!(self.children(node), [K::SQL_DEFINITION_ARG_KEY, K::SQL_DEFINITION_ARG_VALUE]);
        let Some(key) = key else { return self.format_unimplemented(node) };
        let value_reg = match value {
            Some(value) => self.reg(value),
            None => f.text("none"),
        };
        if value_reg == 0 {
            return self.format_unimplemented(node);
        }
        f.concat(&[self.reg(key), f.text(" = "), value_reg])
    }

    fn format_cte(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, columns, statement, graph, secure, options] = attrs!(self.children(node), [
                K::SQL_CTE_NAME,
                K::SQL_CTE_COLUMNS,
                K::SQL_CTE_STATEMENT,
                K::SQL_CTE_PROPERTY_GRAPH,
                K::SQL_CTE_SECURE,
                K::SQL_CTE_OPTIONS,
            ],
        );
        let Some(name) = name else { return self.format_unimplemented(node) };
        let Some(body_node) = statement.or(graph) else { return self.format_unimplemented(node) };
        let name_reg = self.reg(name);
        let body_reg = self.reg(body_node);
        if name_reg == 0 || body_reg == 0 {
            return self.format_unimplemented(node);
        }

        let body = if graph.is_some_and(|g| g.children_count() == 0) {
            f.text("()")
        } else if self.is_pretty() {
            f.concat(&[f.text("("), f.indented(f.concat(&[f.break_(), body_reg])), f.break_(), f.text(")")])
        } else {
            f.parenthesized(body_reg)
        };

        let as_reg = if graph.is_some() {
            f.text(" as property graph ")
        } else if secure.is_some() {
            f.text(" as secure ")
        } else {
            f.text(" as ")
        };
        let mut result = match columns.filter(|c| c.node_type() == NodeType::ARRAY && c.children_count() > 0) {
            Some(columns) => {
                let cols_reg = self.reg(columns);
                if cols_reg == 0 {
                    return self.format_unimplemented(columns);
                }
                f.concat(&[name_reg, f.text(" "), f.parenthesized(cols_reg), as_reg, body])
            }
            None => f.concat(&[name_reg, as_reg, body]),
        };
        if let Some(options) = options {
            let options_reg = self.reg(options);
            if options_reg == 0 {
                return self.format_unimplemented(options);
            }
            result = f.concat(&[result, f.text(" options "), f.parenthesized(options_reg)]);
        }
        result
    }

    fn format_expression_operator_type(&self, node: &'a Node) -> FmtReg {
        if node.node_type() != NodeType::ENUM_SQL_EXPRESSION_OPERATOR {
            return self.format_unimplemented(node);
        }
        let text = get_operator_text(ExpressionOperator(value_u8(node)));
        if text.is_empty() {
            return self.format_unimplemented(node);
        }
        self.fmt.text(text)
    }

    fn format_result_target(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [value, name, star, exclude] = attrs!(self.children(node), [
                K::SQL_RESULT_TARGET_VALUE,
                K::SQL_RESULT_TARGET_NAME,
                K::SQL_RESULT_TARGET_STAR,
                K::SQL_RESULT_TARGET_EXCLUDE,
            ],
        );
        if let Some(star) = star {
            if name.is_some() {
                return self.format_unimplemented(node);
            }
            if star.node_type() != NodeType::BOOL || star.children_begin_or_value() == 0 {
                return self.format_unimplemented(star);
            }
            let mut result = match value {
                Some(value) => f.concat(&[self.reg(value), f.text(".*")]),
                None => f.text("*"),
            };
            if let Some(exclude) = exclude {
                let exclude_reg = self.reg(exclude);
                if exclude_reg == 0 {
                    return self.format_unimplemented(exclude);
                }
                result = if exclude.children_count() == 1 {
                    f.concat(&[result, f.text(" exclude "), exclude_reg])
                } else {
                    f.concat(&[result, f.text(" exclude "), f.parenthesized(exclude_reg)])
                };
            }
            return result;
        }
        let Some(value) = value else { return self.format_unimplemented(node) };
        let value_reg = self.reg(value);
        if value_reg == 0 {
            return self.format_unimplemented(value);
        }
        let Some(name) = name else { return value_reg };
        let name_reg = self.reg(name);
        if name_reg == 0 {
            return self.format_unimplemented(name);
        }
        f.concat(&[value_reg, f.text(" as "), name_reg])
    }

    fn format_select_expression(&self, node: &'a Node) -> FmtReg {
        let [statement, indirection] =
            attrs!(self.children(node), [K::SQL_SELECT_EXPRESSION_STATEMENT, K::SQL_SELECT_EXPRESSION_INDIRECTION]);
        let Some(statement) = statement else { return self.format_unimplemented(node) };
        let subquery = self.fmt.parenthesized(self.reg(statement));
        match indirection.filter(|i| i.node_type() == NodeType::ARRAY && i.children_count() > 0) {
            Some(indirection) => self.fmt.concat(&[subquery, self.reg(indirection)]),
            None => subquery,
        }
    }

    /// Is a DEFAULT expression a value of an INSERT ... VALUES?
    fn is_in_insert_values(&self, node: &Node) -> bool {
        let mut parent_id = node.parent() as usize;
        let mut depth = 0;
        while parent_id < self.ast.len() && depth < self.ast.len() {
            let parent = &self.ast[parent_id];
            if parent.attribute_key() == K::SQL_INSERT_SOURCE {
                let [values] = attrs!(self.children(parent), [K::SQL_SELECT_VALUES]);
                return parent.node_type() == NodeType::OBJECT_SQL_SELECT && values.is_some();
            }
            if parent.node_type() == NodeType::OBJECT_SQL_INSERT {
                break;
            }
            let next_parent = parent.parent() as usize;
            if next_parent == parent_id {
                break;
            }
            parent_id = next_parent;
            depth += 1;
        }
        false
    }

    fn format_expression(&self, node_id: usize) -> FmtReg {
        let f = &self.fmt;
        let node = &self.ast[node_id];
        let state = self.node_states[node_id];

        let [op_node, args_node] = attrs!(self.children(node), [K::SQL_EXPRESSION_OPERATOR, K::SQL_EXPRESSION_ARGS]);
        if let (Some(op_node), None) = (op_node, args_node) {
            if op_node.node_type() == NodeType::ENUM_SQL_EXPRESSION_OPERATOR
                && ExpressionOperator(value_u8(op_node)) == ExpressionOperator::DEFAULT
            {
                if !self.is_in_insert_values(node) {
                    return self.format_unimplemented(node);
                }
                return self.reg(op_node);
            }
        }
        let (Some(op_node), Some(args_node)) = (op_node, args_node) else { return self.format_unimplemented(node) };
        if !matches!(
            op_node.node_type(),
            NodeType::ENUM_SQL_EXPRESSION_OPERATOR | NodeType::OPERATOR | NodeType::ARRAY
        ) || args_node.node_type() != NodeType::ARRAY
            || args_node.children_count() == 0
        {
            return self.format_unimplemented(node);
        }

        let known_operator = op_node.node_type() == NodeType::ENUM_SQL_EXPRESSION_OPERATOR;
        let op = if known_operator { ExpressionOperator(value_u8(op_node)) } else { ExpressionOperator::DEFAULT };
        let op_reg = self.reg(op_node);
        if op_reg == 0 {
            return self.format_unimplemented(node);
        }

        let args = self.array_regs(args_node);
        if !known_operator && args.len() != 2 {
            return self.format_unimplemented(node);
        }

        use ExpressionOperator as O;
        let mut reg = if args.len() == 1 && known_operator {
            match op {
                O::NEGATE => f.concat(&[op_reg, args[0]]),
                O::NOT => f.concat(&[op_reg, f.text(" "), args[0]]),
                O::IS_NULL
                | O::NOT_NULL
                | O::IS_TRUE
                | O::IS_FALSE
                | O::IS_UNKNOWN
                | O::IS_NOT_TRUE
                | O::IS_NOT_FALSE
                | O::IS_NOT_UNKNOWN => f.concat(&[args[0], f.text(" "), op_reg]),
                _ => f.concat(&[op_reg, f.text(" "), args[0]]),
            }
        } else if args.len() == 3
            && known_operator
            && matches!(
                op,
                O::BETWEEN_ASYMMETRIC | O::NOT_BETWEEN_ASYMMETRIC | O::BETWEEN_SYMMETRIC | O::NOT_BETWEEN_SYMMETRIC
            )
        {
            f.concat(&[args[0], f.text(" "), op_reg, f.text(" "), args[1], f.text(" and "), args[2]])
        } else if args.len() == 2 && known_operator && matches!(op, O::IN | O::NOT_IN) {
            let mut rhs = args[1];
            let rhs_node = &self.ast[args_node.children_begin_or_value() as usize + 1];
            if rhs_node.node_type() == NodeType::ARRAY {
                let list = self.format_comma_list(rhs_node, true);
                rhs = f.parenthesized(list);
            }
            f.concat(&[args[0], f.text(" "), op_reg, f.text(" "), rhs])
        } else if args.len() == 2 && known_operator && matches!(op, O::IS_DISTINCT_FROM | O::IS_NOT_DISTINCT_FROM) {
            f.concat(&[args[0], f.text(" "), op_reg, f.text(" "), args[1]])
        } else {
            let is_boolean_chain = known_operator && matches!(op, O::AND | O::OR);
            let inline_separator = f.concat(&[f.text(" "), op_reg, f.text(" ")]);
            let break_separator = if breaks_before_operator(op) {
                f.concat(&[f.break_(), op_reg, f.text(" ")])
            } else {
                f.concat(&[f.text(" "), op_reg, f.break_()])
            };
            let policy = if is_boolean_chain { None } else { Some(FormattingJoinPolicy::BreakOnOverflow) };
            f.join(&args, inline_separator, break_separator, policy, true)
        };

        if state.needs_parentheses {
            reg = f.parenthesized(reg);
        }
        reg
    }

    // -----------------------------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------------------------

    fn format_node(&self, node_id: usize) -> FmtReg {
        let node: &'a Node = &self.ast[node_id];
        let f = &self.fmt;
        match node.node_type() {
            NodeType::ARRAY => self.format_array(node),
            NodeType::OBJECT_SQL_SELECT => self.format_select(node_id),
            NodeType::OBJECT_SQL_INSERT => self.format_insert(node),
            NodeType::OBJECT_SQL_DELETE => self.format_delete(node),
            NodeType::OBJECT_SQL_CREATE => self.format_create(node_id),
            NodeType::OBJECT_SQL_CREATE_AS => self.format_create_as(node),
            NodeType::OBJECT_SQL_VIEW => self.format_view(node),
            NodeType::OBJECT_SQL_CREATE_FUNCTION => self.format_create_function(node),
            NodeType::OBJECT_SQL_DROP_TABLE => self.format_drop(node, true),
            NodeType::OBJECT_SQL_DROP_VIEW => self.format_drop(node, false),
            NodeType::OBJECT_SQL_ATTACH_DATABASE => self.format_attach_database(node),
            NodeType::OBJECT_SQL_ATTACH_DATABASE_OPTION => self.format_attach_database_option(node),
            NodeType::OBJECT_SQL_FUNCTION_PARAM => self.format_function_param(node),
            NodeType::OBJECT_EXT_SET => self.format_set(node),
            NodeType::OBJECT_EXT_VARARG_FIELD => self.format_vararg_field(node),
            NodeType::OBJECT_EXT_EXPLAIN => self.format_explain(node_id),
            NodeType::OBJECT_EXT_EXPLAIN_EXPRESSIONS => self.format_explain_expressions(node),
            NodeType::OBJECT_SQL_TABLEREF => self.format_table_ref(node),
            NodeType::OBJECT_SQL_JOINED_TABLE => self.format_joined_table(node),
            NodeType::ENUM_SQL_JOIN_TYPE => f.empty(),
            NodeType::OBJECT_SQL_INTO => self.format_into(node),
            NodeType::OBJECT_SQL_WINDOW_DEF => self.format_window_def(node),
            NodeType::OBJECT_SQL_ROW_LOCKING => self.format_row_locking(node),
            NodeType::ENUM_SQL_ROW_LOCKING_STRENGTH => self.format_row_locking_strength(node),
            NodeType::ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR => self.format_row_locking_block_behavior(node),
            NodeType::OBJECT_SQL_SELECT_SAMPLE => self.format_sample(node, false),
            NodeType::OBJECT_SQL_TABLEREF_SAMPLE => self.format_sample(node, true),
            NodeType::ENUM_SQL_SAMPLE_UNIT_TYPE => self.format_sample_unit(node),
            NodeType::OBJECT_SQL_GROUP_BY_ITEM => self.format_group_by_item(node),
            NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE
            | NodeType::ENUM_SQL_COMBINE_MODIFIER
            | NodeType::ENUM_SQL_COMBINE_OPERATION => f.empty(),
            NodeType::OBJECT_SQL_ORDER => self.format_order(node),
            NodeType::ENUM_SQL_ORDER_DIRECTION => self.format_order_direction(node),
            NodeType::ENUM_SQL_ORDER_NULL_RULE => self.format_order_null_rule(node),
            NodeType::ENUM_SQL_TEMP_TYPE => self.format_temp_type(node),
            NodeType::ENUM_SQL_ON_COMMIT_OPTION => self.format_on_commit_option(node),
            NodeType::OBJECT_SQL_TYPENAME => self.format_type_name(node),
            NodeType::OBJECT_SQL_INTERVAL_TYPE => self.format_interval_type(node),
            NodeType::ENUM_SQL_INTERVAL_TYPE => self.format_interval_type_enum(node),
            NodeType::OBJECT_SQL_NUMERIC_TYPE => self.format_numeric_type(node),
            NodeType::ENUM_SQL_NUMERIC_TYPE => self.format_numeric_type_base(node),
            NodeType::OBJECT_SQL_CHARACTER_TYPE => self.format_character_type(node),
            NodeType::ENUM_SQL_CHARACTER_TYPE => self.format_character_type_base(node),
            NodeType::OBJECT_SQL_GENERIC_TYPE => self.format_generic_type(node),
            NodeType::OBJECT_SQL_TIMESTAMP_TYPE | NodeType::OBJECT_SQL_TIME_TYPE => self.format_timestamp_type(node),
            NodeType::OBJECT_SQL_COLUMN_REF => self.format_column_ref(node),
            NodeType::OBJECT_SQL_PARAMETER_REF => self.format_parameter_ref(node),
            NodeType::OBJECT_SQL_RELATION_EXPR => self.format_relation_expression(node),
            NodeType::OBJECT_SQL_DESCRIPTOR => self.format_descriptor(node),
            NodeType::OBJECT_SQL_INDIRECTION => self.format_indirection(node),
            NodeType::OBJECT_SQL_ROW_TYPE => self.format_row_type(node),
            NodeType::OBJECT_SQL_ROW_EXPRESSION => self.format_row_expression(node),
            NodeType::OBJECT_SQL_SELECT_EXPRESSION => self.format_select_expression(node),
            NodeType::OBJECT_SQL_RESULT_TARGET => self.format_result_target(node),
            NodeType::OBJECT_SQL_COLUMN_DEF => self.format_column_def(node),
            NodeType::ENUM_SQL_TABLE_CONSTRAINT => self.format_table_constraint_type(node),
            NodeType::OBJECT_SQL_TABLE_CONSTRAINT => self.format_table_constraint(node),
            NodeType::ENUM_SQL_KEY_MATCH => self.format_key_match(node),
            NodeType::ENUM_SQL_KEY_ACTION_COMMAND => self.format_key_action_command(node),
            NodeType::ENUM_SQL_KEY_ACTION_TRIGGER => self.format_key_action_trigger(node),
            NodeType::OBJECT_SQL_KEY_ACTION => self.format_key_action(node),
            NodeType::ENUM_SQL_COLUMN_CONSTRAINT => self.format_column_constraint_type(node),
            NodeType::OBJECT_SQL_COLUMN_CONSTRAINT => self.format_column_constraint(node),
            NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE => self.format_constraint_attribute(node),
            NodeType::ENUM_SQL_EXTRACT_TARGET => self.format_extract_target(node),
            NodeType::ENUM_SQL_TRIM_TARGET => self.format_trim_direction(node),
            NodeType::OBJECT_SQL_GENERIC_OPTION => self.format_generic_option(node),
            NodeType::OBJECT_SQL_ALIAS => self.format_alias(node),
            NodeType::OBJECT_SQL_TYPECAST_EXPRESSION => self.format_typecast_expression(node),
            NodeType::OBJECT_SQL_CASE => self.format_case(node),
            NodeType::OBJECT_SQL_CASE_CLAUSE => self.format_case_clause(node),
            NodeType::OBJECT_SQL_EXISTS_EXPRESSION => self.format_exists_expression(node),
            NodeType::OBJECT_SQL_SUBQUERY_EXPRESSION => self.format_subquery_expression(node),
            NodeType::ENUM_SQL_SUBQUERY_QUANTIFIER => self.format_subquery_quantifier(node),
            NodeType::OBJECT_SQL_INDIRECTION_INDEX => self.format_indirection_index(node),
            NodeType::OBJECT_SQL_TYPETEST_EXPRESSION => self.format_typetest_expression(node),
            NodeType::OBJECT_SQL_ROWSFROM_ITEM => self.format_rows_from_item(node),
            NodeType::OBJECT_SQL_BIT_TYPE => self.format_bit_type(node),
            NodeType::OBJECT_SQL_DEF_ARG => self.format_definition_arg(node),
            NodeType::OBJECT_SQL_CTE => self.format_cte(node),
            NodeType::OBJECT_SQL_PROPERTY_GRAPH => self.format_property_graph(node),
            NodeType::OBJECT_SQL_GRAPH_ELEMENT_TABLE => self.format_graph_element_table(node),
            NodeType::OBJECT_SQL_GRAPH_VERTEX_REFERENCE => self.format_graph_vertex_reference(node),
            NodeType::OBJECT_SQL_GRAPH_LABEL => self.format_graph_label(node),
            NodeType::OBJECT_SQL_GRAPH_PROPERTIES => self.format_graph_properties(node),
            NodeType::OBJECT_SQL_GRAPH_PROPERTY => self.format_graph_property(node),
            NodeType::OBJECT_SQL_GRAPH_TABLE => self.format_graph_table(node),
            NodeType::OBJECT_SQL_GRAPH_MATCH => self.format_graph_match(node),
            NodeType::OBJECT_SQL_GRAPH_PATH_ELEMENT => self.format_graph_path_element(node),
            NodeType::OBJECT_SQL_GRAPH_QUANTIFIER => self.format_graph_quantifier(node),
            NodeType::OBJECT_SQL_GRAPH_LABEL_EXPRESSION => self.format_graph_label_expression(node),
            NodeType::OBJECT_SQL_GRAPH_ROWS => self.format_graph_rows(node),
            NodeType::OBJECT_SQL_FUNCTION_EXPRESSION => self.format_function_expression(node),
            NodeType::OBJECT_SQL_FUNCTION_CAST_ARGS
            | NodeType::OBJECT_SQL_FUNCTION_EXTRACT_ARGS
            | NodeType::OBJECT_SQL_FUNCTION_OVERLAY_ARGS
            | NodeType::OBJECT_SQL_FUNCTION_POSITION_ARGS
            | NodeType::OBJECT_SQL_FUNCTION_SUBSTRING_ARGS
            | NodeType::OBJECT_SQL_FUNCTION_TREAT_ARGS
            | NodeType::OBJECT_SQL_FUNCTION_TRIM_ARGS => f.empty(),
            NodeType::ENUM_SQL_KNOWN_FUNCTION => f.empty(),
            NodeType::OBJECT_SQL_FUNCTION_TABLE => self.format_function_table(node),
            NodeType::OBJECT_SQL_WINDOW_FRAME => self.format_window_frame(node),
            NodeType::OBJECT_SQL_WINDOW_BOUND => self.format_window_bound(node),
            NodeType::ENUM_SQL_WINDOW_BOUND_MODE => self.format_window_bound_mode(node),
            NodeType::ENUM_SQL_WINDOW_BOUND_DIRECTION => self.format_window_bound_direction(node),
            NodeType::ENUM_SQL_WINDOW_RANGE_MODE => self.format_window_range_mode(node),
            NodeType::OBJECT_SQL_FUNCTION_ARG => self.format_function_arg(node),
            NodeType::OBJECT_SQL_CONST_TYPE_CAST => self.format_const_type_cast(node),
            NodeType::OBJECT_SQL_CONST_INTERVAL_CAST => self.format_const_interval_cast(node),
            NodeType::OBJECT_SQL_CONST_FUNCTION_CAST => self.format_const_function_cast(node),
            NodeType::ENUM_SQL_EXPRESSION_OPERATOR => self.format_expression_operator_type(node),
            NodeType::OBJECT_SQL_NARY_EXPRESSION => self.format_expression(node_id),
            NodeType::OBJECT_VIS_VISUALISE => self.format_visualize(node_id),
            NodeType::OBJECT_VIS_SPEC
            | NodeType::OBJECT_VIS_UMAP_SPEC
            | NodeType::OBJECT_VIS_MARKDOWN_SPEC
            | NodeType::OBJECT_VIS_TABLE_SPEC
            | NodeType::OBJECT_VIS_DASHBOARD_SPEC
            | NodeType::OBJECT_VIS_MARK
            | NodeType::OBJECT_VIS_ENCODING
            | NodeType::OBJECT_VIS_FIELD_DEF
            | NodeType::OBJECT_VIS_SCALE
            | NodeType::OBJECT_VIS_AXIS
            | NodeType::OBJECT_VIS_LEGEND => self.format_vis_property_list(node),
            NodeType::ENUM_VIS_MARK_TYPE
            | NodeType::ENUM_VIS_FIELD_TYPE
            | NodeType::ENUM_VIS_SCALE_TYPE
            | NodeType::ENUM_VIS_ENCODING_CHANNEL => self.format_vis_enum(node),
            NodeType::OBJECT_EXT_VARARG_ARRAY => self.format_vararg_array(node),
            NodeType::LITERAL_NULL
            | NodeType::LITERAL_INTEGER
            | NodeType::LITERAL_FLOAT
            | NodeType::LITERAL_STRING
            | NodeType::LITERAL_INTERVAL
            | NodeType::BOOL
            | NodeType::OPERATOR
            | NodeType::NAME => self.format_leaf(node),
            _ => self.format_unimplemented(node),
        }
    }

    fn build_docs(&mut self) {
        for node_id in 0..self.ast.len() {
            let reg = self.format_node(node_id);
            self.node_states[node_id].reg = reg;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------------------------

    fn render_options(&self) -> FormattingRenderOptions {
        FormattingRenderOptions {
            max_width: self.config.max_width as usize,
            indentation_width: self.config.indentation_width as usize,
            debug_mode: self.config.debug_mode,
            mode: self.config.mode,
            keyword_case: self.config.keyword_case,
        }
    }

    fn render(&self, reg: FmtReg) -> String {
        self.fmt.render(reg, &self.render_options())
    }

    /// The parts of the script in text order.
    ///
    /// The parser recovers from syntax errors by dropping the broken statement or by keeping a partial one.
    /// Formatting these would silently remove or truncate what the user wrote, so every statement (the text up
    /// to the next semicolon) with a scanner or parser error is copied as written.
    fn output_parts(&self) -> Vec<OutputPart> {
        use dashql_parser::symbol_kind::{S_SEMICOLON, S_YYEOF};
        let symbols = &self.scanned.symbols;
        let statements = &self.parsed.statements;
        let mut parts = Vec::with_capacity(statements.len());

        // The symbol index ranges of the statements, each ends with a semicolon
        let mut chunks: Vec<(usize, usize)> = Vec::new();
        let mut begin = 0;
        for (i, symbol) in symbols.iter().enumerate() {
            if symbol.kind == S_SEMICOLON || symbol.kind == S_YYEOF {
                if i > begin || symbol.kind == S_SEMICOLON {
                    chunks.push((begin, if symbol.kind == S_SEMICOLON { i + 1 } else { i }));
                }
                begin = i + 1;
            }
        }
        let chunk_of_symbol = |symbol: usize| chunks.iter().position(|&(b, e)| symbol >= b && symbol < e);
        let mut damaged = vec![false; chunks.len()];
        for error in &self.parsed.errors {
            let symbol = (error.location.offset() as usize).min(symbols.len().saturating_sub(1));
            if let Some(chunk) = chunk_of_symbol(symbol).or(chunks.len().checked_sub(1)) {
                damaged[chunk] = true;
            }
        }
        for error in &self.scanned.errors {
            let offset = error.location.offset;
            let symbol = symbols.partition_point(|s| s.location.end() <= offset);
            if let Some(chunk) = chunk_of_symbol(symbol).or(chunks.len().checked_sub(1)) {
                damaged[chunk] = true;
            }
        }

        let mut next_statement = 0;
        for (chunk, &(begin, end)) in chunks.iter().enumerate() {
            let chunk_symbols = &symbols[begin..end];
            let begin_offset = chunk_symbols.first().map_or(0, |s| s.location.offset);
            // The last statement may end in text that the scanner dropped, like an unterminated string
            let end_offset = match chunk_symbols.last() {
                Some(last) if last.kind == S_SEMICOLON => last.location.end(),
                _ => self.scanned.text.trim_end().len() as u32,
            };
            let mut in_chunk = Vec::new();
            while next_statement < statements.len() {
                let root = self.ast[statements[next_statement].root as usize];
                let root_offset = resolve_text_span(&self.scanned.text, symbols, *root.symbol_span()).offset;
                if root_offset >= end_offset {
                    break;
                }
                in_chunk.push(next_statement);
                next_statement += 1;
            }
            let only_separator = chunk_symbols.len() == 1 && chunk_symbols[0].kind == S_SEMICOLON;
            if !damaged[chunk] && (!in_chunk.is_empty() || only_separator) {
                parts.extend(in_chunk.into_iter().map(OutputPart::Statement));
            } else if !only_separator {
                parts.push(OutputPart::Damaged(TextSpan::new(begin_offset, end_offset - begin_offset)));
            }
        }
        parts
    }

    fn write_output(&self) -> Vec<u8> {
        let options = self.render_options();
        let statements = &self.parsed.statements;
        let parts = self.output_parts();
        let mut output: Vec<u8> = Vec::with_capacity(self.estimate_formatted_size());

        if self.config.debug_mode {
            output.extend_from_slice(
                format!("/* indentation={}, max_width={} */\n", self.config.indentation_width, self.config.max_width)
                    .as_bytes(),
            );
        }

        let input = self.scanned.text.as_bytes();
        let damaged_text = |span: &TextSpan| &input[span.offset as usize..span.end() as usize];
        if parts.iter().any(|p| matches!(p, OutputPart::Damaged(_))) {
            self.copied_damaged_text.set(true);
        }

        if self.config.mode == FormattingMode::INLINE {
            for (i, part) in parts.iter().enumerate() {
                match part {
                    OutputPart::Statement(statement) => {
                        let root = statements[*statement].root as usize;
                        output.extend_from_slice(self.fmt.render(self.node_states[root].reg, &options).as_bytes());
                        output.push(b';');
                    }
                    OutputPart::Damaged(span) => output.extend_from_slice(damaged_text(span)),
                }
                if i + 1 < parts.len() {
                    output.extend_from_slice(b"\n\n");
                }
            }
            return output;
        }

        let comments = &self.scanned.comments[..];
        let max_width = self.config.max_width as usize;
        let descriptions = self.parsed.associate_descriptions();
        let ensure_line_break = |output: &mut Vec<u8>| {
            if !output.is_empty() && output.last() != Some(&b'\n') {
                output.push(b'\n');
            }
        };
        let mut comment_begin = 0;
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                ensure_line_break(&mut output);
                output.push(b'\n');
            }
            let statement = match part {
                OutputPart::Statement(statement) => *statement,
                OutputPart::Damaged(span) => {
                    // Comments inside the damaged text are part of it
                    let mut before_end = comment_begin;
                    while before_end < comments.len() && comments[before_end].offset < span.offset {
                        before_end += 1;
                    }
                    comments::append_comments(
                        &mut output,
                        input,
                        &comments[comment_begin..before_end],
                        max_width,
                        Some(span.offset as usize),
                    );
                    ensure_line_break(&mut output);
                    output.extend_from_slice(damaged_text(span));
                    comment_begin = before_end;
                    while comment_begin < comments.len() && comments[comment_begin].offset < span.end() {
                        comment_begin += 1;
                    }
                    continue;
                }
            };
            let root = statements[statement].root as usize;
            let description = &descriptions[statement];
            let root_span = resolve_text_span(&self.scanned.text, &self.scanned.symbols, *self.ast[root].symbol_span());
            let mut before_end = comment_begin;
            while before_end < comments.len() && comments[before_end].offset < root_span.offset {
                before_end += 1;
            }
            let description_begin = description.description_begin as usize;
            if description.description_count > 0 && description_begin >= comment_begin {
                let leading_end = description_begin + description.description_count as usize;
                comments::append_comments(
                    &mut output,
                    input,
                    &comments[comment_begin..description_begin],
                    max_width,
                    Some(comments[description_begin].offset as usize),
                );
                comments::append_comments(
                    &mut output,
                    input,
                    &comments[description_begin..leading_end],
                    max_width,
                    Some(root_span.offset as usize),
                );
            } else {
                comments::append_comments(
                    &mut output,
                    input,
                    &comments[comment_begin..before_end],
                    max_width,
                    Some(root_span.offset as usize),
                );
            }

            ensure_line_break(&mut output);
            output.extend_from_slice(self.fmt.render(self.node_states[root].reg, &options).as_bytes());
            output.push(b';');

            let statement_end = description.source_span.end() as usize;
            let mut within_end = before_end;
            while within_end < comments.len() && (comments[within_end].offset as usize) < statement_end {
                within_end += 1;
            }
            comments::append_comments(&mut output, input, &comments[before_end..within_end], max_width, None);
            comment_begin = within_end;
        }
        comments::append_comments(&mut output, input, &comments[comment_begin..], max_width, None);
        output
    }
}

/// The formatted output as a string. Wrapped comments may split UTF-8 sequences like the C++
/// formatter does, they are replaced with U+FFFD.
fn bytes_to_string(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dashql_parser::parser::parse;
    use dashql_parser::scanner::scan;
    use std::sync::Arc;

    fn format(text: &str, mode: FormattingMode, max_width: u32) -> (String, Vec<u32>) {
        let parsed = parse(Arc::new(scan(text, 0, 2)));
        let mut formatter = Formatter::new(&parsed);
        let mut config = FormattingConfigT::default();
        config.mode = mode;
        config.max_width = max_width;
        config.indentation_width = 2;
        let out = formatter.format(&config);
        (out, formatter.unformattable_nodes())
    }

    #[test]
    fn formats_select() {
        let (out, unformattable) = format("SELECT a,b FROM t WHERE a=1 AND b", FormattingMode::COMPACT, 120);
        assert_eq!(out, "select a, b from t where a = 1 and b;");
        assert!(unformattable.is_empty());
        let (out, _) = format("select a, b from t where a = 1", FormattingMode::PRETTY, 120);
        assert_eq!(out, "select a, b\nfrom t\nwhere a = 1;");
    }

    #[test]
    fn adds_parentheses_by_precedence() {
        let (out, _) = format("select (1 + 2) * 3, 1 + 2 * 3, (a or b) and c", FormattingMode::INLINE, 120);
        assert_eq!(out, "select (1 + 2) * 3, 1 + 2 * 3, (a or b) and c;");
    }

    #[test]
    fn copies_statements_with_syntax_errors() {
        let (out, unformattable) = format("select  1; selec  1; select  2", FormattingMode::INLINE, 120);
        assert_eq!(out, "select 1;\n\nselec  1;\n\nselect 2;");
        assert!(unformattable.is_empty());
        // Comments inside the copied text stay, the comments around it are formatted
        let (out, _) = format("-- a\nselect from /* b */ from;\n-- c\nselect  2", FormattingMode::COMPACT, 120);
        assert_eq!(out, "-- a\nselect from /* b */ from;\n\n-- c\nselect 2;");
        // A script that is nothing but an error is copied
        assert_eq!(format("select from where", FormattingMode::PRETTY, 120).0, "select from where");
    }

    #[test]
    fn keeps_comments() {
        let (out, _) = format("-- head\nselect 1; -- tail\nselect 2", FormattingMode::COMPACT, 120);
        assert_eq!(out, "-- head\nselect 1;\n-- tail\n\nselect 2;");
    }

    #[test]
    fn records_unformattable_nodes() {
        // CREATE TABLE is only formatted as statement root, format_node_at does not mark the roots
        let parsed = parse(Arc::new(scan("create table t (a int)", 0, 2)));
        let root = parsed.statements[0].root as usize;
        let mut formatter = Formatter::new(&parsed);
        let mut config = FormattingConfigT::default();
        config.mode = FormattingMode::INLINE;
        assert_eq!(formatter.format(&config), "create table t (a integer);");
        assert!(formatter.is_fully_formatted());
        assert_eq!(formatter.format_node_at(root, &config), "'<OBJECT_SQL_CREATE>'");
        assert_eq!(formatter.unformattable_nodes(), vec![root as u32]);
        assert_eq!(formatter.format_node_at(parsed.nodes.len(), &config), "");
    }

    #[test]
    fn looks_up_attributes_like_cxx() {
        let node = |key: AttributeKey| Node::new(&SymbolSpan::default(), NodeType::NAME, key, 3, 0, 0);
        let nodes = vec![
            node(K::SQL_ALIAS_NAME),
            node(K::SQL_ALIAS_NAME),
            node(K::SQL_ALIAS_COLUMN_NAMES),
            Node::new(&SymbolSpan::default(), NodeType::OBJECT_SQL_ALIAS, K::NONE, u32::MAX, 0, 3),
        ];
        let mut parsed = parse(Arc::new(scan("", 0, 2)));
        parsed.nodes = nodes;
        parsed.statements.clear();
        let formatter = Formatter::new(&parsed);
        let object = &parsed.nodes[3];
        // One key: the first match, several keys: the last match
        let [first] = formatter.attrs(object, [K::SQL_ALIAS_NAME]);
        assert_eq!(formatter.node_id(first.unwrap()), 0);
        let [last, columns, missing] =
            formatter.attrs(object, [K::SQL_ALIAS_NAME, K::SQL_ALIAS_COLUMN_NAMES, K::SQL_ALIAS_COLUMN_DEFS]);
        assert_eq!(formatter.node_id(last.unwrap()), 1);
        assert_eq!(formatter.node_id(columns.unwrap()), 2);
        assert!(missing.is_none());
    }
}
