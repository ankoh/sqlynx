//! The analyzer types, a port of `include/dashql/analyzer/analyzer_types.h`.
//!
//! The C++ types link each other through references and intrusive lists. Here every object lives in
//! an arena of the analyzed script and is referenced by its index.

use crate::catalog::*;
use dashql_buffers::algebra::{BinaryExpressionFunction, ComparisonFunction, LiteralType};
use dashql_buffers::analyzer::{AnalyzerErrorSeverity, AnalyzerErrorType};
use dashql_buffers::parser::{AttributeKey, IntervalType as IntervalTypeEnum, KnownFunction, SymbolSpan, VisFieldType, VisMarkType, VisScaleType};
use dashql_grammar::span::TextSpan;
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
    entries: Vec<(Arc<str>, V)>,
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
    pub error_type: AnalyzerErrorType,
    pub severity: AnalyzerErrorSeverity,
    pub ast_node_id: u32,
    pub symbol_span: Option<SymbolSpan>,
    pub text_span: Option<TextSpan>,
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
    pub table_name: QualifiedTableName,
    pub catalog_schema_id: QualifiedCatalogObjectId,
    pub catalog_table_id: QualifiedCatalogObjectId,
    pub referenced_catalog_version: CatalogVersion,
}

/// A relation expression
#[derive(Clone, Debug)]
pub struct RelationExpression {
    pub table_name: QualifiedTableName,
    pub resolved_table: Option<ResolvedTableEntry>,
    /// The ambiguous matches
    pub resolved_alternatives: Vec<ResolvedTableEntry>,
}

/// A table reference
#[derive(Clone, Debug)]
pub struct TableReference {
    pub table_reference_id: ExternalObjectId,
    pub ast_node_id: u32,
    pub location: Option<SymbolSpan>,
    pub ast_statement_id: Option<u32>,
    pub ast_scope_root: Option<u32>,
    /// The alias name and its location
    pub alias: Option<(Name, SymbolSpan)>,
    pub inner: Option<RelationExpression>,
    pub role: TableRole,
}

/// An explicit INSERT target column
#[derive(Clone, Debug)]
pub struct InsertTargetColumn {
    pub ast_node_id: u32,
    pub column_name: Name,
    pub resolved: Option<ColumnLoc>,
}

/// An INSERT statement
#[derive(Clone, Debug)]
pub struct InsertStatement {
    pub ast_node_id: u32,
    pub ast_statement_id: Option<u32>,
    pub target: TableRefId,
    pub source_ast_node_id: Option<u32>,
    pub default_values: bool,
    pub returning: bool,
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
    pub table_ref: TableRefId,
    pub table_name: QualifiedTableName,
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
    pub catalog_schema_id: QualifiedCatalogObjectId,
    pub catalog_table_column_id: QualifiedCatalogObjectId,
    pub referenced_catalog_version: CatalogVersion,
}

/// A column reference
#[derive(Clone, Debug)]
pub struct ColumnRef {
    pub column_name: QualifiedColumnName,
    pub ast_scope_root: Option<u32>,
    pub resolved: ColumnResolution,
    /// The catalog ids behind the resolution, computed once the analysis is done
    /// (`GetResolvedColumnIDs` follows scope columns through their source expressions)
    pub resolved_ids: Option<ResolvedColumnIds>,
    pub inferred: Option<InferredOwner>,
}

/// A literal
#[derive(Clone, Debug)]
pub struct Literal {
    pub literal_type: LiteralType,
    /// The raw value in the script text
    pub raw_value: TextSpan,
}

/// A comparison
#[derive(Clone, Copy, Debug)]
pub struct Comparison {
    pub func: ComparisonFunction,
    pub left_expression_id: u32,
    pub right_expression_id: u32,
}

/// A binary expression
#[derive(Clone, Copy, Debug)]
pub struct BinaryExpression {
    pub func: BinaryExpressionFunction,
    pub left_expression_id: u32,
    pub right_expression_id: u32,
}

/// A function argument
#[derive(Clone, Debug)]
pub struct FunctionArgument {
    pub ast_node_id: u32,
    pub value_ast_node_id: u32,
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
    pub function_name: FunctionName,
    pub function_call_modifiers: u8,
    pub arguments: FunctionArguments,
}

/// An interval type
#[derive(Clone, Copy, Debug)]
pub struct IntervalType {
    pub interval_type: IntervalTypeEnum,
    pub precision_expression: Option<i32>,
}

/// A constant interval cast
#[derive(Clone, Copy, Debug)]
pub struct ConstIntervalCast {
    pub value_expression_id: u32,
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
    pub expression_id: u32,
    pub ast_node_id: u32,
    pub location: Option<SymbolSpan>,
    pub ast_statement_id: Option<u32>,
    pub inner: ExpressionInner,
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
    pub ast_node_id: u32,
    pub column_name: Option<Name>,
    pub expression_id: Option<u32>,
    pub is_star: bool,
}

/// The source of a scope output column
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeColumnSource {
    Expression(ExprId),
    TableColumn(ColumnLoc),
}

/// An output column of a scope
#[derive(Clone, Debug)]
pub struct ScopeColumn {
    pub column_name: Name,
    pub source: ScopeColumnSource,
}

/// A CTE definition in the AST
#[derive(Clone, Debug)]
pub struct CteDefinition {
    pub cte_name: Name,
    pub select_node_id: u32,
    pub columns_node_id: u32,
    pub columns_count: u16,
    pub ast_node_id: u32,
}

/// A CTE attached to a scope
#[derive(Clone, Debug)]
pub struct ResolvedCte {
    pub cte_name: Name,
    pub child_scope: Option<ScopeId>,
    pub definition_node_id: u32,
    pub column_aliases: Vec<Name>,
}

/// A CTE location: the scope that defines it and its index in the CTEs of that scope
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CteLoc {
    pub scope: ScopeId,
    pub index: u32,
}

/// An unresolved table in scope
#[derive(Clone, Debug)]
pub struct UnresolvedRelation {
    pub table_ref: TableRefId,
    pub table_name: QualifiedTableName,
}

/// A table-like source in scope
#[derive(Clone, Debug)]
pub enum ReferencedTable {
    Table(TableLoc),
    Cte(CteLoc),
    Unresolved(UnresolvedRelation),
}

impl ReferencedTable {
    pub fn is_unresolved_relation(&self) -> bool {
        matches!(self, ReferencedTable::Unresolved(_))
    }
}

/// A naming scope
#[derive(Clone, Debug, Default)]
pub struct NameScope {
    pub name_scope_id: u32,
    pub ast_node_id: u32,
    pub ast_statement_id: u32,
    pub parent_scope: Option<ScopeId>,
    pub child_scopes: Vec<ScopeId>,
    /// The column references of the scope
    pub expressions: Vec<ExprId>,
    pub table_references: Vec<TableRefId>,
    pub result_targets: Vec<ResultTarget>,
    pub output_columns: Vec<ScopeColumn>,
    pub output_columns_by_name: HashMap<Arc<str>, usize>,
    pub cte_definitions: OrderedMap<ResolvedCte>,
    pub cte_definition_nodes: HashMap<Arc<str>, u32>,
    pub ctes_recursive: bool,
    pub child_output_resolution_barrier: bool,
    pub column_correlation_barrier: bool,
    pub referenced_tables_by_name: OrderedMap<ReferencedTable>,
}

/// A candidate owner of an inference constraint
#[derive(Clone, Debug)]
pub struct InferenceCandidate {
    pub table_name: QualifiedTableName,
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
    pub kind: InferenceConstraintKind,
    pub expression_id: u32,
    pub column_name: Name,
    pub candidates: Vec<InferenceCandidate>,
}

/// An inferred column of an unresolved table
#[derive(Clone, Debug)]
pub struct InferredColumn {
    pub column_name: Name,
    pub confidence: InferenceConfidence,
    pub candidate_table_names: Vec<QualifiedTableName>,
}

/// An inferred schema of a table that is not in the catalog
#[derive(Clone, Debug)]
pub struct InferredTableSchema {
    pub table_name: QualifiedTableName,
    pub confidence: InferenceConfidence,
    pub columns: Vec<InferredColumn>,
    pub columns_by_name: HashMap<Arc<str>, usize>,
}

/// A constant expression root
#[derive(Clone, Copy, Debug)]
pub struct ConstantExpression {
    pub root: ExprId,
}

/// Binning parameters
#[derive(Clone, Debug, Default)]
pub struct VisBin {
    pub ast_node_id: u32,
    pub binned: Option<bool>,
    pub step: Option<f64>,
    pub maxbins: Option<f64>,
    pub minstep: Option<f64>,
    pub anchor: Option<f64>,
    pub base: Option<f64>,
    pub nice: Option<bool>,
    pub extent_node_id: Option<u32>,
    pub divide_node_id: Option<u32>,
    pub steps_node_id: Option<u32>,
}

/// A scale definition
#[derive(Clone, Debug, Default)]
pub struct VisScale {
    pub ast_node_id: u32,
    pub scale_type: Option<VisScaleType>,
    pub domain_node_id: Option<u32>,
    pub domain_min_node_id: Option<u32>,
    pub domain_max_node_id: Option<u32>,
    pub domain_mid_node_id: Option<u32>,
    pub range_node_id: Option<u32>,
    pub range_min_node_id: Option<u32>,
    pub range_max_node_id: Option<u32>,
    pub scheme: Option<String>,
    pub interpolate: Option<String>,
    pub nice: Option<bool>,
    pub zero: Option<bool>,
    pub clamp: Option<bool>,
    pub padding: Option<f64>,
    pub padding_inner: Option<f64>,
    pub padding_outer: Option<f64>,
    pub reverse: Option<bool>,
    pub round: Option<bool>,
    pub exponent: Option<f64>,
    pub base: Option<f64>,
    pub constant: Option<f64>,
    pub align: Option<f64>,
    pub bins_node_id: Option<u32>,
    pub name: Option<String>,
}

/// An axis definition
#[derive(Clone, Debug, Default)]
pub struct VisAxis {
    pub ast_node_id: u32,
    pub orient: Option<String>,
    pub format: Option<String>,
    pub format_type: Option<String>,
    pub grid: Option<bool>,
    pub ticks: Option<bool>,
    pub tick_count: Option<f64>,
    pub tick_size: Option<f64>,
    pub label_angle: Option<f64>,
    pub label_font_size: Option<f64>,
    pub label_overlap: Option<String>,
    pub direction: Option<String>,
    pub offset: Option<f64>,
    pub values_node_id: Option<u32>,
    pub zindex: Option<i32>,
    pub title: Option<String>,
    pub domain: Option<bool>,
    pub name: Option<String>,
}

/// A legend definition
#[derive(Clone, Debug, Default)]
pub struct VisLegend {
    pub ast_node_id: u32,
    pub legend_type: Option<String>,
    pub orient: Option<String>,
    pub format: Option<String>,
    pub format_type: Option<String>,
    pub direction: Option<String>,
    pub title: Option<String>,
    pub values_node_id: Option<u32>,
    pub padding: Option<f64>,
    pub offset: Option<f64>,
    pub zindex: Option<i32>,
    pub name: Option<String>,
}

/// A mark definition
#[derive(Clone, Debug, Default)]
pub struct VisMark {
    pub ast_node_id: u32,
    pub mark_type: Option<VisMarkType>,
    pub filled: Option<bool>,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub color: Option<String>,
    pub opacity: Option<f64>,
    pub fill_opacity: Option<f64>,
    pub stroke_opacity: Option<f64>,
    pub stroke_width: Option<f64>,
    pub stroke_dash_node_id: Option<u32>,
    pub size: Option<f64>,
    pub shape: Option<String>,
    pub angle: Option<f64>,
    pub radius: Option<f64>,
    pub corner_radius: Option<f64>,
    pub orient: Option<String>,
    pub interpolate: Option<String>,
    pub tension: Option<f64>,
    pub thickness: Option<f64>,
    pub tooltip: Option<bool>,
    pub point_enabled: Option<bool>,
    pub point: Option<Box<VisMark>>,
    pub line_enabled: Option<bool>,
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
    pub channel_key: AttributeKey,
    pub ast_node_id: u32,
    pub field_expression_id: Option<u32>,
    pub field_node_id: Option<u32>,
    pub field_type: Option<VisFieldType>,
    pub aggregate: Option<String>,
    pub bin: Option<VisBin>,
    pub time_unit: Option<String>,
    pub stack_node_id: Option<u32>,
    pub scale: Option<VisScale>,
    pub axis: Option<VisAxis>,
    pub legend: Option<VisLegend>,
}

/// Composition resolution settings
#[derive(Clone, Debug, Default)]
pub struct VisResolve {
    pub scale_node_id: Option<u32>,
    pub axis_node_id: Option<u32>,
    pub legend_node_id: Option<u32>,
}

/// A nested Vega-Lite specification
#[derive(Clone, Debug, Default)]
pub struct VegaLiteSpec {
    pub mark_type: Option<VisMarkType>,
    pub mark: Option<VisMark>,
    pub encoding_channels: Vec<VisEncodingChannel>,
    pub layers: Vec<VegaLiteSpec>,
    pub resolve: Option<VisResolve>,
    pub title: Option<String>,
}

/// Dashboard placement
#[derive(Clone, Debug)]
pub struct DashboardSpec {
    pub row: Option<i32>,
    pub column: Option<i32>,
    pub width: i32,
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
    pub metric: Option<String>,
    pub neighbors: Option<f64>,
    pub min_dist: Option<f64>,
}

/// A UMAP spec
#[derive(Clone, Debug, Default)]
pub struct UmapSpec {
    pub ast_node_id: u32,
    pub vector_expression_id: Option<u32>,
    pub category_expression_id: Option<u32>,
    pub label_expression_id: Option<u32>,
    pub projection: UmapProjection,
}

/// A Markdown spec
#[derive(Clone, Debug, Default)]
pub struct MarkdownSpec {
    pub ast_node_id: u32,
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
    pub kind: VisSourceKind,
    pub inline_select_ast_node_id: Option<u32>,
}

/// A visualization specification
#[derive(Clone, Debug, Default)]
pub struct VisualizationSpec {
    pub ast_node_id: u32,
    pub ast_statement_id: Option<u32>,
    pub renderer: Option<String>,
    pub mark_type: Option<VisMarkType>,
    pub mark: Option<VisMark>,
    pub source_node_id: Option<u32>,
    pub resolved_source: ResolvedVisSource,
    pub encoding_channels: Vec<VisEncodingChannel>,
    pub title: Option<String>,
    pub dashboard: DashboardSpec,
    pub layers: Vec<VegaLiteSpec>,
    pub resolve: Option<VisResolve>,
    pub umap: Option<UmapSpec>,
    pub markdown: Option<MarkdownSpec>,
}
