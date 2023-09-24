#include "flatsql/parser/grammar/state.h"

#include "flatsql/parser/parser.h"

namespace flatsql {
namespace parser {

/// Constructor
NAryExpression::NAryExpression(Pool& pool, proto::Location loc, proto::ExpressionOperator op, proto::Node node,
                               WeakUniquePtr<NodeList> args)
    : expression_pool(pool), location(loc), op(op), opNode(node), args(std::move(args)) {}
/// Destructor
NAryExpression::~NAryExpression() {
    args.Destroy();
    expression_pool.Deallocate(this);
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

}  // namespace parser
}  // namespace flatsql
