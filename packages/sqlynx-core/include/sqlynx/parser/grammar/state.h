#pragma once

#include <variant>

#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/text/rope.h"
#include "sqlynx/utils/chunk_buffer.h"
#include "sqlynx/utils/temp_allocator.h"

namespace sqlynx {
namespace parser {

/// A raw pointer that is unique but does not destroy the object.
/// If you get a WeakUniquePtr as r-value, you are responsible for deleting it.
template <typename T> struct WeakUniquePtr {
    T* inner;
    WeakUniquePtr(T* value = nullptr) : inner(value) {}
    WeakUniquePtr(WeakUniquePtr&& other) : inner(other.inner) { other.inner = nullptr; }
    WeakUniquePtr& operator=(WeakUniquePtr&& other) {
        Destroy();
        inner = other.inner;
        other.inner = nullptr;
        return *this;
    }
    WeakUniquePtr(const WeakUniquePtr& other) : inner(other.inner) {
        // We only implement copy constructors to please the bison stack assignment.
        *const_cast<T**>(&other.inner) = nullptr;
    }
    WeakUniquePtr& operator=(const WeakUniquePtr& other) {
        Destroy();
        inner = other.inner;
        // We only implement copy assignment to please the bison stack assignment.
        *const_cast<T**>(&other.inner) = nullptr;
        return *this;
    }
    T* operator->() {
        assert(inner);
        return inner;
    }
    T& operator*() {
        assert(inner);
        return *inner;
    }
    void Destroy() {
        if (inner) {
            inner->~T();
            inner = nullptr;
        }
    }
};

/// A list of nodes that uses own allocators for both, the list container and the nodes
struct NodeList {
    /// A list element
    struct ListElement {
        /// The next list element
        ListElement* next = nullptr;
        /// The next list element
        ListElement* prev = nullptr;
        /// The element node
        proto::Node node;
        /// Constructor
        ListElement() = default;
    };
    using ListPool = TempNodePool<NodeList, 16>;
    using ListElementPool = TempNodePool<ListElement, 128>;

    /// The node list pool
    ListPool& list_pool;
    /// The node allocator
    ListElementPool& element_pool;
    /// The front of the list
    ListElement* first_element = nullptr;
    /// The back of the list
    ListElement* last_element = nullptr;
    /// The list size
    size_t element_count = 0;

    /// Constructor
    NodeList(ListPool& list_pool, ListElementPool& node_pool);
    /// Destructor
    ~NodeList();
    /// Move constructor
    NodeList(NodeList&& other) = default;

    /// Get the front
    inline ListElement* front() { return first_element; }
    /// Get the front
    inline ListElement* back() { return last_element; }
    /// Get the size
    inline size_t size() { return element_count; }
    /// Is empty?
    inline bool empty() { return size() == 0; }
    /// Prepend a node
    void push_front(proto::Node node);
    /// Append a node
    void push_back(proto::Node node);
    /// Append a list of nodes
    void append(std::initializer_list<proto::Node> nodes);
    /// Append a list of nodes
    void append(WeakUniquePtr<NodeList>&& other);
    /// Write elements into span
    void copy_into(std::span<proto::Node> nodes);
};

/// Helper for nary expressions
/// We defer the materialization of nary expressions to flatten conjunctions and disjunctions
struct NAryExpression {
    using Pool = TempNodePool<NAryExpression, 16>;

    /// The expression pool
    Pool& expression_pool;
    /// The location
    proto::Location location;
    /// The expression operator
    proto::ExpressionOperator op;
    /// The expression operator node
    proto::Node opNode;
    /// The arguments
    WeakUniquePtr<NodeList> args;

    /// Constructor
    NAryExpression(Pool& pool, proto::Location loc, proto::ExpressionOperator op, proto::Node node,
                   WeakUniquePtr<NodeList> args);
    /// Destructor
    ~NAryExpression();
};
/// An expression is either a proto node with materialized children, or an n-ary expression that can be flattened
using ExpressionVariant = std::variant<proto::Node, WeakUniquePtr<NAryExpression>>;

}  // namespace parser
}  // namespace sqlynx
