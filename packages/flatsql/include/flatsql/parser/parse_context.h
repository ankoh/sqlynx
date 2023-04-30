#pragma once

#include <initializer_list>
#include <iostream>
#include <map>
#include <memory>
#include <span>
#include <stack>
#include <string>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/chunk_buffer.h"
#include "flatsql/utils/temp_allocator.h"

namespace flatsql {
namespace parser {

class ScannedProgram;
class ParsedProgram;

using NodeID = uint32_t;
using Key = proto::AttributeKey;
using Location = proto::Location;

inline std::ostream& operator<<(std::ostream& out, const proto::Location& loc) {
    out << "[" << loc.offset() << "," << (loc.offset() + loc.length()) << "[";
    return out;
}

/// A statement
struct Statement {
    /// The statement type
    proto::StatementType type;
    /// The root node
    NodeID root;

    /// Constructor
    Statement();

    /// Reset
    void reset();
    /// Get as flatbuffer object
    std::unique_ptr<proto::StatementT> Finish();
};

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

class ParseContext {
    friend class ParsedProgram;

   protected:
    /// The scanner
    ScannedProgram& program;

    /// The nodes
    ChunkBuffer<proto::Node> nodes;
    /// The statements
    std::vector<Statement> statements;
    /// The errors
    std::vector<std::pair<proto::Location, std::string>> errors;

    /// The current statement
    Statement current_statement;
    /// The temporary node lists
    NodeList::ListPool temp_lists;
    /// The temporary node list elements
    NodeList::ListElementPool temp_list_elements;
    /// The temporary nary expression nodes
    TempNodePool<NAryExpression, 16> temp_nary_expressions;

   public:
    /// Constructor
    explicit ParseContext(ScannedProgram& scan);
    /// Destructor
    ~ParseContext();

    /// Get the program
    auto& GetProgram() { return program; };

    /// Create a list
    WeakUniquePtr<NodeList> List(std::initializer_list<proto::Node> nodes = {});
    /// Add a an array
    proto::Node Array(proto::Location loc, WeakUniquePtr<NodeList>&& values, bool null_if_empty = true,
                      bool shrink_location = false);
    /// Add a an array
    proto::Node Array(proto::Location loc, std::span<ExpressionVariant> values, bool null_if_empty = true,
                      bool shrink_location = false);
    /// Add a an array
    inline proto::Node Array(proto::Location loc, std::initializer_list<proto::Node> values, bool null_if_empty = true,
                             bool shrink_location = false) {
        return Array(loc, List(std::move(values)), null_if_empty, shrink_location);
    }
    /// Add an object
    proto::Node Object(proto::Location loc, proto::NodeType type, WeakUniquePtr<NodeList>&& attrs,
                       bool null_if_empty = true, bool shrink_location = false);
    /// Add a an object
    inline proto::Node Object(proto::Location loc, proto::NodeType type, std::initializer_list<proto::Node> values,
                              bool null_if_empty = true, bool shrink_location = false) {
        return Object(loc, type, List(std::move(values)), null_if_empty, shrink_location);
    }
    /// Add an expression
    proto::Node Expression(ExpressionVariant&& expr);
    /// Flatten an expression
    std::optional<ExpressionVariant> TryMerge(proto::Location loc, proto::Node opNode,
                                              std::span<ExpressionVariant> args);

    /// Create a name from an identifier
    proto::Node NameFromIdentifier();
    /// Create a name from a string literal
    proto::Node NameFromStringLiteral();
    /// Create a name from a keyword
    proto::Node NameFromKeyword();

    /// Add a node
    NodeID AddNode(proto::Node node);
    /// Add an error
    void AddError(proto::Location loc, const std::string& message);
    /// Add a statement
    void AddStatement(proto::Node node);

    /// Parse a module
    static std::unique_ptr<ParsedProgram> Parse(ScannedProgram& in, bool trace_scanning = false,
                                                bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql
