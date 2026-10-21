//! The analyzer types, a port of `include/dashql/analyzer/analyzer_types.h`.
//!
//! The C++ types link each other through references and intrusive lists. Here every object lives in
//! an arena of the analyzed script and is referenced by its index.

use crate::catalog::*;
use dashql_buffers::algebra::{BinaryExpressionFunction, ComparisonFunction, LiteralType};
use dashql_buffers::analyzer::{AnalyzerErrorSeverity, AnalyzerErrorType};
use dashql_buffers::parser::{AttributeKey, IntervalType as IntervalTypeEnum, KnownFunction, SymbolSpan, VisFieldType, VisMarkType, VisScaleType};
use dashql_parser::span::TextSpan;
use crate::hash::HashMap;
use std::sync::Arc;

/// An expression id (index into the expressions)
pub type ExprId = u32;
/// A name scope id (index into the name scopes)
pub type ScopeId = u32;
/// A table reference id (index into the table references)
pub type TableRefId = u32;

/// A map that iterates in insertion order and never overwrites (the `ankerl::unordered_dense::map`
/// of the C++ core, which is only inserted into)
#[derive(Clone, Debug)]
pub struct OrderedMap<V> {
    /// The keys and values in insertion order
    entries: Vec<(Arc<str>, V)>,
    /// The index of every key in the entries
    index: HashMap<Arc<str>, usize>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::default(),
        }
    }
}

impl<V> OrderedMap<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.index.get(key).map(|&i| &self.entries[i].1)
    }
    pub fn get_index(&self, key: &str) -> Option<usize> {
        self.index.get(key).copied()
    }
    pub fn at(&self, i: usize) -> &V {
        &self.entries[i].1
    }
    pub fn contains(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }
    /// Insert a value unless the key exists. Returns the index of the key.
    pub fn insert(&mut self, key: Arc<str>, value: V) -> usize {
        if let Some(&i) = self.index.get(&key) {
            return i;
        }
        self.entries.push((key.clone(), value));
        self.index.insert(key, self.entries.len() - 1);
        self.entries.len() - 1
    }
    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// An analyzer error
#[derive(Clone, Debug, PartialEq)]
pub struct AnalyzerError {
    /// The error type
    pub error_type: AnalyzerErrorType,
    /// The error severity
    pub severity: AnalyzerErrorSeverity,
    /// The AST node id of the error location, `PROTO_NULL_U32` if there is none
    pub ast_node_id: u32,
    /// The symbol span of the AST node
    pub symbol_span: Option<SymbolSpan>,
    /// The location in the script text
    pub text_span: Option<TextSpan>,
    /// The error message
    pub message: String,
}

/// Whether a table reference reads or writes
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TableRole {
    #[default]
    Read,
    Write,
}

/// A resolved table
#[derive(Clone, Debug)]
pub struct ResolvedTableEntry {
    /// The table name, may refer to a different catalog entry
    pub table_name: QualifiedTableName,
    /// The catalog id of the schema
    pub catalog_schema_id: QualifiedCatalogObjectId,
    /// The catalog id of the table
    pub catalog_table_id: QualifiedCatalogObjectId,
    /// The catalog version of the resolved table
    pub referenced_catalog_version: CatalogVersion,
}

/// A relation expression
#[derive(Clone, Debug)]
pub struct RelationExpression {
    /// The table name as written in the script
    pub table_name: QualifiedTableName,
    /// The resolved table, None if the name was not found
    pub resolved_table: Option<ResolvedTableEntry>,
    /// The ambiguous matches
    pub resolved_alternatives: Vec<ResolvedTableEntry>,
}

/// A table reference
#[derive(Clone, Debug)]
pub struct TableReference {
    /// The table reference id
    pub table_reference_id: ExternalObjectId,
    /// The AST node id of the table ref
    pub ast_node_id: u32,
    /// The location in the script
    pub location: Option<SymbolSpan>,
    /// The AST statement id
    pub ast_statement_id: Option<u32>,
    /// The AST node id of the root of the enclosing name scope
    pub ast_scope_root: Option<u32>,
    /// The alias name and its location
    pub alias: Option<(Name, SymbolSpan)>,
    /// The column names of the alias, they rename the leading columns of the table
    pub column_aliases: Vec<Name>,
    /// The referenced relation, None if the table ref has no table name
    pub inner: Option<RelationExpression>,
    /// Whether the reference reads or writes the table
    pub role: TableRole,
}

/// An explicit INSERT target column
#[derive(Clone, Debug)]
pub struct InsertTargetColumn {
    /// The AST node id of the column name
    pub ast_node_id: u32,
    /// The column name
    pub column_name: Name,
    /// The resolved column of the target table
    pub resolved: Option<ColumnLoc>,
}

/// An INSERT statement
#[derive(Clone, Debug)]
pub struct InsertStatement {
    /// The AST node id of the INSERT
    pub ast_node_id: u32,
    /// The AST statement id
    pub ast_statement_id: Option<u32>,
    /// The table reference of the target table
    pub target: TableRefId,
    /// The AST node id of the source query
    pub source_ast_node_id: Option<u32>,
    /// Whether the statement inserts DEFAULT VALUES
    pub default_values: bool,
    /// Whether the statement has a RETURNING clause
    pub returning: bool,
    /// The explicit target columns
    pub target_columns: Vec<InsertTargetColumn>,
}

/// The confidence of a schema inference
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum InferenceConfidence {
    #[default]
    None = 0,
    Candidate = 1,
    Confident = 2,
}

/// The inferred owner of an unresolved column
#[derive(Clone, Debug)]
pub struct InferredOwner {
    /// The unresolved table reference that owns the column
    pub table_ref: TableRefId,
    /// The (un-normalized) table name of the owner
    pub table_name: QualifiedTableName,
    /// The confidence of the assignment
    pub confidence: InferenceConfidence,
}

/// What a column reference resolved to
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ColumnResolution {
    #[default]
    Unresolved,
    /// A catalog table column
    TableColumn(ColumnLoc),
    /// An output column of a scope
    ScopeColumn { scope: ScopeId, column: u32 },
}

impl ColumnResolution {
    pub fn is_resolved(&self) -> bool {
        !matches!(self, ColumnResolution::Unresolved)
    }
}

/// The catalog ids of a resolved column (`Expression::ResolvedColumnIDs`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedColumnIds {
    /// The catalog id of the schema
    pub catalog_schema_id: QualifiedCatalogObjectId,
    /// The catalog id of the table column
    pub catalog_table_column_id: QualifiedCatalogObjectId,
    /// The catalog version of the table
    pub referenced_catalog_version: CatalogVersion,
}

/// A column reference
#[derive(Clone, Debug)]
pub struct ColumnRef {
    /// The qualified column name as written in the script
    pub column_name: QualifiedColumnName,
    /// The AST node id of the root of the enclosing name scope
    pub ast_scope_root: Option<u32>,
    /// What the column ref resolved to
    pub resolved: ColumnResolution,
    /// The catalog ids behind the resolution, computed once the analysis is done
    /// (`GetResolvedColumnIDs` follows scope columns through their source expressions)
    pub resolved_ids: Option<ResolvedColumnIds>,
    /// The inferred owner of a column that stays unresolved, set by the schema inference
    pub inferred: Option<InferredOwner>,
}

/// A literal
#[derive(Clone, Debug)]
pub struct Literal {
    /// The literal type
    pub literal_type: LiteralType,
    /// The raw value in the script text
    pub raw_value: TextSpan,
}

/// A comparison
#[derive(Clone, Copy, Debug)]
pub struct Comparison {
    /// The comparison function
    pub func: ComparisonFunction,
    /// The expression id of the left child
    pub left_expression_id: u32,
    /// The expression id of the right child
    pub right_expression_id: u32,
}

/// A binary expression
#[derive(Clone, Copy, Debug)]
pub struct BinaryExpression {
    /// The binary expression function
    pub func: BinaryExpressionFunction,
    /// The expression id of the left child
    pub left_expression_id: u32,
    /// The expression id of the right child
    pub right_expression_id: u32,
}

/// A function argument
#[derive(Clone, Debug)]
pub struct FunctionArgument {
    /// The AST node id of the argument
    pub ast_node_id: u32,
    /// The AST node id of the argument value
    pub value_ast_node_id: u32,
    /// The argument name, if the argument is named
    pub name: Option<Name>,
    /// The expression id (the C++ default is an engaged 0)
    pub expression_id: Option<u32>,
}

impl Default for FunctionArgument {
    fn default() -> Self {
        Self {
            ast_node_id: 0,
            value_ast_node_id: 0,
            name: None,
            expression_id: Some(0),
        }
    }
}

/// The name of a called function
#[derive(Clone, Debug)]
pub enum FunctionName {
    Known(KnownFunction),
    Qualified(QualifiedFunctionName),
}

/// The arguments of a function call
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FunctionArguments {
    #[default]
    None,
    /// A slice of the function arguments of the script
    Generic { begin: u32, count: u32 },
}

/// A function call
#[derive(Clone, Debug)]
pub struct FunctionCall {
    /// The function name
    pub function_name: FunctionName,
    /// The `FunctionCallModifier` bits (star, ALL, DISTINCT, VARIADIC, OVER, WITHIN GROUP)
    pub function_call_modifiers: u8,
    /// The arguments
    pub arguments: FunctionArguments,
}

/// An interval type
#[derive(Clone, Copy, Debug)]
pub struct IntervalType {
    /// The interval type
    pub interval_type: IntervalTypeEnum,
    /// The expression id of the interval precision, if any
    pub precision_expression: Option<i32>,
}

/// A constant interval cast
#[derive(Clone, Copy, Debug)]
pub struct ConstIntervalCast {
    /// The expression id of the value
    pub value_expression_id: u32,
    /// The interval type, if not in the value text
    pub interval: Option<IntervalType>,
}

/// The kind of an expression
#[derive(Clone, Debug, Default)]
pub enum ExpressionInner {
    #[default]
    None,
    ColumnRef(ColumnRef),
    Literal(Literal),
    Comparison(Comparison),
    BinaryExpression(BinaryExpression),
    FunctionCall(FunctionCall),
    ConstIntervalCast(ConstIntervalCast),
}

/// An expression
#[derive(Clone, Debug)]
pub struct Expression {
    /// The expression id (index into the expressions)
    pub expression_id: u32,
    /// The AST node id
    pub ast_node_id: u32,
    /// The location in the script
    pub location: Option<SymbolSpan>,
    /// The AST statement id
    pub ast_statement_id: Option<u32>,
    /// The kind of the expression
    pub inner: ExpressionInner,
    /// Whether the expression is constant
    pub is_constant_expression: bool,
}

impl Expression {
    pub fn column_ref(&self) -> Option<&ColumnRef> {
        match &self.inner {
            ExpressionInner::ColumnRef(c) => Some(c),
            _ => None,
        }
    }
    pub fn column_ref_mut(&mut self) -> Option<&mut ColumnRef> {
        match &mut self.inner {
            ExpressionInner::ColumnRef(c) => Some(c),
            _ => None,
        }
    }
}

/// A result target
#[derive(Clone, Debug, Default)]
pub struct ResultTarget {
    /// The AST node id
    pub ast_node_id: u32,
    /// The output column name, the alias or the name of a column ref
    pub column_name: Option<Name>,
    /// The expression id, if not a star
    pub expression_id: Option<u32>,
    /// Whether the target is a star
    pub is_star: bool,
    /// The source name of a qualified star (`t.*`)
    pub star_qualifier: Option<Name>,
}

/// The source of a scope output column
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeColumnSource {
    Expression(ExprId),
    TableColumn(ColumnLoc),
    /// A computed column that has no expression of the analyzer
    Computed,
}

/// An output column of a scope
#[derive(Clone, Debug)]
pub struct ScopeColumn {
    /// The column name
    pub column_name: Name,
    /// The source of the column values
    pub source: ScopeColumnSource,
}

/// A CTE definition in the AST
#[derive(Clone, Debug)]
pub struct CteDefinition {
    /// The CTE name
    pub cte_name: Name,
    /// The AST node id of the CTE statement
    pub select_node_id: u32,
    /// The AST node id of the column alias array, 0 if there is none
    pub columns_node_id: u32,
    /// The number of column aliases
    pub columns_count: u16,
    /// The AST node id of the CTE definition
    pub ast_node_id: u32,
}

/// A CTE attached to a scope
#[derive(Clone, Debug)]
pub struct ResolvedCte {
    /// The CTE name
    pub cte_name: Name,
    /// The scope of the CTE statement
    pub child_scope: Option<ScopeId>,
    /// The AST node id of the CTE definition
    pub definition_node_id: u32,
    /// The column aliases, they rename the leading output columns of the statement
    pub column_aliases: Vec<Name>,
}

/// A CTE location: the scope that defines it and its index in the CTEs of that scope
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CteLoc {
    /// The scope that defines the CTE
    pub scope: ScopeId,
    /// The index in the CTEs of that scope
    pub index: u32,
}

/// An unresolved table in scope
#[derive(Clone, Debug)]
pub struct UnresolvedRelation {
    /// The table reference that introduced the relation
    pub table_ref: TableRefId,
    /// The (un-normalized) table name, the identity for schema inference
    pub table_name: QualifiedTableName,
}

/// A table-like source in scope
#[derive(Clone, Debug)]
pub enum ReferencedTable {
    Table(TableLoc),
    Cte(CteLoc),
    /// A derived table, the output columns of a child scope
    Subquery(ScopeId),
    Unresolved(UnresolvedRelation),
}

impl ReferencedTable {
    pub fn is_unresolved_relation(&self) -> bool {
        matches!(self, ReferencedTable::Unresolved(_))
    }
}

/// A FROM item of a scope
#[derive(Clone, Debug)]
pub struct ScopeSource {
    /// The table ref node
    pub ast_node_id: u32,
    /// The alias or the table name, an unaliased derived table has no name
    pub name: Option<Arc<str>>,
    /// The column names of the alias, they rename the leading columns of the source
    pub column_aliases: Vec<Name>,
    /// The table-like source
    pub table: ReferencedTable,
}

/// The FROM items of a scope that column refs can see
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SourceVisibility {
    #[default]
    All,
    /// The FROM items before a table ref node, a lateral derived table sees those of its parent
    Before(u32),
    /// Derived tables and CTEs see no FROM items of their parent, but those of the scopes above it
    None,
}

impl SourceVisibility {
    pub fn sees(self, source: &ScopeSource) -> bool {
        match self {
            SourceVisibility::All => true,
            SourceVisibility::Before(node_id) => source.ast_node_id < node_id,
            SourceVisibility::None => false,
        }
    }
}

/// A naming scope
#[derive(Clone, Debug, Default)]
pub struct NameScope {
    /// The scope id (index into the name scopes)
    pub name_scope_id: u32,
    /// The AST node id of the scope root
    pub ast_node_id: u32,
    /// The AST statement id
    pub ast_statement_id: u32,
    /// The parent scope, None for a root scope
    pub parent_scope: Option<ScopeId>,
    /// The child scopes
    pub child_scopes: Vec<ScopeId>,
    /// The column references of the scope
    pub expressions: Vec<ExprId>,
    /// The table references of the scope
    pub table_references: Vec<TableRefId>,
    /// The result targets of the scope
    pub result_targets: Vec<ResultTarget>,
    /// The output columns in order, for positional column aliases
    pub output_columns: Vec<ScopeColumn>,
    /// The output columns by name (index into the output columns)
    pub output_columns_by_name: HashMap<Arc<str>, usize>,
    /// The CTEs attached to the scope by name, in declaration order
    pub cte_definitions: OrderedMap<ResolvedCte>,
    /// The AST node ids of the CTE definitions by name
    pub cte_definition_nodes: HashMap<Arc<str>, u32>,
    /// Whether the WITH clause of the scope is recursive
    pub ctes_recursive: bool,
    /// Column refs cannot correlate with any parent scope
    pub column_correlation_barrier: bool,
    /// The FROM items of the parent scope that the column refs of this scope can see
    pub parent_visibility: SourceVisibility,
    /// The FROM items in FROM order
    pub sources: Vec<ScopeSource>,
}

impl NameScope {
    /// The FROM item with a name
    pub fn source(&self, name: &str) -> Option<&ScopeSource> {
        self.sources.iter().find(|s| s.name.as_deref() == Some(name))
    }
}

/// A candidate owner of an inference constraint
#[derive(Clone, Debug)]
pub struct InferenceCandidate {
    /// The (un-normalized) table name, the identity in the solver
    pub table_name: QualifiedTableName,
    /// The unresolved table reference
    pub table_ref: TableRefId,
}

/// The kind of an inference constraint
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceConstraintKind {
    Forced,
    Disjunctive,
}

/// A schema-inference constraint
#[derive(Clone, Debug)]
pub struct InferenceConstraint {
    /// The kind of the constraint
    pub kind: InferenceConstraintKind,
    /// The column ref expression the constraint was derived from
    pub expression_id: u32,
    /// The column name that must be owned
    pub column_name: Name,
    /// The candidate owner tables, one for a forced constraint
    pub candidates: Vec<InferenceCandidate>,
}

/// An inferred column of an unresolved table
#[derive(Clone, Debug)]
pub struct InferredColumn {
    /// The column name
    pub column_name: Name,
    /// The confidence of the inference
    pub confidence: InferenceConfidence,
    /// The other feasible owner tables of a candidate column, empty if confident
    pub candidate_table_names: Vec<QualifiedTableName>,
}

/// An inferred schema of a table that is not in the catalog
#[derive(Clone, Debug)]
pub struct InferredTableSchema {
    /// The (un-normalized) table name, the identity across statements
    pub table_name: QualifiedTableName,
    /// The confidence of the schema, the maximum over its columns
    pub confidence: InferenceConfidence,
    /// The inferred columns in order of first appearance
    pub columns: Vec<InferredColumn>,
    /// The columns by name (index into the columns)
    pub columns_by_name: HashMap<Arc<str>, usize>,
}

/// A constant expression root
#[derive(Clone, Copy, Debug)]
pub struct ConstantExpression {
    /// The root expression of the constant tree
    pub root: ExprId,
}

/// Binning parameters
#[derive(Clone, Debug, Default)]
pub struct VisBin {
    /// The AST node id of the bin value
    pub ast_node_id: u32,
    /// Whether the input data is already binned
    pub binned: Option<bool>,
    /// An exact step size between bins
    pub step: Option<f64>,
    /// The maximum number of bins
    pub maxbins: Option<f64>,
    /// The minimum allowable step size
    pub minstep: Option<f64>,
    /// A value at which to anchor the bins
    pub anchor: Option<f64>,
    /// The number base for automatic bin determination
    pub base: Option<f64>,
    /// Whether to use nice bin boundaries
    pub nice: Option<bool>,
    /// The AST node id of the extent array
    pub extent_node_id: Option<u32>,
    /// The AST node id of the divide array
    pub divide_node_id: Option<u32>,
    /// The AST node id of the steps array
    pub steps_node_id: Option<u32>,
}

/// A scale definition
#[derive(Clone, Debug, Default)]
pub struct VisScale {
    /// The AST node id of the scale object
    pub ast_node_id: u32,
    /// The scale type (linear, log, pow, sqrt, ...)
    pub scale_type: Option<VisScaleType>,
    /// The AST node id of the domain value
    pub domain_node_id: Option<u32>,
    /// The AST node id of the explicit domain minimum
    pub domain_min_node_id: Option<u32>,
    /// The AST node id of the explicit domain maximum
    pub domain_max_node_id: Option<u32>,
    /// The AST node id of the domain midpoint of a diverging scale
    pub domain_mid_node_id: Option<u32>,
    /// The AST node id of the range value
    pub range_node_id: Option<u32>,
    /// The AST node id of the explicit range minimum
    pub range_min_node_id: Option<u32>,
    /// The AST node id of the explicit range maximum
    pub range_max_node_id: Option<u32>,
    /// The color scheme name
    pub scheme: Option<String>,
    /// The interpolation method of the scale range
    pub interpolate: Option<String>,
    /// Whether to extend the domain to nice round values
    pub nice: Option<bool>,
    /// Whether to include zero in the domain
    pub zero: Option<bool>,
    /// Whether to clamp the output to the range
    pub clamp: Option<bool>,
    /// The padding at both ends of the domain (band/point scales)
    pub padding: Option<f64>,
    /// The inner padding between bands (band scales)
    pub padding_inner: Option<f64>,
    /// The outer padding before the first and after the last band (band scales)
    pub padding_outer: Option<f64>,
    /// Whether to reverse the scale range
    pub reverse: Option<bool>,
    /// Whether to round the output values to integers
    pub round: Option<bool>,
    /// The exponent of a pow scale
    pub exponent: Option<f64>,
    /// The logarithm base of a log scale
    pub base: Option<f64>,
    /// The symlog constant that determines the slope around zero
    pub constant: Option<f64>,
    /// The alignment of steps within the range (band/point scales, 0-1)
    pub align: Option<f64>,
    /// The AST node id of the bins array (quantize scales)
    pub bins_node_id: Option<u32>,
    /// A named reference to the scale
    pub name: Option<String>,
}

/// An axis definition
#[derive(Clone, Debug, Default)]
pub struct VisAxis {
    /// The AST node id of the axis object
    pub ast_node_id: u32,
    /// The axis orientation (top, bottom, left, right)
    pub orient: Option<String>,
    /// The format string of the labels
    pub format: Option<String>,
    /// The format type (number, time, utc)
    pub format_type: Option<String>,
    /// Whether to draw grid lines
    pub grid: Option<bool>,
    /// Whether to draw tick marks
    pub ticks: Option<bool>,
    /// The desired number of ticks
    pub tick_count: Option<f64>,
    /// The size of the tick marks in pixels
    pub tick_size: Option<f64>,
    /// The rotation angle of the labels in degrees
    pub label_angle: Option<f64>,
    /// The font size of the labels in pixels
    pub label_font_size: Option<f64>,
    /// The strategy for overlapping labels (greedy, parity)
    pub label_overlap: Option<String>,
    /// The direction of the axis (horizontal, vertical)
    pub direction: Option<String>,
    /// The offset from the chart edge in pixels
    pub offset: Option<f64>,
    /// The AST node id of the explicit tick values
    pub values_node_id: Option<u32>,
    /// The z-index for layering
    pub zindex: Option<i32>,
    /// The axis title
    pub title: Option<String>,
    /// Whether to draw the domain line
    pub domain: Option<bool>,
    /// A named reference to the axis
    pub name: Option<String>,
}

/// A legend definition
#[derive(Clone, Debug, Default)]
pub struct VisLegend {
    /// The AST node id of the legend object
    pub ast_node_id: u32,
    /// The legend type (symbol, gradient)
    pub legend_type: Option<String>,
    /// The legend orientation (left, right, top, bottom, ...)
    pub orient: Option<String>,
    /// The format string of the labels
    pub format: Option<String>,
    /// The format type (number, time, utc)
    pub format_type: Option<String>,
    /// The layout direction of the entries (horizontal, vertical)
    pub direction: Option<String>,
    /// The legend title
    pub title: Option<String>,
    /// The AST node id of the explicit legend values
    pub values_node_id: Option<u32>,
    /// The padding around the legend in pixels
    pub padding: Option<f64>,
    /// The offset from the default position in pixels
    pub offset: Option<f64>,
    /// The z-index for layering
    pub zindex: Option<i32>,
    /// A named reference to the legend
    pub name: Option<String>,
}

/// A mark definition
#[derive(Clone, Debug, Default)]
pub struct VisMark {
    /// The AST node id of the mark object
    pub ast_node_id: u32,
    /// The mark type (bar, line, point, area, ...)
    pub mark_type: Option<VisMarkType>,
    /// Whether the mark is filled instead of stroke-only
    pub filled: Option<bool>,
    /// The fill color
    pub fill: Option<String>,
    /// The stroke color
    pub stroke: Option<String>,
    /// The default color, fill or stroke depending on the mark
    pub color: Option<String>,
    /// The overall opacity
    pub opacity: Option<f64>,
    /// The fill opacity
    pub fill_opacity: Option<f64>,
    /// The stroke opacity
    pub stroke_opacity: Option<f64>,
    /// The stroke width in pixels
    pub stroke_width: Option<f64>,
    /// The AST node id of the stroke dash array
    pub stroke_dash_node_id: Option<u32>,
    /// The mark size, the area in pixels for point marks
    pub size: Option<f64>,
    /// The shape of point marks (circle, square, cross, ...)
    pub shape: Option<String>,
    /// The rotation angle in degrees
    pub angle: Option<f64>,
    /// The polar radius of arc/text marks
    pub radius: Option<f64>,
    /// The corner radius of bar/rect marks
    pub corner_radius: Option<f64>,
    /// The orientation (horizontal, vertical)
    pub orient: Option<String>,
    /// The line interpolation method (linear, monotone, step, ...)
    pub interpolate: Option<String>,
    /// The line tension of spline interpolation (0-1)
    pub tension: Option<f64>,
    /// The tick/rule thickness in pixels
    pub thickness: Option<f64>,
    /// Whether to show tooltips
    pub tooltip: Option<bool>,
    /// The point overlay toggle, if given as a boolean
    pub point_enabled: Option<bool>,
    /// The point overlay, if given as a mark object
    pub point: Option<Box<VisMark>>,
    /// The line overlay toggle, if given as a boolean
    pub line_enabled: Option<bool>,
    /// The line overlay, if given as a mark object
    pub line: Option<Box<VisMark>>,
}

impl VisMark {
    /// Whether the mark carries any property beyond a bare type
    pub fn has_properties(&self) -> bool {
        self.filled.is_some()
            || self.fill.is_some()
            || self.stroke.is_some()
            || self.color.is_some()
            || self.opacity.is_some()
            || self.fill_opacity.is_some()
            || self.stroke_opacity.is_some()
            || self.stroke_width.is_some()
            || self.stroke_dash_node_id.is_some()
            || self.size.is_some()
            || self.shape.is_some()
            || self.angle.is_some()
            || self.radius.is_some()
            || self.corner_radius.is_some()
            || self.orient.is_some()
            || self.interpolate.is_some()
            || self.tension.is_some()
            || self.thickness.is_some()
            || self.tooltip.is_some()
            || self.point_enabled.is_some()
            || self.point.is_some()
            || self.line_enabled.is_some()
            || self.line.is_some()
    }
}

/// An encoding channel
#[derive(Clone, Debug, Default)]
pub struct VisEncodingChannel {
    /// The channel attribute key (VIS_ENCODING_X, VIS_ENCODING_Y, ...)
    pub channel_key: AttributeKey,
    /// The AST node id of the field def or shorthand column ref
    pub ast_node_id: u32,
    /// The expression id of the field column ref
    pub field_expression_id: Option<u32>,
    /// The AST node id of the field value of a nested spec, which has no expression
    pub field_node_id: Option<u32>,
    /// The field type (nominal, ordinal, quantitative, temporal, geojson)
    pub field_type: Option<VisFieldType>,
    /// The aggregate function name (sum, mean, count, ...)
    pub aggregate: Option<String>,
    /// The bin parameters, present if binning is enabled
    pub bin: Option<VisBin>,
    /// The time unit of a temporal field (year, month, day, ...)
    pub time_unit: Option<String>,
    /// The AST node id of the stack value
    pub stack_node_id: Option<u32>,
    /// The scale definition of the channel
    pub scale: Option<VisScale>,
    /// The axis definition of the channel
    pub axis: Option<VisAxis>,
    /// The legend definition of the channel
    pub legend: Option<VisLegend>,
}

/// Composition resolution settings
#[derive(Clone, Debug, Default)]
pub struct VisResolve {
    /// The AST node id of the scale resolution
    pub scale_node_id: Option<u32>,
    /// The AST node id of the axis resolution
    pub axis_node_id: Option<u32>,
    /// The AST node id of the legend resolution
    pub legend_node_id: Option<u32>,
}

/// A nested Vega-Lite specification
#[derive(Clone, Debug, Default)]
pub struct VegaLiteSpec {
    /// The mark type
    pub mark_type: Option<VisMarkType>,
    /// The structured mark definition, if the mark is an object
    pub mark: Option<VisMark>,
    /// The encoding channels
    pub encoding_channels: Vec<VisEncodingChannel>,
    /// The nested layer specifications
    pub layers: Vec<VegaLiteSpec>,
    /// The scale/axis/legend resolution settings
    pub resolve: Option<VisResolve>,
    /// The title
    pub title: Option<String>,
}

/// Dashboard placement
#[derive(Clone, Debug)]
pub struct DashboardSpec {
    /// The grid row, None for automatic placement
    pub row: Option<i32>,
    /// The grid column (0-11), None for automatic placement
    pub column: Option<i32>,
    /// The width in grid columns (1-12)
    pub width: i32,
    /// The height in grid rows (at least 1)
    pub height: i32,
}

impl Default for DashboardSpec {
    fn default() -> Self {
        Self {
            row: None,
            column: None,
            width: 6,
            height: 3,
        }
    }
}

/// UMAP projection parameters
#[derive(Clone, Debug, Default)]
pub struct UmapProjection {
    /// The distance metric (e.g. `cosine`, `euclidean`)
    pub metric: Option<String>,
    /// The number of neighbors (UMAP nNeighbors)
    pub neighbors: Option<f64>,
    /// The minimum distance (UMAP minDist)
    pub min_dist: Option<f64>,
}

/// A UMAP spec
#[derive(Clone, Debug, Default)]
pub struct UmapSpec {
    /// The AST node id of the UMAP spec object
    pub ast_node_id: u32,
    /// The expression id of the `vector` column
    pub vector_expression_id: Option<u32>,
    /// The expression id of the optional `category` column
    pub category_expression_id: Option<u32>,
    /// The expression id of the optional `label` column
    pub label_expression_id: Option<u32>,
    /// The projection parameters
    pub projection: UmapProjection,
}

/// A Markdown spec
#[derive(Clone, Debug, Default)]
pub struct MarkdownSpec {
    /// The AST node id of the Markdown spec object
    pub ast_node_id: u32,
    /// The row template, decoded from its SQL string literal
    pub row_template: String,
}

/// The kind of the source of a VISUALIZE statement
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum VisSourceKind {
    #[default]
    Unresolved = 0,
    TableReference = 1,
    ScriptReference = 2,
    InlineSelect = 3,
}

/// The resolved source of a VISUALIZE statement
#[derive(Clone, Copy, Debug, Default)]
pub struct ResolvedVisSource {
    /// The kind of the source
    pub kind: VisSourceKind,
    /// The AST node id of the input query of an inline select
    pub inline_select_ast_node_id: Option<u32>,
}

/// A visualization specification
#[derive(Clone, Debug, Default)]
pub struct VisualizationSpec {
    /// The AST node id of the VISUALIZE object
    pub ast_node_id: u32,
    /// The AST statement id
    pub ast_statement_id: Option<u32>,
    /// The renderer named after `USING` (e.g. `vegalite`)
    pub renderer: Option<String>,
    /// The mark type
    pub mark_type: Option<VisMarkType>,
    /// The structured mark definition, if the mark is an object
    pub mark: Option<VisMark>,
    /// The AST node id of the input query
    pub source_node_id: Option<u32>,
    /// The resolved source, set during finish
    pub resolved_source: ResolvedVisSource,
    /// The encoding channels that map columns to visual properties
    pub encoding_channels: Vec<VisEncodingChannel>,
    /// The chart title
    pub title: Option<String>,
    /// The dashboard grid placement
    pub dashboard: DashboardSpec,
    /// The nested Vega-Lite layer specifications
    pub layers: Vec<VegaLiteSpec>,
    /// The Vega-Lite scale/axis/legend resolution settings
    pub resolve: Option<VisResolve>,
    /// The UMAP spec, present if the spec is a UMAP spec
    pub umap: Option<UmapSpec>,
    /// The Markdown spec, present if the spec is a Markdown spec
    pub markdown: Option<MarkdownSpec>,
}
