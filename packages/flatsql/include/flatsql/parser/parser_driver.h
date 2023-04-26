#ifndef INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_
#define INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_

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
#include "flatsql/utils/small_vector.h"
#include "flatsql/utils/temp_allocator.h"

namespace flatsql {
namespace parser {

class Scanner;

using Key = proto::AttributeKey;
using Location = proto::Location;
using NodeList = std::list<proto::Node, TempNodeAllocator<proto::Node>>;

inline std::ostream& operator<<(std::ostream& out, const proto::Location& loc) {
    out << "[" << loc.offset() << "," << (loc.offset() + loc.length()) << "[";
    return out;
}

using NodeID = uint32_t;

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

/// Helper for nary expressions
/// We defer the materialization of nary expressions to flatten conjunctions and disjunctions
struct NAryExpression {
    /// The location
    proto::Location location;
    /// The expression operator
    proto::ExpressionOperator op;
    /// The expression operator node
    proto::Node opNode;
    /// The arguments
    NodeList args;
};
/// An expression is either a proto node with materialized children, or an n-ary expression that can be flattened
using Expression = std::variant<proto::Node, NAryExpression*>;

class ParserDriver {
   protected:
    /// The scanner
    Scanner& scanner;
    /// The nodes
    ChunkBuffer<proto::Node> nodes;
    /// The current statement
    Statement current_statement;
    /// The statements
    std::vector<Statement> statements;
    /// The errors
    std::vector<std::pair<proto::Location, std::string>> errors;
    /// The temporary nary expression nodes
    TempNodePool<NAryExpression, 16> temp_nary_expressions;

    /// Add a node
    NodeID AddNode(proto::Node node);
    /// Get as flatbuffer object
    std::shared_ptr<proto::ProgramT> Finish();

   public:
    /// Constructor
    explicit ParserDriver(Scanner& scanner);
    /// Destructor
    ~ParserDriver();

    /// Return the scanner
    auto& GetScanner() { return scanner; }

    /// Add a an array
    proto::Node AddArray(proto::Location loc, NodeList&& values, bool null_if_empty = true,
                         bool shrink_location = false);
    /// Add a an array
    proto::Node AddArray(proto::Location loc, std::span<Expression> values, bool null_if_empty = true,
                         bool shrink_location = false);
    /// Add an object
    proto::Node AddObject(proto::Location loc, proto::NodeType type, NodeList&& attrs, bool null_if_empty = true,
                          bool shrink_location = false);
    /// Add a statement
    void AddStatement(proto::Node node);
    /// Add an error
    void AddError(proto::Location loc, const std::string& message);

    /// Add a an array
    inline proto::Node Add(proto::Location loc, NodeList&& values, bool null_if_empty = true,
                           bool shrink_location = false) {
        return AddArray(loc, std::move(values), null_if_empty, shrink_location);
    }
    /// Add a an object
    inline proto::Node Add(proto::Location loc, proto::NodeType type, NodeList&& values, bool null_if_empty = true,
                           bool shrink_location = false) {
        return AddObject(loc, type, std::move(values), null_if_empty, shrink_location);
    }
    /// Add an expression
    proto::Node AddExpression(Expression&& expr);
    /// Add a an expression
    inline proto::Node Add(Expression&& expr) { return AddExpression(std::move(expr)); }
    /// Flatten an expression
    std::optional<Expression> TryMerge(proto::Location loc, proto::Node opNode, std::span<Expression> args);

    /// Parse a module
    static std::shared_ptr<proto::ProgramT> Parse(rope::Rope& in, bool trace_scanning = false,
                                                  bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql

#endif  // INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_
