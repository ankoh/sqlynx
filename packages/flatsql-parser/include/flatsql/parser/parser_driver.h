#ifndef INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_
#define INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_

#include <iostream>
#include <map>
#include <memory>
#include <stack>
#include <string>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>
#include <span>

#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/small_vector.h"

namespace flatsql {
namespace parser {

class Scanner;

using Key = proto::AttributeKey;
using Location = proto::Location;
using NodeVector = SmallVector<proto::Node, 5>; // 5 * 24 = 120 Bytes

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
    std::vector<std::variant<proto::Node, NAryExpression>> args;
};
/// An expression is either a proto node with materialized children, or an n-ary expression that can be flattened
using Expression = std::variant<proto::Node, NAryExpression>;

class ParserDriver {
   protected:
    /// The scanner
    Scanner& scanner_;
    /// The nodes
    std::vector<proto::Node> nodes_;
    /// The current statement
    Statement current_statement_;
    /// The statements
    std::vector<Statement> statements_;
    /// The errors
    std::vector<std::pair<proto::Location, std::string>> errors_;
    /// The dependencies
    std::vector<proto::Dependency> dependencies_;
    /// The dson keys
    std::vector<proto::Location> vararg_keys_;
    /// The dson key mapping
    std::unordered_map<std::string_view, uint16_t> dson_key_map_;

    /// Find an attribute
    std::optional<size_t> FindAttribute(const proto::Node& node, Key attribute) const;

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
    auto& scanner() { return scanner_; }

    /// Add a an array
    proto::Node AddArray(proto::Location loc, std::span<proto::Node> values, bool null_if_empty = true,
                         bool shrink_location = false);
    /// Add a an array
    proto::Node AddArray(proto::Location loc, std::span<Expression> values, bool null_if_empty = true,
                         bool shrink_location = false);
    /// Add an object
    proto::Node AddObject(proto::Location loc, proto::NodeType type, std::span<proto::Node> attrs,
                          bool null_if_empty = true, bool shrink_location = false);
    /// Add a dson field
    proto::Node AddVarArgField(proto::Location loc, std::vector<proto::Location>&& key_path, proto::Node value);
    /// Add a statement
    void AddStatement(proto::Node node);
    /// Add an error
    void AddError(proto::Location loc, const std::string& message);

    /// Add a an array
    inline proto::Node Add(proto::Location loc, NodeVector&& values, bool null_if_empty = true,
                           bool shrink_location = false) {
        return AddArray(loc, values.span(), null_if_empty, shrink_location);
    }
    /// Add a an object
    inline proto::Node Add(proto::Location loc, proto::NodeType type, NodeVector&& values, bool null_if_empty = true,
                           bool shrink_location = false) {
        return AddObject(loc, type, values.span(), null_if_empty, shrink_location);
    }
    /// Add an expression
    proto::Node AddExpression(Expression&& expr);
    /// Add a an expression
    inline proto::Node Add(Expression&& expr) {
        return AddExpression(std::move(expr));
    }
    /// Flatten an expression
    std::optional<Expression> TryMerge(proto::Location loc, proto::Node opNode, std::span<Expression> args);

    /// Parse a module
    static std::shared_ptr<proto::ProgramT> Parse(std::string_view in, bool trace_scanning = false,
                                                  bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql

#endif  // INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_
