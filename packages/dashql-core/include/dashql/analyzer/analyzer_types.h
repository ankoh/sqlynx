#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <type_traits>
#include <unordered_map>

#include "ankerl/unordered_dense.h"
#include <variant>
#include <vector>

#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/external.h"
#include "dashql/utils/intrusive_list.h"

namespace dashql {

namespace sx = buffers;

// Convenience aliases for qualified names from CatalogEntry
using QualifiedTableName = CatalogEntry::QualifiedTableName;
using QualifiedColumnName = CatalogEntry::QualifiedColumnName;
using QualifiedFunctionName = CatalogEntry::QualifiedFunctionName;

/// A table reference
struct TableReference : public IntrusiveListNode {
    enum class Role : uint8_t { Read = 0, Write = 1 };
    /// A resolved table entry
    struct ResolvedTableEntry {
        /// The table name, may refer to different catalog entry
        QualifiedTableName table_name;
        /// The resolved schema in the catalog
        QualifiedCatalogObjectID catalog_schema_id;
        /// The resolved table id in the catalog
        QualifiedCatalogObjectID catalog_table_id;
        /// The catalog version of this resolved column
        CatalogVersion referenced_catalog_version = 0;
    };
    /// A relation expression
    struct RelationExpression {
        /// The table name, may refer to different catalog entry
        QualifiedTableName table_name;
        /// THe resolved relation
        std::optional<ResolvedTableEntry> resolved_table;
        /// The ambiguous matches (if any)
        std::vector<ResolvedTableEntry> resolved_alternatives;
    };

    /// The table reference id
    ExternalObjectID table_reference_id;
    /// The AST node id in the target script
    uint32_t ast_node_id;
    /// The location in the target script
    std::optional<sx::parser::SymbolSpan> location;
    /// The AST statement id in the target script
    std::optional<uint32_t> ast_statement_id;
    /// The AST scope root in the target script
    std::optional<uint32_t> ast_scope_root;
    /// The alias name, may refer to different catalog entry
    /// We track alias locations explicitly since we want to treat aliases differently during completion.
    std::optional<std::pair<std::reference_wrapper<RegisteredName>, sx::parser::SymbolSpan>> alias;
    /// The inner relation type
    std::variant<std::monostate, RelationExpression> inner;
    /// Whether this reference reads from or writes to the table
    Role role = Role::Read;

    /// Constructor
    TableReference(std::optional<std::pair<std::reference_wrapper<RegisteredName>, sx::parser::SymbolSpan>> alias)
        : alias(alias) {}
    /// Pack as FlatBuffer
    flatbuffers::Offset<buffers::analyzer::TableReference> Pack(flatbuffers::FlatBufferBuilder& builder) const;
};

/// An explicit INSERT destination column.
struct InsertTargetColumn {
    uint32_t ast_node_id = 0;
    std::reference_wrapper<RegisteredName> column_name;
    std::optional<std::reference_wrapper<const CatalogEntry::TableColumn>> resolved;
};

/// Resolved structure of an INSERT statement.
struct InsertStatement {
    uint32_t ast_node_id = 0;
    std::optional<uint32_t> ast_statement_id;
    std::reference_wrapper<TableReference> target;
    std::optional<uint32_t> source_ast_node_id;
    bool default_values = false;
    bool returning = false;
    std::vector<InsertTargetColumn> target_columns;
};

struct ScopeColumn;

/// The confidence of a schema-inference result.
/// Kept trivially-copyable; mirrored on the wire by buffers::analyzer::InferenceConfidence.
enum class InferenceConfidence : uint8_t {
    /// No inference
    NONE = 0,
    /// Owner is one of several feasible unresolved tables (ambiguous, best-guess only)
    CANDIDATE = 1,
    /// Owner is forced (alias-qualified, or uniquely determined by constraint propagation)
    CONFIDENT = 2,
};

/// The inferred owner of an unresolved column, written back by the schema-inference solver.
/// Trivially destructible so that Expression remains trivially destructible.
struct InferredOwner {
    /// The unresolved table reference that owns this column (ChunkBuffer-stable)
    std::reference_wrapper<TableReference> table_ref;
    /// The (un-normalized) table name of the owner
    QualifiedTableName table_name;
    /// The confidence of the assignment
    InferenceConfidence confidence = InferenceConfidence::NONE;
};

/// An expression
struct Expression : public IntrusiveListNode {
    using TableColumn = CatalogEntry::TableColumn;

    /// Catalog IDs extracted from a resolved column (used for serialization)
    struct ResolvedColumnIDs {
        /// The catalog id of the schema
        QualifiedCatalogObjectID catalog_schema_id;
        /// The catalog id of table column
        QualifiedCatalogObjectID catalog_table_column_id;
        /// The referenced catalog version
        CatalogVersion referenced_catalog_version = 0;
    };
    /// An unresolved column reference
    struct ColumnRef {
        /// A column ref can either resolve to a table column or a scope column
        using ResolvedVariant = std::variant<std::monostate, std::reference_wrapper<const TableColumn>,
                                             std::reference_wrapper<const ScopeColumn>>;

        /// The column name, may refer to different catalog entry
        QualifiedColumnName column_name;
        /// The AST scope root in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The resolution state: unresolved, resolved to a catalog table column, or resolved to a scope output column
        ResolvedVariant resolved;
        /// The inferred owner (only for columns that stay unresolved but are associated with an
        /// unresolved table during schema inference). Does NOT affect IsResolved().
        std::optional<InferredOwner> inferred;

        bool IsResolved() const { return !std::holds_alternative<std::monostate>(resolved); }
        bool IsInferred() const { return inferred.has_value(); }
        std::optional<ResolvedColumnIDs> GetResolvedColumnIDs() const;
    };
    /// A literal
    struct Literal {
        /// The literal type
        buffers::algebra::LiteralType literal_type = buffers::algebra::LiteralType::NULL_;
        /// The raw value
        std::string_view raw_value;
    };
    /// A comparison
    struct Comparison {
        /// The comparison function
        buffers::algebra::ComparisonFunction func = buffers::algebra::ComparisonFunction::UNKNOWN;
        /// The expression id of the left child
        uint32_t left_expression_id = 0;
        /// The expression id of the right child
        uint32_t right_expression_id = 0;
    };
    /// A binary expression
    struct BinaryExpression {
        /// The binary expression function
        buffers::algebra::BinaryExpressionFunction func = buffers::algebra::BinaryExpressionFunction::UNKNOWN;
        /// The expression id of the left child
        uint32_t left_expression_id = 0;
        /// The expression id of the right child
        uint32_t right_expression_id = 0;
    };
    /// A function argument expression?
    struct FunctionArgument {
        /// The ast node id of the argument
        uint32_t ast_node_id = 0;
        /// The ast node id of the argument value
        uint32_t value_ast_node_id = 0;
        /// The name (if the argument is named)
        std::optional<std::reference_wrapper<RegisteredName>> name;
        /// The expression id (if mapped)
        std::optional<uint32_t> expression_id = 0;
    };
    struct FunctionCastArguments {};
    /// A function call expression
    struct FunctionCallExpression {
        /// Generic argument list
        using GenericArguments = std::span<FunctionArgument>;
        /// CAST arguments
        struct CastArguments {};
        /// EXTRACT arguments
        struct ExtractArguments {};
        /// OVERLAY arguments
        struct OverlayArguments {};
        /// POSITION arguments
        struct PositionArguments {};
        /// SUBSTRING arguments
        struct SubstringArguments {};
        /// TRIM arguments
        struct TrimArguments {
            buffers::parser::TrimDirection direction;
        };
        /// TREAT arguments
        struct TreatArguments {};

        /// The qualified function name
        std::variant<buffers::parser::KnownFunction, QualifiedFunctionName> function_name =
            buffers::parser::KnownFunction::CURRENT_TIME;
        /// The type modifiers
        uint8_t function_call_modifiers = 0;
        /// The arguments (if any)
        std::variant<std::monostate, GenericArguments, CastArguments, ExtractArguments, OverlayArguments,
                     PositionArguments, SubstringArguments, TrimArguments, TreatArguments>
            arguments = std::monostate{};
    };
    /// An interval type
    struct IntervalType {
        /// The interval type
        dashql::buffers::parser::IntervalType interval_type;
        /// The expression for the interval precision (if any)
        std::optional<int32_t> precision_expression;
    };
    /// A constant interval cast
    struct ConstIntervalCast {
        /// The expression id of the value
        uint32_t value_expression_id;
        // The interval type (if not in the value text)
        std::optional<IntervalType> interval;
    };

    /// The expression id as reference_index
    uint32_t expression_id;
    /// The AST node id in the target script
    uint32_t ast_node_id;
    /// The location in the target script
    std::optional<sx::parser::SymbolSpan> location;
    /// The AST statement id in the target script
    std::optional<uint32_t> ast_statement_id;
    /// The inner expression type
    std::variant<std::monostate, ColumnRef, Literal, Comparison, BinaryExpression, FunctionCallExpression,
                 ConstIntervalCast>
        inner;
    /// Is the expression a constant?
    bool is_constant_expression = false;

    /// Constructor
    Expression() : inner(std::monostate{}) {}
    // Check if the expression is a column ref
    inline bool IsColumnRef() const { return std::holds_alternative<ColumnRef>(inner); }
    // Check if the expression is a literal
    inline bool IsLiteral() const { return std::holds_alternative<Literal>(inner); }
    // Check if the expression is a constant
    inline bool IsConstantExpression() const { return is_constant_expression; }
    /// Pack as FlatBuffer
    flatbuffers::Offset<buffers::algebra::Expression> Pack(flatbuffers::FlatBufferBuilder& builder) const;
};
static_assert(std::is_trivially_destructible_v<Expression>, "Expressions should remain destructable");

/// A result target
struct ResultTarget : public IntrusiveListNode {
    /// The AST node id
    uint32_t ast_node_id = 0;
    /// The output column name (alias if provided, otherwise inferred from expression)
    std::optional<std::reference_wrapper<RegisteredName>> column_name;
    /// The expression id (if not a star)
    std::optional<uint32_t> expression_id;
    /// Is a star expression?
    bool is_star = false;
};

/// An output column declared by a scope
struct ScopeColumn {
    using TableColumn = CatalogEntry::TableColumn;

    /// The column name
    std::reference_wrapper<RegisteredName> column_name;
    /// The source:
    /// - Either an expression (e.g. column ref)
    /// - Or a direct table column (select *)
    std::variant<std::reference_wrapper<Expression>, std::reference_wrapper<const TableColumn>> source;

    /// Get the resolved catalog IDs (reads live state from the source)
    std::optional<Expression::ResolvedColumnIDs> GetResolvedIDs() const;
};

inline std::optional<Expression::ResolvedColumnIDs> Expression::ColumnRef::GetResolvedColumnIDs() const {
    auto* current = &resolved;
    for (size_t depth = 0; depth < 256; ++depth) {
        if (auto* tc = std::get_if<std::reference_wrapper<const TableColumn>>(current)) {
            auto& col = tc->get();
            auto& table = col.table->get();
            return ResolvedColumnIDs{
                .catalog_schema_id = table.catalog_schema_id,
                .catalog_table_column_id = col.object_id,
                .referenced_catalog_version = table.catalog_version,
            };
        }
        auto* scope_ref = std::get_if<std::reference_wrapper<const ScopeColumn>>(current);
        if (!scope_ref) return std::nullopt;

        auto* scope = &scope_ref->get();
        if (auto* tc = std::get_if<std::reference_wrapper<const TableColumn>>(&scope->source)) {
            auto& col = tc->get();
            auto& table = col.table->get();
            return ResolvedColumnIDs{
                .catalog_schema_id = table.catalog_schema_id,
                .catalog_table_column_id = col.object_id,
                .referenced_catalog_version = table.catalog_version,
            };
        }
        auto& expression = std::get<std::reference_wrapper<Expression>>(scope->source).get();
        auto* column_ref = std::get_if<ColumnRef>(&expression.inner);
        if (!column_ref) return std::nullopt;
        current = &column_ref->resolved;
    }
    return std::nullopt;
}

inline std::optional<Expression::ResolvedColumnIDs> ScopeColumn::GetResolvedIDs() const {
    if (auto* table_ref = std::get_if<std::reference_wrapper<const TableColumn>>(&source)) {
        auto& col = table_ref->get();
        auto& table = col.table->get();
        return Expression::ResolvedColumnIDs{
            .catalog_schema_id = table.catalog_schema_id,
            .catalog_table_column_id = col.object_id,
            .referenced_catalog_version = table.catalog_version,
        };
    }
    auto& expression = std::get<std::reference_wrapper<Expression>>(source).get();
    auto* column_ref = std::get_if<Expression::ColumnRef>(&expression.inner);
    return column_ref ? column_ref->GetResolvedColumnIDs() : std::nullopt;
}

struct NameScope;

/// A CTE definition
struct CTEDefinition : public IntrusiveListNode {
    /// The CTE name
    std::reference_wrapper<RegisteredName> cte_name;
    /// The AST node id of the CTE's inner SELECT statement
    uint32_t select_node_id = 0;
    /// The AST node id of the CTE columns array (0 if none)
    uint32_t columns_node_id = 0;
    /// The number of column aliases
    uint16_t columns_count = 0;
    /// The AST node id of the CTE definition
    uint32_t ast_node_id = 0;
};

/// A resolved CTE with its associated scope and column aliases
struct ResolvedCTE {
    /// The CTE name
    std::reference_wrapper<RegisteredName> cte_name;
    /// The child scope containing the CTE's SELECT
    NameScope* child_scope = nullptr;
    /// The AST node id of the CTE definition
    uint32_t definition_node_id = 0;
    /// Optional column aliases (override the SELECT's output column names)
    std::vector<std::reference_wrapper<RegisteredName>> column_aliases;
};

/// An unresolved table-like source in scope.
/// The table name is not present in the catalog, but we still register it by alias so that
/// columns used against it can be *associated* (not resolved) for schema inference.
struct UnresolvedRelation {
    /// The table reference that introduced this relation (ChunkBuffer-stable)
    std::reference_wrapper<TableReference> table_ref;
    /// The (un-normalized) table name, used as the identity for schema inference
    QualifiedTableName table_name;
};

/// A table-like source in scope (a catalog table, a CTE, or an unresolved relation)
struct ReferencedTable {
    std::variant<std::reference_wrapper<const CatalogEntry::TableDeclaration>, std::reference_wrapper<ResolvedCTE>,
                 UnresolvedRelation>
        source;

    /// Result of resolving a column name against this table
    using ColumnResolution = Expression::ColumnRef::ResolvedVariant;
    /// Look up a column by name. Returns monostate if not found.
    ColumnResolution ResolveColumn(std::string_view column_name) const;
    /// Is this an unresolved relation (in scope, but not present in the catalog)?
    bool IsUnresolvedRelation() const { return std::holds_alternative<UnresolvedRelation>(source); }
};

/// A naming scope
struct NameScope : public IntrusiveListNode {
    /// The id of the scope (== scope index in the script)
    size_t name_scope_id;
    /// The AST scope root
    size_t ast_node_id;
    /// The AST statement id
    size_t ast_statement_id;
    /// The parent scope
    NameScope* parent_scope;
    /// The child scopes
    IntrusiveList<IntrusiveListNode> child_scopes;
    /// The column references in this scope
    IntrusiveList<Expression> expressions;
    /// The table references in this scope
    IntrusiveList<TableReference> table_references;

    /// The result targets in this scope
    IntrusiveList<ResultTarget> result_targets;
    /// The output columns declared by this scope (ordered, for positional CTE alias access)
    std::vector<ScopeColumn> output_columns;
    /// The output columns indexed by name (points into output_columns)
    std::unordered_map<std::string_view, size_t> output_columns_by_name;
    /// The resolved CTEs in this scope (name → resolved CTE).
    /// Iterates in definition order so that results do not depend on the hash implementation.
    ankerl::unordered_dense::map<std::string_view, ResolvedCTE> cte_definitions;
    /// The AST node ids of CTE definitions, indexed by CTE name
    std::unordered_map<std::string_view, uint32_t> cte_definition_nodes;
    /// Whether this scope's WITH clause is recursive
    bool ctes_recursive = false;
    /// Do not use child-scope outputs to resolve expressions in this scope.
    bool child_output_resolution_barrier = false;
    /// Do not resolve child expressions against this scope or scopes above it.
    bool column_correlation_barrier = false;
    /// The named table-like sources in scope (catalog tables and CTEs brought in via FROM).
    /// Iterates in FROM order so that results (e.g. ambiguity errors) do not depend on the hash implementation.
    ankerl::unordered_dense::map<std::string_view, ReferencedTable> referenced_tables_by_name;
};

/// A candidate owner table for a schema-inference constraint.
struct InferenceCandidate {
    /// The (un-normalized) table name, used as the solver identity
    QualifiedTableName table_name;
    /// The unresolved table reference (for location / writeback)
    std::reference_wrapper<TableReference> table_ref;
};

/// A schema-inference constraint: an unresolved column use must be owned by one of the
/// candidate unresolved tables. `Forced` constraints have exactly one candidate (alias-qualified
/// use, or the single unresolved table in scope); `Disjunctive` constraints have several.
struct InferenceConstraint {
    enum class Kind : uint8_t { Forced, Disjunctive };
    /// The kind of constraint
    Kind kind;
    /// The column-ref occurrence this constraint was derived from
    uint32_t expression_id;
    /// The column name that must be owned
    std::reference_wrapper<RegisteredName> column_name;
    /// The candidate owner tables (1 for Forced, N for Disjunctive)
    std::vector<InferenceCandidate> candidates;
};

/// An inferred column of an unresolved table.
struct InferredColumn {
    /// The column name
    std::reference_wrapper<RegisteredName> column_name;
    /// The confidence of the inference
    InferenceConfidence confidence = InferenceConfidence::NONE;
    /// For CANDIDATE columns: the other feasible owner tables the solver could not rule out.
    /// Empty when CONFIDENT.
    std::vector<QualifiedTableName> candidate_table_names;
};

/// An inferred schema for a table that is not present in the catalog.
struct InferredTableSchema {
    /// The (un-normalized) table name (identity key for cross-statement merge)
    QualifiedTableName table_name;
    /// The confidence of the schema (max over its columns)
    InferenceConfidence confidence = InferenceConfidence::NONE;
    /// The inferred columns (ordered by first appearance)
    std::vector<InferredColumn> columns;
    /// The columns indexed by name (points into columns)
    std::unordered_map<std::string_view, size_t> columns_by_name;
};

/// A constant expression
struct ConstantExpression {
    /// The root expression
    std::reference_wrapper<Expression> root;
};

/// Binning parameters for a quantitative field
struct VisBin {
    /// The AST node id of the bin value node
    uint32_t ast_node_id = 0;
    /// Whether the input data is already binned
    std::optional<bool> binned;
    /// An exact step size between bins
    std::optional<double> step;
    /// Maximum number of bins
    std::optional<double> maxbins;
    /// Minimum allowable step size
    std::optional<double> minstep;
    /// A value at which to anchor the bins
    std::optional<double> anchor;
    /// The number base for automatic bin determination (default 10)
    std::optional<double> base;
    /// Whether to use nice bin boundaries
    std::optional<bool> nice;
    /// AST node id for the extent array [min, max]
    std::optional<uint32_t> extent_node_id;
    /// AST node id for the divide array
    std::optional<uint32_t> divide_node_id;
    /// AST node id for the steps array
    std::optional<uint32_t> steps_node_id;
};

/// A visualization scale definition
struct VisScale {
    /// The AST node id of the OBJECT_VIS_SCALE node
    uint32_t ast_node_id = 0;
    /// The scale type (linear, log, pow, sqrt, etc.)
    std::optional<buffers::parser::VisScaleType> type;
    /// AST node id for the domain value (array, expression, etc.)
    std::optional<uint32_t> domain_node_id;
    /// AST node id for the explicit domain minimum
    std::optional<uint32_t> domain_min_node_id;
    /// AST node id for the explicit domain maximum
    std::optional<uint32_t> domain_max_node_id;
    /// AST node id for the domain midpoint (diverging scales)
    std::optional<uint32_t> domain_mid_node_id;
    /// AST node id for the range value (array, expression, etc.)
    std::optional<uint32_t> range_node_id;
    /// AST node id for the explicit range minimum
    std::optional<uint32_t> range_min_node_id;
    /// AST node id for the explicit range maximum
    std::optional<uint32_t> range_max_node_id;
    /// The color scheme name for sequential/diverging scales
    std::optional<std::string_view> scheme;
    /// The interpolation method for the scale range
    std::optional<std::string_view> interpolate;
    /// Whether to extend the domain to nice round values
    std::optional<bool> nice;
    /// Whether to include zero in the domain
    std::optional<bool> zero;
    /// Whether to clamp output to the range
    std::optional<bool> clamp;
    /// Padding applied to both ends of the domain (band/point scales)
    std::optional<double> padding;
    /// Inner padding between bands (band scales)
    std::optional<double> padding_inner;
    /// Outer padding before first and after last band (band scales)
    std::optional<double> padding_outer;
    /// Whether to reverse the scale range
    std::optional<bool> reverse;
    /// Whether to round output values to integers
    std::optional<bool> round;
    /// The exponent for pow scales
    std::optional<double> exponent;
    /// The logarithm base for log scales (default 10)
    std::optional<double> base;
    /// The symlog constant determining slope around zero
    std::optional<double> constant;
    /// The alignment of steps within the range (band/point scales, 0-1)
    std::optional<double> align;
    /// AST node id for the bins array (quantize scales)
    std::optional<uint32_t> bins_node_id;
    /// A named reference for this scale
    std::optional<std::string_view> name;
};

/// A visualization axis definition
struct VisAxis {
    /// The AST node id of the OBJECT_VIS_AXIS node
    uint32_t ast_node_id = 0;
    /// The axis orientation (top, bottom, left, right)
    std::optional<std::string_view> orient;
    /// The format string for axis labels
    std::optional<std::string_view> format;
    /// The format type (number, time, utc)
    std::optional<std::string_view> format_type;
    /// Whether to draw grid lines
    std::optional<bool> grid;
    /// Whether to draw tick marks
    std::optional<bool> ticks;
    /// The desired number of ticks
    std::optional<double> tick_count;
    /// The size of tick marks in pixels
    std::optional<double> tick_size;
    /// The rotation angle of axis labels in degrees
    std::optional<double> label_angle;
    /// The font size of axis labels in pixels
    std::optional<double> label_font_size;
    /// The strategy for overlapping labels (greedy, parity)
    std::optional<std::string_view> label_overlap;
    /// The direction of the axis (horizontal, vertical)
    std::optional<std::string_view> direction;
    /// The offset in pixels from the chart edge
    std::optional<double> offset;
    /// AST node id for explicit tick values array
    std::optional<uint32_t> values_node_id;
    /// The z-index for layering
    std::optional<int32_t> zindex;
    /// The axis title text
    std::optional<std::string_view> title;
    /// Whether to draw the axis domain line
    std::optional<bool> domain;
    /// A named reference for this axis
    std::optional<std::string_view> name;
};

/// A visualization legend definition
struct VisLegend {
    /// The AST node id of the OBJECT_VIS_LEGEND node
    uint32_t ast_node_id = 0;
    /// The legend type (symbol, gradient)
    std::optional<std::string_view> type;
    /// The legend orientation (left, right, top, bottom, etc.)
    std::optional<std::string_view> orient;
    /// The format string for legend labels
    std::optional<std::string_view> format;
    /// The format type (number, time, utc)
    std::optional<std::string_view> format_type;
    /// The layout direction of legend entries (horizontal, vertical)
    std::optional<std::string_view> direction;
    /// The legend title text
    std::optional<std::string_view> title;
    /// AST node id for explicit legend values array
    std::optional<uint32_t> values_node_id;
    /// Padding around the legend in pixels
    std::optional<double> padding;
    /// Offset from the default position in pixels
    std::optional<double> offset;
    /// The z-index for layering
    std::optional<int32_t> zindex;
    /// A named reference for this legend
    std::optional<std::string_view> name;
};

/// A visualization mark definition.
///
/// Mirrors a Vega-Lite MarkDef. A mark is either a bare type (`mark => bar`,
/// captured by `type` alone) or a structured object with styling properties and
/// optional `point` / `line` overlays. The overlays are themselves mark
/// definitions (Vega-Lite allows `point`/`line` to be a boolean toggle or a
/// nested MarkDef), hence the recursive `std::unique_ptr<VisMark>` members.
struct VisMark {
    /// The AST node id of the OBJECT_VIS_MARK node
    uint32_t ast_node_id = 0;
    /// The mark type (bar, line, point, area, etc.)
    std::optional<buffers::parser::VisMarkType> type;
    /// Whether the mark is filled (vs. stroke-only)
    std::optional<bool> filled;
    /// The fill color
    std::optional<std::string_view> fill;
    /// The stroke color
    std::optional<std::string_view> stroke;
    /// The default color (fill or stroke depending on the mark)
    std::optional<std::string_view> color;
    /// The overall opacity
    std::optional<double> opacity;
    /// The fill opacity
    std::optional<double> fill_opacity;
    /// The stroke opacity
    std::optional<double> stroke_opacity;
    /// The stroke width in pixels
    std::optional<double> stroke_width;
    /// AST node id for the stroke dash array
    std::optional<uint32_t> stroke_dash_node_id;
    /// The mark size (area in pixels for point/circle/square)
    std::optional<double> size;
    /// The shape for point marks (circle, square, cross, etc.)
    std::optional<std::string_view> shape;
    /// The rotation angle in degrees
    std::optional<double> angle;
    /// The polar radius for arc/text marks
    std::optional<double> radius;
    /// The corner radius for bar/rect marks
    std::optional<double> corner_radius;
    /// The orientation (horizontal, vertical)
    std::optional<std::string_view> orient;
    /// The line interpolation method (linear, monotone, step, etc.)
    std::optional<std::string_view> interpolate;
    /// The line tension for spline interpolation (0-1)
    std::optional<double> tension;
    /// The tick/rule thickness in pixels
    std::optional<double> thickness;
    /// Whether to show tooltips
    std::optional<bool> tooltip;
    /// The point overlay (true/false toggle uses `point_enabled`, nested object uses `point`)
    std::optional<bool> point_enabled;
    /// The structured point overlay definition
    std::unique_ptr<VisMark> point;
    /// The line overlay (true/false toggle uses `line_enabled`, nested object uses `line`)
    std::optional<bool> line_enabled;
    /// The structured line overlay definition
    std::unique_ptr<VisMark> line;

    VisMark() = default;
    VisMark(VisMark&&) = default;
    VisMark& operator=(VisMark&&) = default;
    VisMark(const VisMark&) = delete;
    VisMark& operator=(const VisMark&) = delete;

    /// Whether this mark carries any property beyond a bare type, requiring the
    /// Vega-Lite object form instead of a plain mark-type string.
    bool HasProperties() const {
        return filled || fill || stroke || color || opacity || fill_opacity || stroke_opacity || stroke_width ||
               stroke_dash_node_id || size || shape || angle || radius || corner_radius || orient || interpolate ||
               tension || thickness || tooltip || point_enabled || point || line_enabled || line;
    }
};

/// A visualization encoding channel
struct VisEncodingChannel {
    /// The channel attribute key (VIS_ENCODING_X, VIS_ENCODING_Y, etc.)
    buffers::parser::AttributeKey channel_key = buffers::parser::AttributeKey::NONE;
    /// The AST node id of the OBJECT_VIS_FIELD_DEF or shorthand column ref
    uint32_t ast_node_id = 0;
    /// The resolved field expression id (from field => column_ref)
    std::optional<uint32_t> field_expression_id;
    /// The field value AST node, used when nested visualization fields are not in the SQL expression index.
    std::optional<uint32_t> field_node_id;
    /// The field type (nominal, ordinal, quantitative, temporal, geojson)
    std::optional<buffers::parser::VisFieldType> field_type;
    /// The aggregate function name (sum, mean, count, etc.)
    std::optional<std::string_view> aggregate;
    /// The bin parameters (present if binning is enabled)
    std::optional<VisBin> bin;
    /// The time unit for temporal fields (year, month, day, etc.)
    std::optional<std::string_view> time_unit;
    /// The AST node id of the `stack` value (a string like `normalize`/`zero`/`center`,
    /// or a boolean `false` to disable stacking). Emitted by node type.
    std::optional<uint32_t> stack_node_id;
    /// The scale definition for this channel
    std::optional<VisScale> scale;
    /// The axis definition for this channel
    std::optional<VisAxis> axis;
    /// The legend definition for this channel
    std::optional<VisLegend> legend;
};

/// Vega-Lite composition resolution settings.
struct VisResolve {
    std::optional<uint32_t> scale_node_id;
    std::optional<uint32_t> axis_node_id;
    std::optional<uint32_t> legend_node_id;
};

/// A recursively nested Vega-Lite unit or layered specification.
struct VegaLiteSpec {
    std::optional<buffers::parser::VisMarkType> mark_type;
    std::optional<VisMark> mark;
    std::vector<VisEncodingChannel> encoding_channels;
    std::vector<VegaLiteSpec> layers;
    std::optional<VisResolve> resolve;
    std::optional<std::string_view> title;

    VegaLiteSpec() = default;
    VegaLiteSpec(VegaLiteSpec&&) = default;
    VegaLiteSpec& operator=(VegaLiteSpec&&) = default;
    VegaLiteSpec(const VegaLiteSpec&) = delete;
    VegaLiteSpec& operator=(const VegaLiteSpec&) = delete;
};

/// Normalized dashboard grid placement shared by every renderer.
struct DashboardSpec {
    std::optional<int32_t> row;
    std::optional<int32_t> column;
    int32_t width = 6;
    int32_t height = 3;
};

/// The projection parameters for the umap renderer. The 2D projection itself runs
/// client-side at render time; these are only the parameters the analyzer forwards
/// to the runtime.
struct UmapProjection {
    /// The distance metric (e.g. `cosine`, `euclidean`)
    std::optional<std::string_view> metric;
    /// The number of neighbors (UMAP nNeighbors)
    std::optional<double> neighbors;
    /// The minimum distance (UMAP minDist)
    std::optional<double> min_dist;
};

/// A visualization spec for the umap renderer. Records only column references +
/// projection parameters; the projection runs client-side.
struct UmapSpec {
    /// The AST node id of the OBJECT_VIS_UMAP_SPEC
    uint32_t ast_node_id = 0;
    /// The resolved expression id of the required `vector` column
    std::optional<uint32_t> vector_expression_id;
    /// The resolved expression id of the optional `category` column
    std::optional<uint32_t> category_expression_id;
    /// The resolved expression id of the optional `label` column
    std::optional<uint32_t> label_expression_id;
    /// The projection parameters
    UmapProjection projection;
};

/// A Markdown renderer spec. The template is decoded from its SQL string
/// literal during analysis and compiled into a typed AST when the renderer
/// artifact is generated.
struct MarkdownSpec {
    /// The AST node id of the OBJECT_VIS_MARKDOWN_SPEC.
    uint32_t ast_node_id = 0;
    /// Decoded row template.
    std::string row_template;
};

/// The kind of source resolved for a VISUALIZE statement
enum class VisSourceKind : uint8_t {
    Unresolved = 0,
    /// Reserved legacy value.
    TableReference = 1,
    /// Reserved legacy value.
    ScriptReference = 2,
    /// `<query> visualize ...` — the complete input query
    InlineSelect = 3,
};

/// The resolved source of a VISUALIZE statement
struct ResolvedVisSource {
    /// The kind of resolved source
    VisSourceKind kind = VisSourceKind::Unresolved;
    /// The AST node id of the complete input query.
    std::optional<uint32_t> inline_select_ast_node_id;
};

/// A visualization specification
struct VisualizationSpec {
    /// The AST node id of the OBJECT_VIS_VISUALISE root
    uint32_t ast_node_id = 0;
    /// The statement id containing this visualization
    std::optional<uint32_t> ast_statement_id;
    /// The visualization renderer named after `USING` (e.g. `vegalite`).
    std::optional<std::string_view> renderer;
    /// The mark type (bar, line, point, area, etc.)
    std::optional<buffers::parser::VisMarkType> mark_type;
    /// The structured mark definition (present when the mark carries properties
    /// beyond a bare type, e.g. `mark => (type => line, point => (...))`)
    std::optional<VisMark> mark;
    /// The AST node id of the input query.
    std::optional<uint32_t> source_node_id;
    /// The resolved source classification, populated in AnalyzeVisualizationPass::Finish
    ResolvedVisSource resolved_source;
    /// The encoding channels mapping data fields to visual properties
    std::vector<VisEncodingChannel> encoding_channels;
    /// The chart title
    std::optional<std::string_view> title;
    /// Normalized dashboard grid placement.
    DashboardSpec dashboard;
    /// Nested Vega-Lite layer specifications.
    std::vector<VegaLiteSpec> layers;
    /// Vega-Lite scale/axis/legend resolution settings.
    std::optional<VisResolve> resolve;
    /// The pretty-printed Vega-Lite JSON specification (without the `data` field).
    /// Generated lazily during AnalyzedScript::Pack.
    std::string vegalite_json;
    /// The umap spec, present when `renderer` is `umap`.
    std::optional<UmapSpec> umap;
    /// The compiled UMAP FlatBuffer object model. Generated lazily and shared by
    /// analyzer and execution-result packing.
    mutable std::shared_ptr<buffers::visualization::UmapSpecT> umap_model;
    /// The markdown spec, present when `renderer` is `markdown`.
    std::optional<MarkdownSpec> markdown;
    /// The compiled Markdown FlatBuffer object model. Generated lazily and
    /// shared by analyzer and execution-result packing.
    mutable std::shared_ptr<buffers::visualization::MarkdownSpecT> markdown_ast;
};

}  // namespace dashql
