#pragma once

#include <charconv>
#include <initializer_list>

#include "flatsql/parser/grammar/enums.h"
#include "flatsql/parser/grammar/location.h"
#include "flatsql/parser/parser_driver.h"
#include "flatsql/parser/program.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

/// Helper to configure an attribute node
inline proto::Node Attr(proto::AttributeKey key, proto::Node node) {
    return proto::Node(node.location(), node.node_type(), key, node.parent(), node.children_begin_or_value(),
                       node.children_count());
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& l, WeakUniquePtr<NodeList>&& r) {
    l->append(std::move(r));
    return l;
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& l, std::initializer_list<proto::Node> r) {
    l->append(std::move(r));
    return l;
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& v0, WeakUniquePtr<NodeList>&& v1,
                                      std::initializer_list<proto::Node> v2) {
    v0->append(std::move(v1));
    v0->append(std::move(v2));
    return v0;
}
/// Helper to concatenate lists
inline WeakUniquePtr<NodeList> Concat(WeakUniquePtr<NodeList>&& v0, WeakUniquePtr<NodeList>&& v1,
                                      WeakUniquePtr<NodeList>&& v2, std::initializer_list<proto::Node> v3 = {}) {
    v0->append(std::move(v1));
    v0->append(std::move(v2));
    v0->append(std::move(v3));
    return v0;
}

/// Create a null node
inline proto::Node Null() {
    return proto::Node(proto::Location(), proto::NodeType::NONE, proto::AttributeKey::NONE, NO_PARENT, 0, 0);
}
/// Create a string node
inline proto::Node Ident(proto::Location loc) {
    return proto::Node(loc, proto::NodeType::IDENTIFIER, proto::AttributeKey::NONE, NO_PARENT, 0, 0);
}
/// Create a bool node
inline proto::Node Bool(proto::Location loc, bool v) {
    return proto::Node(loc, proto::NodeType::BOOL, proto::AttributeKey::NONE, NO_PARENT, static_cast<uint32_t>(v), 0);
}

/// Create a constant inline
inline proto::Node Const(proto::Location loc, proto::AConstType type) {
    switch (type) {
        case proto::AConstType::NULL_:
            return proto::Node(loc, proto::NodeType::LITERAL_NULL, proto::AttributeKey::NONE, NO_PARENT, 0, 0);
        case proto::AConstType::INTEGER:
            return proto::Node(loc, proto::NodeType::LITERAL_INTEGER, proto::AttributeKey::NONE, NO_PARENT, 0, 0);
        case proto::AConstType::FLOAT:
            return proto::Node(loc, proto::NodeType::LITERAL_FLOAT, proto::AttributeKey::NONE, NO_PARENT, 0, 0);
        case proto::AConstType::STRING:
            return proto::Node(loc, proto::NodeType::LITERAL_STRING, proto::AttributeKey::NONE, NO_PARENT, 0, 0);
        case proto::AConstType::INTERVAL:
            return proto::Node(loc, proto::NodeType::LITERAL_INTERVAL, proto::AttributeKey::NONE, NO_PARENT, 0, 0);
    }
    return Null();
}

/// Create indirection
inline proto::Node IndirectionIndex(ParserDriver& driver, proto::Location loc, proto::Node index) {
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_INDIRECTION_INDEX,
                         {
                             Attr(Key::SQL_INDIRECTION_INDEX_VALUE, index),
                         });
}

/// Create indirection
inline proto::Node IndirectionIndex(ParserDriver& driver, proto::Location loc, proto::Node lower_bound,
                                    proto::Node upper_bound) {
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_INDIRECTION_INDEX,
                         {
                             Attr(Key::SQL_INDIRECTION_INDEX_LOWER_BOUND, lower_bound),
                             Attr(Key::SQL_INDIRECTION_INDEX_UPPER_BOUND, upper_bound),
                         });
}

/// Create a temp table name
inline proto::Node Into(ParserDriver& driver, proto::Location loc, proto::Node type, proto::Node name) {
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_INTO,
                         {
                             Attr(Key::SQL_TEMP_TYPE, type),
                             Attr(Key::SQL_TEMP_NAME, name),
                         });
}

/// Create a column ref
inline proto::Node ColumnRef(ParserDriver& driver, proto::Location loc, WeakUniquePtr<NodeList>&& path) {
    auto path_nodes = driver.Array(loc, std::move(path));
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_COLUMN_REF,
                         {
                             Attr(Key::SQL_COLUMN_REF_PATH, path_nodes),
                         });
}

/// Add an expression without arguments
inline proto::Node Expr(ParserDriver& driver, proto::Location loc, proto::Node func) {
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION, {Attr(Key::SQL_EXPRESSION_OPERATOR, func)});
}

/// Add an unary expression
inline proto::Node Expr(ParserDriver& driver, proto::Location loc, proto::Node func, ExpressionVariant arg) {
    std::array<ExpressionVariant, 1> args{std::move(arg)};
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

enum PostFixTag { PostFix };
/// Add an unary expression
inline ExpressionVariant Expr(ParserDriver& driver, proto::Location loc, proto::Node func, ExpressionVariant arg,
                              PostFixTag) {
    std::array<ExpressionVariant, 1> args{std::move(arg)};
    if (auto expr = driver.TryMerge(loc, func, args); expr.has_value()) {
        return std::move(expr.value());
    }
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_POSTFIX, Bool(loc, true)),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Add a binary expression
inline ExpressionVariant Expr(ParserDriver& driver, proto::Location loc, proto::Node func, ExpressionVariant left,
                              ExpressionVariant right) {
    std::array<ExpressionVariant, 2> args{std::move(left), std::move(right)};
    if (auto expr = driver.TryMerge(loc, func, args); expr.has_value()) {
        return std::move(expr.value());
    }
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Add a ternary expression
inline ExpressionVariant Expr(ParserDriver& driver, proto::Location loc, proto::Node func, ExpressionVariant arg0,
                              ExpressionVariant arg1, ExpressionVariant arg2) {
    std::array<ExpressionVariant, 3> args{std::move(arg0), std::move(arg1), std::move(arg2)};
    if (auto expr = driver.TryMerge(loc, func, args); expr.has_value()) {
        return std::move(expr.value());
    }
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, func),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Negate an expression
inline ExpressionVariant Negate(ParserDriver& driver, proto::Location loc, proto::Location loc_minus,
                                ExpressionVariant value) {
    // XXX If node_type == OBJECT_SQL_CONST inspect the attributes and expand the value

    // Otherwise fall back to an unary negation
    std::array<ExpressionVariant, 1> args{std::move(value)};
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, Enum(loc_minus, proto::ExpressionOperator::NEGATE)),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}
/// Negate a value
inline proto::Node Negate(ParserDriver& driver, proto::Location loc, proto::Location loc_minus, proto::Node value) {
    // XXX If node_type == OBJECT_SQL_CONST inspect the attributes and expand the value

    // Otherwise fall back to an unary negation
    std::array<ExpressionVariant, 1> args{std::move(value)};
    return driver.Object(loc, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                         {
                             Attr(Key::SQL_EXPRESSION_OPERATOR, Enum(loc_minus, proto::ExpressionOperator::NEGATE)),
                             Attr(Key::SQL_EXPRESSION_ARGS, driver.Array(loc, args)),
                         });
}

/// Merge join types
inline proto::JoinType Merge(proto::JoinType left, proto::JoinType right) {
    uint8_t result = 0;
    result |= static_cast<uint8_t>(left);
    result |= static_cast<uint8_t>(right);
    return static_cast<proto::JoinType>(result);
}

/// Read a float type
inline proto::NumericType ReadFloatType(ParserDriver& driver, proto::Location bitsLoc) {
    std::string tmp_buffer;
    auto text = driver.GetProgram().ReadTextAtLocation(bitsLoc, tmp_buffer);
    int64_t bits;
    std::from_chars(text.data(), text.data() + text.size(), bits);
    if (bits < 1) {
        driver.AddError(bitsLoc, "precision for float type must be least 1 bit");
    } else if (bits < 24) {
        return proto::NumericType::FLOAT4;
    } else if (bits < 53) {
        return proto::NumericType::FLOAT8;
    } else {
        driver.AddError(bitsLoc, "precision for float type must be less than 54 bits");
    }
    return proto::NumericType::FLOAT4;
}

/// Add a vararg field
inline proto::Node VarArgField(ParserDriver& driver, proto::Location loc, WeakUniquePtr<NodeList>&& path,
                               proto::Node value) {
    auto root = value;
    for (auto iter = path->back(); iter; iter = iter->prev) {
        root = driver.Object(loc, proto::NodeType::OBJECT_EXT_VARARG_FIELD,
                             {
                                 Attr(proto::AttributeKey::EXT_VARARG_FIELD_KEY, iter->node),
                                 Attr(proto::AttributeKey::EXT_VARARG_FIELD_VALUE, value),
                             });
    }
    path.Destroy();
    return root;
}

}  // namespace parser
}  // namespace flatsql
