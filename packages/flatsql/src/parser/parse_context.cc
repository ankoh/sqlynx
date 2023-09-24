#include "flatsql/parser/parse_context.h"

#include <iostream>
#include <regex>
#include <sstream>

#include "flatsql/parser/grammar/nodes.h"
#include "flatsql/parser/parser.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/string_trimming.h"

namespace flatsql {
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
WeakUniquePtr<NodeList> ParseContext::List(std::initializer_list<proto::Node> nodes) {
    auto list = new (temp_lists.Allocate()) NodeList(temp_lists, temp_list_elements);
    list->append(nodes);
    return list;
}

/// Process a new node
NodeID ParseContext::AddNode(proto::Node node) {
    auto node_id = nodes.GetSize();
    nodes.Append(proto::Node(node.location(), node.node_type(), node.attribute_key(), node_id,
                             node.children_begin_or_value(), node.children_count()));

    // Set parent reference
    if (node.node_type() == proto::NodeType::ARRAY ||
        static_cast<uint16_t>(node.node_type()) > static_cast<uint16_t>(proto::NodeType::OBJECT_KEYS_)) {
        nodes.ForEachIn(node.children_begin_or_value(), node.children_count(),
                        [node_id](size_t child_id, proto::Node& n) {
                            n = proto::Node(n.location(), n.node_type(), n.attribute_key(), node_id,
                                            n.children_begin_or_value(), n.children_count());
                        });
    }
    return node_id;
}

/// Flatten an expression
std::optional<ExpressionVariant> ParseContext::TryMerge(proto::Location loc, proto::Node op_node,
                                                        std::span<ExpressionVariant> args) {
    // Function is not an expression operator?
    if (op_node.node_type() != proto::NodeType::ENUM_SQL_EXPRESSION_OPERATOR) {
        return std::nullopt;
    }
    // Check if the expression operator can be flattened
    auto op = static_cast<proto::ExpressionOperator>(op_node.children_begin_or_value());
    switch (op) {
        case proto::ExpressionOperator::AND:
        case proto::ExpressionOperator::OR:
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
proto::Node ParseContext::Array(proto::Location loc, WeakUniquePtr<NodeList>&& values, bool null_if_empty,
                                bool shrink_location) {
    auto begin = nodes.GetSize();
    for (auto iter = values->front(); iter; iter = iter->next) {
        if (iter->node.node_type() == proto::NodeType::NONE) continue;
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
        loc = proto::Location(fstBegin, lstEnd - fstBegin);
    }
    return proto::Node(loc, proto::NodeType::ARRAY, proto::AttributeKey::NONE, NO_PARENT, begin, n);
}

/// Add an array
proto::Node ParseContext::Array(proto::Location loc, std::span<ExpressionVariant> exprs, bool null_if_empty,
                                bool shrink_location) {
    auto nodes = List();
    for (auto& expr : exprs) {
        nodes->push_back(Expression(std::move(expr)));
    }
    return Array(loc, std::move(nodes), null_if_empty, shrink_location);
}

/// Add an expression
proto::Node ParseContext::Expression(ExpressionVariant&& expr) {
    if (expr.index() == 0) {
        return std::get<0>(std::move(expr));
    } else {
        auto nary = std::get<1>(expr);
        auto args = Array(nary->location, std::move(nary->args));
        auto node = Object(nary->location, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                           {
                               Attr(Key::SQL_EXPRESSION_OPERATOR, nary->opNode),
                               Attr(Key::SQL_EXPRESSION_ARGS, args),
                           });
        nary.Destroy();
        return node;
    }
}

/// Read a name from a keyword
proto::Node ParseContext::NameFromKeyword(proto::Location loc, std::string_view text) {
    auto id = program.RegisterKeywordAsName(text, loc);
    return proto::Node(loc, proto::NodeType::NAME, proto::AttributeKey::NONE, NO_PARENT, id, 0);
}

/// Read a name from a string literal
proto::Node ParseContext::NameFromStringLiteral(proto::Location loc) {
    auto text = program.ReadTextAtLocation(loc);
    auto trimmed = trim_view(text, is_no_double_quote);
    auto id = program.RegisterName(trimmed, loc);
    return proto::Node(loc, proto::NodeType::NAME, proto::AttributeKey::NONE, NO_PARENT, id, 0);
}

/// Read a float type
proto::NumericType ParseContext::ReadFloatType(proto::Location bitsLoc) {
    auto text = program.ReadTextAtLocation(bitsLoc);
    int64_t bits;
    std::from_chars(text.data(), text.data() + text.size(), bits);
    if (bits < 1) {
        AddError(bitsLoc, "precision for float type must be least 1 bit");
    } else if (bits < 24) {
        return proto::NumericType::FLOAT4;
    } else if (bits < 53) {
        return proto::NumericType::FLOAT8;
    } else {
        AddError(bitsLoc, "precision for float type must be less than 54 bits");
    }
    return proto::NumericType::FLOAT4;
}

/// Add an object
proto::Node ParseContext::Object(proto::Location loc, proto::NodeType type, WeakUniquePtr<NodeList>&& attr_list,
                                 bool null_if_empty, bool shrink_location) {
    // Add the nodes
    auto begin = nodes.GetSize();
    for (auto iter = attr_list->first_element; iter; iter = iter->next) {
        if (iter->node.node_type() == proto::NodeType::NONE) continue;
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
        loc = proto::Location(fstBegin, lstEnd - fstBegin);
    }
    return proto::Node(loc, type, proto::AttributeKey::NONE, NO_PARENT, begin, n);
}

/// Add a statement
void ParseContext::AddStatement(proto::Node node) {
    if (node.node_type() == proto::NodeType::NONE) {
        return;
    }
    current_statement.root = AddNode(node);
    auto stmt_type = proto::StatementType::NONE;
    switch (node.node_type()) {
        case proto::NodeType::OBJECT_EXT_SET:
            stmt_type = proto::StatementType::SET;
            break;

        case proto::NodeType::OBJECT_SQL_CREATE_AS:
            stmt_type = proto::StatementType::CREATE_TABLE_AS;
            break;

        case proto::NodeType::OBJECT_SQL_CREATE:
            stmt_type = proto::StatementType::CREATE_TABLE;
            break;

        case proto::NodeType::OBJECT_SQL_VIEW:
            stmt_type = proto::StatementType::CREATE_VIEW;
            break;

        case proto::NodeType::OBJECT_SQL_SELECT:
            stmt_type = proto::StatementType::SELECT;
            break;

        default:
            assert(false);
    }
    current_statement.type = stmt_type;
    statements.push_back(std::move(current_statement));
    current_statement = {};
}

/// Add an error
void ParseContext::AddError(proto::Location loc, const std::string& message) { errors.push_back({loc, message}); }

std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> ParseContext::Parse(std::shared_ptr<ScannedScript> scanned,
                                                                                bool trace_scanning,
                                                                                bool trace_parsing) {
    if (scanned == nullptr) {
        return {nullptr, proto::StatusCode::PARSER_INPUT_INVALID};
    }

    // Parse the tokens
    ParseContext ctx{*scanned};
    flatsql::parser::Parser parser(ctx);
    parser.parse();

    // Make sure we didn't leak into our temp allocators.
    // This can happen quickly when not consuming an allocated list in a bison rule.
#define DEBUG_BISON_LEAKS 0
#if DEBUG_BISON_LEAKS
    auto text = in.ToString();
    auto text_view = std::string_view{text};
    ctx.temp_list_elements.ForEachAllocated([&](size_t value_id, NodeList::ListElement& elem) {
        std::cout << proto::EnumNameAttributeKey(static_cast<proto::AttributeKey>(elem.node.attribute_key())) << " "
                  << proto::EnumNameNodeType(elem.node.node_type()) << " "
                  << text_view.substr(elem.node.location().offset(), elem.node.location().length()) << std::endl;
    });
#else
    if (ctx.errors.empty()) {
        assert(ctx.temp_list_elements.GetAllocatedNodeCount() == 0);
    }
#endif

    assert(ctx.temp_nary_expressions.GetAllocatedNodeCount() == 0);

    // Pack the program
    return {std::make_shared<ParsedScript>(scanned, std::move(ctx)), proto::StatusCode::OK};
}

}  // namespace parser
}  // namespace flatsql
