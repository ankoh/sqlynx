#include "dashql/parser/parse_context.h"

#include "dashql/parser/grammar/nodes.h"
#include "dashql/parser/parser.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/utils/string_trimming.h"

namespace dashql {
namespace parser {

/// Constructor
ParseContext::ParseContext(ScannedScript& scan)
    : program(scan),
      symbol_iterator(scan.symbols),
      nodes(),
      statements(),
      errors(),
      current_statement(),
      temp_nary_expressions(),
      temp_lists(),
      temp_list_elements() {}
/// Destructor
ParseContext::~ParseContext() {}

/// Create a list
WeakUniquePtr<NodeList> ParseContext::List(std::initializer_list<buffers::Node> nodes) {
    auto list = new (temp_lists.Allocate()) NodeList(temp_lists, temp_list_elements);
    list->append(nodes);
    return list;
}

/// Process a new node
NodeID ParseContext::AddNode(buffers::Node node) {
    auto node_id = nodes.GetSize();
    nodes.Append(buffers::Node(node.location(), node.node_type(), node.attribute_key(), node_id,
                             node.children_begin_or_value(), node.children_count()));

    // Set parent reference
    if (node.node_type() == buffers::NodeType::ARRAY ||
        static_cast<uint16_t>(node.node_type()) > static_cast<uint16_t>(buffers::NodeType::OBJECT_KEYS_)) {
        nodes.ForEachIn(node.children_begin_or_value(), node.children_count(),
                        [node_id](size_t child_id, buffers::Node& n) {
                            n = buffers::Node(n.location(), n.node_type(), n.attribute_key(), node_id,
                                            n.children_begin_or_value(), n.children_count());
                        });
    }
    return node_id;
}

/// Flatten an expression
std::optional<ExpressionVariant> ParseContext::TryMerge(buffers::Location loc, buffers::Node op_node,
                                                        std::span<ExpressionVariant> args) {
    // Function is not an expression operator?
    if (op_node.node_type() != buffers::NodeType::ENUM_SQL_EXPRESSION_OPERATOR) {
        return std::nullopt;
    }
    // Check if the expression operator can be flattened
    auto op = static_cast<buffers::ExpressionOperator>(op_node.children_begin_or_value());
    switch (op) {
        case buffers::ExpressionOperator::AND:
        case buffers::ExpressionOperator::OR:
            break;
        default:
            return std::nullopt;
    }
    // Create nary expression
    WeakUniquePtr nary =
        new (temp_nary_expressions.Allocate()) NAryExpression(temp_nary_expressions, loc, op, op_node, List());
    // Merge any nary expression arguments with the same operation, materialize others
    for (auto& arg : args) {
        // Argument is just a node?
        if (arg.index() == 0) {
            nary->args->push_back(std::move(std::get<0>(arg)));
            continue;
        }
        // Is a different operation?
        WeakUniquePtr<NAryExpression> child = std::get<1>(arg);
        if (child->op != op) {
            nary->args->push_back(Expression(std::move(child)));
            continue;
        }
        // Merge child arguments
        nary->args->append(std::move(child->args));
        child.Destroy();
    }
    return nary;
}

/// Add an array
buffers::Node ParseContext::Array(buffers::Location loc, WeakUniquePtr<NodeList>&& values, bool null_if_empty,
                                bool shrink_location) {
    auto begin = nodes.GetSize();
    for (auto iter = values->front(); iter; iter = iter->next) {
        if (iter->node.node_type() == buffers::NodeType::NONE) continue;
        AddNode(iter->node);
    }
    values.Destroy();
    auto n = nodes.GetSize() - begin;
    if ((n == 0) && null_if_empty) {
        return Null();
    }
    if (n > 0 && shrink_location) {
        auto fstBegin = nodes[begin].location().offset();
        auto& lst = nodes.GetLast();
        auto lstEnd = lst.location().offset() + lst.location().length();
        loc = buffers::Location(fstBegin, lstEnd - fstBegin);
    }
    return buffers::Node(loc, buffers::NodeType::ARRAY, buffers::AttributeKey::NONE, NO_PARENT, begin, n);
}

/// Add an array
buffers::Node ParseContext::Array(buffers::Location loc, std::span<ExpressionVariant> exprs, bool null_if_empty,
                                bool shrink_location) {
    auto nodes = List();
    for (auto& expr : exprs) {
        nodes->push_back(Expression(std::move(expr)));
    }
    return Array(loc, std::move(nodes), null_if_empty, shrink_location);
}

/// Add an expression
buffers::Node ParseContext::Expression(ExpressionVariant&& expr) {
    if (expr.index() == 0) {
        return std::get<0>(std::move(expr));
    } else {
        auto nary = std::get<1>(expr);
        auto args = Array(nary->location, std::move(nary->args));
        auto node = Object(nary->location, buffers::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                           {
                               Attr(Key::SQL_EXPRESSION_OPERATOR, nary->opNode),
                               Attr(Key::SQL_EXPRESSION_ARGS, args),
                           });
        nary.Destroy();
        return node;
    }
}

/// Read a name from a keyword
buffers::Node ParseContext::NameFromKeyword(buffers::Location loc, std::string_view text) {
    auto id = program.RegisterKeywordAsName(text, loc);
    return buffers::Node(loc, buffers::NodeType::NAME, buffers::AttributeKey::NONE, NO_PARENT, id, 0);
}

/// Read a name from a string literal
buffers::Node ParseContext::NameFromStringLiteral(buffers::Location loc) {
    auto text = program.ReadTextAtLocation(loc);
    auto trimmed = trim_view(text, is_no_double_quote);
    auto& name = program.name_registry.Register(trimmed, loc);
    return buffers::Node(loc, buffers::NodeType::NAME, buffers::AttributeKey::NONE, NO_PARENT, name.name_id, 0);
}

/// Mark a trailing dot
buffers::Node ParseContext::TrailingDot(buffers::Location loc) {
    AddError(loc, "name has a trailing dot");
    return buffers::Node(loc, buffers::NodeType::OBJECT_EXT_TRAILING_DOT, buffers::AttributeKey::NONE, NO_PARENT, 0, 0);
}

/// Read a float type
buffers::NumericType ParseContext::ReadFloatType(buffers::Location bitsLoc) {
    auto text = program.ReadTextAtLocation(bitsLoc);
    int64_t bits;
    std::from_chars(text.data(), text.data() + text.size(), bits);
    if (bits < 1) {
        AddError(bitsLoc, "precision for float type must be least 1 bit");
    } else if (bits < 24) {
        return buffers::NumericType::FLOAT4;
    } else if (bits < 53) {
        return buffers::NumericType::FLOAT8;
    } else {
        AddError(bitsLoc, "precision for float type must be less than 54 bits");
    }
    return buffers::NumericType::FLOAT4;
}

/// Add an object
buffers::Node ParseContext::Object(buffers::Location loc, buffers::NodeType type, WeakUniquePtr<NodeList>&& attr_list,
                                 bool null_if_empty, bool shrink_location) {
    // Add the nodes
    auto begin = nodes.GetSize();
    for (auto iter = attr_list->first_element; iter; iter = iter->next) {
        if (iter->node.node_type() == buffers::NodeType::NONE) continue;
        AddNode(iter->node);
    }
    attr_list.Destroy();
    // Were there any attributes?
    auto n = nodes.GetSize() - begin;
    if ((n == 0) && null_if_empty) {
        return Null();
    }
    // Shrink location?
    if (n > 0 && shrink_location) {
        auto fstBegin = nodes[begin].location().offset();
        auto& lst = nodes.GetLast();
        auto lstEnd = lst.location().offset() + lst.location().length();
        loc = buffers::Location(fstBegin, lstEnd - fstBegin);
    }
    return buffers::Node(loc, type, buffers::AttributeKey::NONE, NO_PARENT, begin, n);
}

/// Add a statement
void ParseContext::AddStatement(buffers::Node node) {
    if (node.node_type() == buffers::NodeType::NONE) {
        return;
    }
    current_statement.root = AddNode(node);
    auto stmt_type = buffers::StatementType::NONE;
    switch (node.node_type()) {
        case buffers::NodeType::OBJECT_EXT_SET:
            stmt_type = buffers::StatementType::SET;
            break;

        case buffers::NodeType::OBJECT_SQL_CREATE_AS:
            stmt_type = buffers::StatementType::CREATE_TABLE_AS;
            break;

        case buffers::NodeType::OBJECT_SQL_CREATE:
            stmt_type = buffers::StatementType::CREATE_TABLE;
            break;

        case buffers::NodeType::OBJECT_SQL_VIEW:
            stmt_type = buffers::StatementType::CREATE_VIEW;
            break;

        case buffers::NodeType::OBJECT_SQL_SELECT:
            stmt_type = buffers::StatementType::SELECT;
            break;

        default:
            assert(false);
    }
    current_statement.type = stmt_type;
    current_statement.node_count = nodes.GetSize() - current_statement.nodes_begin;
    statements.push_back(std::move(current_statement));
    current_statement = {
        .type = buffers::StatementType::NONE,
        .root = std::numeric_limits<uint32_t>::max(),
        .nodes_begin = nodes.GetSize(),
        .node_count = 0,
    };
}

void ParseContext::ResetStatement() { current_statement.nodes_begin = nodes.GetSize(); }

/// Add an error
void ParseContext::AddError(buffers::Location loc, const std::string& message) { errors.push_back({loc, message}); }

}  // namespace parser
}  // namespace dashql
