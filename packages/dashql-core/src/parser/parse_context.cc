#include "dashql/parser/parse_context.h"

#include "dashql/buffers/index_generated.h"
#include "dashql/parser/grammar/nodes.h"
#include "dashql/parser/parser.h"
#include "dashql/utils/string_trimming.h"

namespace dashql {
namespace parser {

/// Constructor
ParseContext::ParseContext(ScannedScript& scan, bool enable_vis_syntax)
    : program(scan),
      symbol_iterator(scan.symbols),
      nodes(),
      statements(),
      errors(),
      current_statement(),
      temp_lists(),
      temp_list_elements(),
      temp_nary_expressions(),
      enable_vis_syntax(enable_vis_syntax) {}
/// Destructor
ParseContext::~ParseContext() {}

/// Create a list
BackedUniquePtr<NodeList> ParseContext::List(std::initializer_list<buffers::parser::Node> nodes) {
    auto list = new (temp_lists.Allocate()) NodeList(temp_lists, temp_list_elements);
    list->append(nodes);
    return list;
}

/// Process a new node
NodeID ParseContext::AddNode(buffers::parser::Node node) {
    auto node_id = nodes.GetSize();
    nodes.PushBack(buffers::parser::Node(node.symbol_span(), node.node_type(), node.attribute_key(), node_id,
                                         node.children_begin_or_value(), node.children_count()));

    // Set parent reference
    if (node.node_type() == buffers::parser::NodeType::ARRAY ||
        static_cast<uint16_t>(node.node_type()) > static_cast<uint16_t>(buffers::parser::NodeType::OBJECT_KEYS_)) {
        nodes.ForEachIn(node.children_begin_or_value(), node.children_count(),
                        [node_id](size_t child_id, buffers::parser::Node& n) {
                            n = buffers::parser::Node(n.symbol_span(), n.node_type(), n.attribute_key(), node_id,
                                                      n.children_begin_or_value(), n.children_count());
                        });
    }
    return node_id;
}

/// Flatten an expression
std::optional<ExpressionVariant> ParseContext::TryMerge(buffers::parser::SymbolSpan loc, buffers::parser::Node op_node,
                                                        std::span<ExpressionVariant> args) {
    // Function is not an expression operator?
    if (op_node.node_type() != buffers::parser::NodeType::ENUM_SQL_EXPRESSION_OPERATOR) {
        return std::nullopt;
    }
    // Check if the expression operator can be flattened
    auto op = static_cast<buffers::parser::ExpressionOperator>(op_node.children_begin_or_value());
    switch (op) {
        case buffers::parser::ExpressionOperator::AND:
        case buffers::parser::ExpressionOperator::OR:
            break;
        default:
            return std::nullopt;
    }
    // Create nary expression
    BackedUniquePtr nary =
        new (temp_nary_expressions.Allocate()) NAryExpression(temp_nary_expressions, loc, op, op_node, List());
    // Merge any nary expression arguments with the same operation, materialize others
    for (auto& arg : args) {
        // Argument is just a node?
        if (arg.index() == 0) {
            nary->args->push_back(std::move(std::get<0>(arg)));
            continue;
        }
        // Is a different operation?
        BackedUniquePtr<NAryExpression> child = std::get<1>(arg);
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
buffers::parser::Node ParseContext::Array(buffers::parser::SymbolSpan loc, BackedUniquePtr<NodeList>&& values,
                                          bool null_if_empty, bool shrink_location) {
    auto begin = nodes.GetSize();
    for (auto iter = values->front(); iter; iter = iter->next) {
        if (iter->node.node_type() == buffers::parser::NodeType::NONE) continue;
        AddNode(iter->node);
    }
    values.Destroy();
    auto n = nodes.GetSize() - begin;
    if ((n == 0) && null_if_empty) {
        return Null();
    }
    if (n > 0 && shrink_location) {
        auto fstBegin = nodes[begin].symbol_span().offset();
        auto& lst = nodes.GetLast();
        auto lstEnd = lst.symbol_span().offset() + lst.symbol_span().length();
        loc = buffers::parser::SymbolSpan(fstBegin, lstEnd - fstBegin);
    }
    return buffers::parser::Node(loc, buffers::parser::NodeType::ARRAY, buffers::parser::AttributeKey::NONE, NO_PARENT,
                                 begin, n);
}

/// Add an array
buffers::parser::Node ParseContext::Array(buffers::parser::SymbolSpan loc, std::span<ExpressionVariant> exprs,
                                          bool null_if_empty, bool shrink_location) {
    auto nodes = List();
    for (auto& expr : exprs) {
        nodes->push_back(Expression(std::move(expr)));
    }
    return Array(loc, std::move(nodes), null_if_empty, shrink_location);
}

/// Add an expression
buffers::parser::Node ParseContext::Expression(ExpressionVariant&& expr) {
    if (expr.index() == 0) {
        return std::get<0>(std::move(expr));
    } else {
        auto nary = std::get<1>(expr);
        auto args = Array(nary->location, std::move(nary->args));
        auto node = Object(nary->location, buffers::parser::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                           {
                               Attr(Key::SQL_EXPRESSION_OPERATOR, nary->opNode),
                               Attr(Key::SQL_EXPRESSION_ARGS, args),
                           });
        nary.Destroy();
        return node;
    }
}

/// Read a name from a keyword
buffers::parser::Node ParseContext::NameFromKeyword(buffers::parser::SymbolSpan loc, std::string_view text) {
    auto id = program.RegisterKeywordAsName(text, loc);
    return buffers::parser::Node(loc, buffers::parser::NodeType::NAME, buffers::parser::AttributeKey::NONE, NO_PARENT,
                                 id, 0);
}

/// Read a name from a string literal
buffers::parser::Node ParseContext::NameFromStringLiteral(buffers::parser::SymbolSpan loc) {
    auto text = program.ReadTextAtSymbolSpan(loc);
    auto trimmed = trim_view(text, is_no_double_quote);
    auto& name = program.name_registry.Register(trimmed, buffers::parser::TextSpan(loc.offset(), loc.length()));
    return buffers::parser::Node(loc, buffers::parser::NodeType::NAME, buffers::parser::AttributeKey::NONE, NO_PARENT,
                                 name.name_id, 0);
}

/// Mark a trailing dot
buffers::parser::Node ParseContext::TrailingDot(buffers::parser::SymbolSpan loc) {
    AddError(loc, "name has a trailing dot");
    return buffers::parser::Node(loc, buffers::parser::NodeType::OBJECT_EXT_TRAILING_DOT,
                                 buffers::parser::AttributeKey::NONE, NO_PARENT, 0, 0);
}

/// Read a float type
buffers::parser::NumericType ParseContext::ReadFloatType(buffers::parser::SymbolSpan bitsLoc) {
    auto text = program.ReadTextAtSymbolSpan(bitsLoc);
    int64_t bits = 0;
    std::from_chars(text.data(), text.data() + text.size(), bits);
    if (bits < 1) {
        AddError(bitsLoc, "precision for float type must be least 1 bit");
    } else if (bits < 24) {
        return buffers::parser::NumericType::FLOAT4;
    } else if (bits < 53) {
        return buffers::parser::NumericType::FLOAT8;
    } else {
        AddError(bitsLoc, "precision for float type must be less than 54 bits");
    }
    return buffers::parser::NumericType::FLOAT4;
}

void ParseContext::RequireAdjacent(buffers::parser::SymbolSpan left, buffers::parser::SymbolSpan right,
                                   std::string_view spelling) {
    auto left_text = program.ResolveTextSpan(left);
    auto right_text = program.ResolveTextSpan(right);
    if (left_text.offset() + left_text.length() != right_text.offset()) {
        AddError(Loc({left, right}), std::string{"expected adjacent punctuation \""} +
                                         std::string{spelling} + "\"");
    }
}

void ParseContext::RequireOperator(buffers::parser::SymbolSpan loc, std::string_view spelling) {
    if (program.ReadTextAtSymbolSpan(loc) != spelling) {
        AddError(loc, std::string{"expected operator \""} + std::string{spelling} + "\"");
    }
}

/// Add an object
buffers::parser::Node ParseContext::Object(buffers::parser::SymbolSpan loc, buffers::parser::NodeType type,
                                           BackedUniquePtr<NodeList>&& attr_list, bool null_if_empty,
                                           bool shrink_location) {
    // Add the nodes
    auto begin = nodes.GetSize();
    for (auto iter = attr_list->first_element; iter; iter = iter->next) {
        if (iter->node.node_type() == buffers::parser::NodeType::NONE) continue;
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
        auto fstBegin = nodes[begin].symbol_span().offset();
        auto& lst = nodes.GetLast();
        auto lstEnd = lst.symbol_span().offset() + lst.symbol_span().length();
        loc = buffers::parser::SymbolSpan(fstBegin, lstEnd - fstBegin);
    }
    return buffers::parser::Node(loc, type, buffers::parser::AttributeKey::NONE, NO_PARENT, begin, n);
}

/// Add a statement
void ParseContext::AddStatement(buffers::parser::Node node) {
    if (node.node_type() == buffers::parser::NodeType::NONE) {
        return;
    }
    current_statement.root = AddNode(node);
    auto stmt_type = buffers::parser::StatementType::NONE;
    switch (node.node_type()) {
        case buffers::parser::NodeType::OBJECT_EXT_SET:
            stmt_type = buffers::parser::StatementType::SET;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_CREATE_AS:
            stmt_type = buffers::parser::StatementType::CREATE_TABLE_AS;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_CREATE:
            stmt_type = buffers::parser::StatementType::CREATE_TABLE;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_VIEW:
            stmt_type = buffers::parser::StatementType::CREATE_VIEW;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_CREATE_FUNCTION:
            stmt_type = buffers::parser::StatementType::CREATE_FUNCTION;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_SELECT:
            stmt_type = buffers::parser::StatementType::SELECT;
            {
                auto current = node;
                while (current.node_type() == buffers::parser::NodeType::OBJECT_SQL_SELECT) {
                    const buffers::parser::Node* next = nullptr;
                    for (size_t i = 0; i < current.children_count(); ++i) {
                        auto& child = nodes[current.children_begin_or_value() + i];
                        if (child.attribute_key() == buffers::parser::AttributeKey::SQL_SELECT_INTO &&
                            child.node_type() != buffers::parser::NodeType::NONE) {
                            stmt_type = buffers::parser::StatementType::SELECT_INTO;
                            break;
                        }
                        if (child.attribute_key() == buffers::parser::AttributeKey::SQL_COMBINE_INPUT &&
                            child.node_type() == buffers::parser::NodeType::ARRAY && child.children_count() > 0) {
                            next = &nodes[child.children_begin_or_value()];
                        }
                    }
                    if (stmt_type == buffers::parser::StatementType::SELECT_INTO || next == nullptr) break;
                    current = *next;
                }
            }
            break;

        case buffers::parser::NodeType::OBJECT_SQL_DROP_TABLE:
            stmt_type = buffers::parser::StatementType::DROP_TABLE;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_DROP_VIEW:
            stmt_type = buffers::parser::StatementType::DROP_VIEW;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_ATTACH_DATABASE:
            stmt_type = buffers::parser::StatementType::ATTACH_DATABASE;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_INSERT:
            stmt_type = buffers::parser::StatementType::INSERT;
            break;

        case buffers::parser::NodeType::OBJECT_SQL_DELETE:
            stmt_type = buffers::parser::StatementType::DELETE;
            break;

        case buffers::parser::NodeType::OBJECT_VIS_VISUALISE:
            stmt_type = buffers::parser::StatementType::VIS_VISUALISE;
            break;

        case buffers::parser::NodeType::OBJECT_EXT_EXPLAIN:
            stmt_type = buffers::parser::StatementType::EXPLAIN;
            break;

        default:
            assert(false);
    }
    current_statement.type = stmt_type;
    current_statement.node_count = nodes.GetSize() - current_statement.nodes_begin;
    statements.push_back(std::move(current_statement));
    current_statement = {
        .type = buffers::parser::StatementType::NONE,
        .root = std::numeric_limits<uint32_t>::max(),
        .nodes_begin = nodes.GetSize(),
        .node_count = 0,
    };
}

void ParseContext::ResetStatement() { current_statement.nodes_begin = nodes.GetSize(); }

/// Add an error
void ParseContext::AddError(buffers::parser::SymbolSpan loc, const std::string& message, std::string hint) {
    errors.push_back({loc, message, std::move(hint)});
}

}  // namespace parser
}  // namespace dashql
