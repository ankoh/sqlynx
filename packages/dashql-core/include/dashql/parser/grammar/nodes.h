#pragma once

#include <charconv>
#include <initializer_list>

#include "dashql/parser/grammar/enums.h"
#include "dashql/parser/grammar/location.h"
#include "dashql/parser/parse_context.h"
#include "dashql/parser/scanner.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"

namespace dashql {
namespace parser {

/// Helper to configure an attribute node
inline buffers::Node Attr(buffers::AttributeKey key, buffers::Node node) {
    return buffers::Node(node.location(), node.node_type(), key, node.parent(), node.children_begin_or_value(),
                       node.children_count());
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& l, WeakUniquePtr<NodeList>&& r) {
    l->append(std::move(r));
    return l;
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& l, std::initializer_list<buffers::Node> r) {
    l->append(std::move(r));
    return l;
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& v0, WeakUniquePtr<NodeList>&& v1,
                                      std::initializer_list<buffers::Node> v2) {
    v0->append(std::move(v1));
    v0->append(std::move(v2));
    return v0;
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& v0, WeakUniquePtr<NodeList>&& v1,
                                      WeakUniquePtr<NodeList>&& v2, std::initializer_list<buffers::Node> v3 = {}) {
    v0->append(std::move(v1));
    v0->append(std::move(v2));
    v0->append(std::move(v3));
    return v0;
}

/// Create a null node
inline buffers::Node Null() {
    return buffers::Node(buffers::Location(), buffers::NodeType::NONE, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
}
/// Create a name from an identifier
inline buffers::Node Operator(buffers::Location loc) {
    return buffers::Node(loc, buffers::NodeType::OPERATOR, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
}
/// Create a name from an identifier
inline buffers::Node NameFromIdentifier(buffers::Location loc, size_t value) {
    return buffers::Node(loc, buffers::NodeType::NAME, buffers::AttributeKey::NONE, NO_PARENT, value, 0);
}
/// Create a bool node
inline buffers::Node Bool(buffers::Location loc, bool v) {
    return buffers::Node(loc, buffers::NodeType::BOOL, buffers::AttributeKey::NONE, NO_PARENT, static_cast<uint32_t>(v), 0);
}

/// Create a constant inline
inline buffers::Node Const(buffers::Location loc, buffers::AConstType type) {
    switch (type) {
        case buffers::AConstType::NULL_:
            return buffers::Node(loc, buffers::NodeType::LITERAL_NULL, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
        case buffers::AConstType::INTEGER:
            return buffers::Node(loc, buffers::NodeType::LITERAL_INTEGER, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
        case buffers::AConstType::FLOAT:
            return buffers::Node(loc, buffers::NodeType::LITERAL_FLOAT, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
        case buffers::AConstType::STRING:
            return buffers::Node(loc, buffers::NodeType::LITERAL_STRING, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
        case buffers::AConstType::INTERVAL:
            return buffers::Node(loc, buffers::NodeType::LITERAL_INTERVAL, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
    }
    return Null();
}

/// Create indirection
inline buffers::Node IndirectionIndex(ParseContext& driver, buffers::Location loc, buffers::Node index) {
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_INDIRECTION_INDEX,
                         {
                             Attr(Key::SQL_INDIRECTION_INDEX_VALUE, index),
                         });
}

/// Create indirection
inline buffers::Node IndirectionIndex(ParseContext& driver, buffers::Location loc, buffers::Node lower_bound,
                                    buffers::Node upper_bound) {
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_INDIRECTION_INDEX,
                         {
                             Attr(Key::SQL_INDIRECTION_INDEX_LOWER_BOUND, lower_bound),
                             Attr(Key::SQL_INDIRECTION_INDEX_UPPER_BOUND, upper_bound),
                         });
}

/// Create a temp table name
inline buffers::Node Into(ParseContext& driver, buffers::Location loc, buffers::Node type, buffers::Node name) {
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_INTO,
                         {
                             Attr(Key::SQL_TEMP_TYPE, type),
                             Attr(Key::SQL_TEMP_NAME, name),
                         });
}

/// Create a column ref
inline buffers::Node ColumnRef(ParseContext& driver, buffers::Location loc, WeakUniquePtr<NodeList>&& path) {
    auto path_nodes = driver.Array(loc, std::move(path));
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_COLUMN_REF,
                         {
                             Attr(Key::SQL_COLUMN_REF_PATH, path_nodes),
                         });
}

/// Add an expression without arguments
inline buffers::Node Expr(ParseContext& driver, buffers::Location loc, buffers::Node func) {
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION, {Attr(Key::SQL_EXPRESSION_OPERATOR, func)});
}

/// Add an unary expression
inline buffers::Node Expr(ParseContext& driver, buffers::Location loc, buffers::Node func, ExpressionVariant arg) {
    std::array<ExpressionVariant, 1> args{std::move(arg)};
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

enum PostFixTag { PostFix };
/// Add an unary expression
inline ExpressionVariant Expr(ParseContext& driver, buffers::Location loc, buffers::Node func, ExpressionVariant arg,
                              PostFixTag) {
    std::array<ExpressionVariant, 1> args{std::move(arg)};
    if (auto expr = driver.TryMerge(loc, func, args); expr.has_value()) {
        return std::move(expr.value());
    }
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_POSTFIX, Bool(loc, true)),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Add a binary expression
inline ExpressionVariant Expr(ParseContext& driver, buffers::Location loc, buffers::Node func, ExpressionVariant left,
                              ExpressionVariant right) {
    std::array<ExpressionVariant, 2> args{std::move(left), std::move(right)};
    if (auto expr = driver.TryMerge(loc, func, args); expr.has_value()) {
        return std::move(expr.value());
    }
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Add a ternary expression
inline ExpressionVariant Expr(ParseContext& driver, buffers::Location loc, buffers::Node func, ExpressionVariant arg0,
                              ExpressionVariant arg1, ExpressionVariant arg2) {
    std::array<ExpressionVariant, 3> args{std::move(arg0), std::move(arg1), std::move(arg2)};
    if (auto expr = driver.TryMerge(loc, func, args); expr.has_value()) {
        return std::move(expr.value());
    }
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Negate an expression
inline ExpressionVariant Negate(ParseContext& driver, buffers::Location loc, buffers::Location loc_minus,
                                ExpressionVariant value) {
    // XXX If node_type == OBJECT_SQL_CONST inspect the attributes and expand the value

    // Otherwise fall back to an unary negation
    std::array<ExpressionVariant, 1> args{std::move(value)};
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, Enum(loc_minus, buffers::ExpressionOperator::NEGATE)),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}
/// Negate a value
inline buffers::Node Negate(ParseContext& driver, buffers::Location loc, buffers::Location loc_minus, buffers::Node value) {
    // XXX If node_type == OBJECT_SQL_CONST inspect the attributes and expand the value

    // Otherwise fall back to an unary negation
    std::array<ExpressionVariant, 1> args{std::move(value)};
    return driver.Object(loc, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, Enum(loc_minus, buffers::ExpressionOperator::NEGATE)),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Merge join types
inline buffers::JoinType Merge(buffers::JoinType left, buffers::JoinType right) {
    uint8_t result = 0;
    result |= static_cast<uint8_t>(left);
    result |= static_cast<uint8_t>(right);
    return static_cast<buffers::JoinType>(result);
}

/// Add a vararg field
inline buffers::Node VarArgField(ParseContext& driver, buffers::Location loc, WeakUniquePtr<NodeList>&& path,
                               buffers::Node value) {
    auto root = value;
    for (auto iter = path->back(); iter; iter = iter->prev) {
        root = driver.Object(loc, buffers::NodeType::OBJECT_EXT_VARARG_FIELD,
                             {
                                 Attr(buffers::AttributeKey::EXT_VARARG_FIELD_KEY, iter->node),
                                 Attr(buffers::AttributeKey::EXT_VARARG_FIELD_VALUE, value),
                             });
    }
    path.Destroy();
    return root;
}

}  // namespace parser
}  // namespace dashql
