#include "flatsql/parser/parser_driver.h"

#include <iostream>
#include <regex>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

#include "flatsql/parser/grammar/nodes.h"
#include "flatsql/parser/parser.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/small_vector.h"

namespace flatsql {
namespace parser {

/// Constructor
Statement::Statement() : root() {}

/// Reset the statement
void Statement::reset() { root = std::numeric_limits<uint32_t>::max(); }

/// Finish a statement
std::unique_ptr<proto::StatementT> Statement::Finish() {
    auto stmt = std::make_unique<proto::StatementT>();
    stmt->statement_type = type;
    stmt->root_node = root;
    return stmt;
}

/// Constructor
NodeList::NodeList(ListPool& l, ListElementPool& n) : list_pool(l), element_pool(n) {}
/// Destructor
NodeList::~NodeList() {
    for (auto iter = first_element; iter;) {
        auto next = iter->next;
        element_pool.Deallocate(iter);
        iter = next;
    }
    first_element = nullptr;
    last_element = nullptr;
    element_count = 0;
    list_pool.Deallocate(this);
}
/// Prepend a node
void NodeList::push_front(proto::Node node) {
    auto* elem = new (element_pool.Allocate()) ListElement();
    elem->node = node;
    if (!first_element) {
        assert(!last_element);
        first_element = elem;
        last_element = elem;
        elem->next = nullptr;
        elem->prev = nullptr;
    } else {
        elem->prev = nullptr;
        elem->next = first_element;
        first_element->prev = elem;
        first_element = elem;
    }
    ++element_count;
}
/// Append a node
void NodeList::push_back(proto::Node node) {
    auto* elem = new (element_pool.Allocate()) ListElement();
    elem->node = node;
    if (!last_element) {
        assert(!first_element);
        first_element = elem;
        last_element = elem;
        elem->next = nullptr;
        elem->prev = nullptr;
    } else {
        elem->next = nullptr;
        elem->prev = last_element;
        last_element->next = elem;
        last_element = elem;
    }
    ++element_count;
}
/// Append a list of nodes
void NodeList::append(std::initializer_list<proto::Node> nodes) {
    for (auto node : nodes) {
        push_back(node);
    }
}
/// Append a list of nodes
void NodeList::append(WeakUniquePtr<NodeList>&& other) {
    if (!last_element) {
        assert(!first_element);
        first_element = other->first_element;
        last_element = other->last_element;
    } else if (other->first_element) {
        last_element->next = other->first_element;
        other->first_element->prev = last_element->next;
        last_element = other->last_element;
    }
    element_count += other->element_count;
    other->first_element = nullptr;
    other->last_element = nullptr;
    other->element_count = 0;
    other.Destroy();
}
/// Copy a list into a vector
void NodeList::copy_into(std::span<proto::Node> nodes) {
    assert(nodes.size() == element_count);
    auto iter = first_element;
    for (size_t i = 0; i < element_count; ++i) {
        assert(iter);
        nodes[i] = iter->node;
        iter = iter->next;
    }
}

/// Constructor
ParserDriver::ParserDriver(Scanner& scanner)
    : scanner(scanner),
      nodes(),
      current_statement(),
      statements(),
      errors(),
      temp_nary_expressions(),
      temp_lists(),
      temp_list_elements() {}
/// Destructor
ParserDriver::~ParserDriver() {}

/// Create a list
WeakUniquePtr<NodeList> ParserDriver::List(std::initializer_list<proto::Node> nodes) {
    auto list = new (temp_lists.Allocate()) NodeList(temp_lists, temp_list_elements);
    list->append(nodes);
    return list;
}

/// Process a new node
NodeID ParserDriver::AddNode(proto::Node node) {
    auto node_id = nodes.GetSize();
    nodes.Append(proto::Node(node.location(), node.node_type(), node.attribute_key(), node_id,
                             node.children_begin_or_value(), node.children_count()));

    // Set parent reference
    if (node.node_type() == proto::NodeType::ARRAY ||
        static_cast<uint16_t>(node.node_type()) > static_cast<uint16_t>(proto::NodeType::OBJECT_KEYS_)) {
        nodes.ForEachIn(node.children_begin_or_value(), node.children_count(), [](size_t node_id, proto::Node& n) {
            n = proto::Node(n.location(), n.node_type(), n.attribute_key(), node_id, n.children_begin_or_value(),
                            n.children_count());
        });
    }
    return node_id;
}

/// Flatten an expression
std::optional<Expression> ParserDriver::TryMerge(proto::Location loc, proto::Node op_node, std::span<Expression> args) {
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
            nary->args->push_back(AddExpression(std::move(child)));
            continue;
        }
        // Merge child arguments
        nary->args->append(std::move(child->args));
        child.Destroy();
    }
    return nary;
}

/// Add an array
proto::Node ParserDriver::AddArray(proto::Location loc, WeakUniquePtr<NodeList>&& values, bool null_if_empty,
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
    return proto::Node(loc, proto::NodeType::ARRAY, 0, NO_PARENT, begin, n);
}

/// Add an array
proto::Node ParserDriver::AddArray(proto::Location loc, std::span<Expression> exprs, bool null_if_empty,
                                   bool shrink_location) {
    auto nodes = List();
    for (auto& expr : exprs) {
        nodes->push_back(AddExpression(std::move(expr)));
    }
    return AddArray(loc, std::move(nodes), null_if_empty, shrink_location);
}

/// Add an expression
proto::Node ParserDriver::AddExpression(Expression&& expr) {
    if (expr.index() == 0) {
        return std::get<0>(std::move(expr));
    } else {
        auto nary = std::get<1>(expr);
        auto args = AddArray(nary->location, std::move(nary->args));
        auto node = Add(nary->location, proto::NodeType::OBJECT_SQL_NARY_EXPRESSION,
                        {
                            Attr(Key::SQL_EXPRESSION_OPERATOR, nary->opNode),
                            Attr(Key::SQL_EXPRESSION_ARGS, args),
                        });
        nary.Destroy();
        return node;
    }
}

/// Add an object
proto::Node ParserDriver::AddObject(proto::Location loc, proto::NodeType type, WeakUniquePtr<NodeList>&& attr_list,
                                    bool null_if_empty, bool shrink_location) {
    // Sort all the attributes
    std::array<proto::Node, 8> attrs_static;
    std::vector<proto::Node> attrs_heap;
    std::span<proto::Node> attrs;
    if (attr_list->size() <= 8) {
        attrs = {attrs_static.data(), attr_list->size()};
    } else {
        attrs_heap.resize(attr_list->size());
        attrs = attrs_heap;
    }
    attr_list->copy_into(attrs);
    attr_list.Destroy();
    std::sort(attrs.begin(), attrs.end(), [&](auto& l, auto& r) {
        return static_cast<uint16_t>(l.attribute_key()) < static_cast<uint16_t>(r.attribute_key());
    });

    // Add the nodes
    auto begin = nodes.GetSize();
    for (auto& v : attrs) {
        if (v.node_type() == proto::NodeType::NONE) continue;
        AddNode(v);
    }
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
    return proto::Node(loc, type, 0, NO_PARENT, begin, n);
}

/// Add a statement
void ParserDriver::AddStatement(proto::Node node) {
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
    current_statement.reset();
}

/// Add an error
void ParserDriver::AddError(proto::Location loc, const std::string& message) { errors.push_back({loc, message}); }

/// Get as flatbuffer object
std::shared_ptr<proto::ProgramT> ParserDriver::Finish() {
    auto program = std::make_unique<proto::ProgramT>();
    program->nodes = nodes.Flatten();
    program->statements.reserve(statements.size());
    for (auto& stmt : statements) {
        program->statements.push_back(stmt.Finish());
    }
    program->errors.reserve(errors.size());
    for (auto& [loc, msg] : errors) {
        auto err = std::make_unique<proto::ErrorT>();
        err->location = std::make_unique<proto::Location>(loc);
        err->message = std::move(msg);
        program->errors.push_back(std::move(err));
    }
    program->highlighting = scanner.BuildHighlighting();
    program->line_breaks = scanner.ReleaseLineBreaks();
    program->comments = scanner.ReleaseComments();
    return program;
}

std::shared_ptr<proto::ProgramT> ParserDriver::Parse(rope::Rope& in, bool trace_scanning, bool trace_parsing) {
    // Tokenize the input text
    Scanner scanner{in};
    scanner.Tokenize();

    // Parse the tokens
    ParserDriver driver{scanner};
    flatsql::parser::Parser parser(driver);
    parser.parse();

    // Make sure we didn't leak into our temp allocators
    // XXX We're apparently leaking some lists, find them!
    //     (probably by not propagating them in bison rules)
    // assert(driver.temp_lists.GetAllocatedNodeCount() == 0);
    // assert(driver.temp_list_elements.GetAllocatedNodeCount() == 0);
    assert(driver.temp_nary_expressions.GetAllocatedNodeCount() == 0);

    // Pack the program
    return driver.Finish();
}

}  // namespace parser
}  // namespace flatsql
