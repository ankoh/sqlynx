#pragma once

#include <initializer_list>
#include <iostream>
#include <map>
#include <memory>
#include <span>
#include <stack>
#include <string>
#include <tuple>
#include <utility>
#include <variant>
#include <vector>

#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/chunk_buffer.h"
#include "flatsql/utils/temp_allocator.h"

namespace flatsql {

class ScannedScript;
class ParsedScript;

namespace parser {

class ParseContext {
    friend class ::flatsql::ParsedScript;

   protected:
    /// The scanner
    ScannedScript& program;
    /// The symbol iterator
    ChunkBuffer<Parser::symbol_type>::ConstTupleIterator symbol_iterator;

    /// The nodes
    ChunkBuffer<proto::Node> nodes;
    /// The statements
    std::vector<ParsedScript::Statement> statements;
    /// The errors
    std::vector<std::pair<proto::Location, std::string>> errors;

    /// The current statement
    ParsedScript::Statement current_statement;
    /// The temporary node lists
    NodeList::ListPool temp_lists;
    /// The temporary node list elements
    NodeList::ListElementPool temp_list_elements;
    /// The temporary nary expression nodes
    TempNodePool<NAryExpression, 16> temp_nary_expressions;

   public:
    /// Constructor
    explicit ParseContext(ScannedScript& scan);
    /// Destructor
    ~ParseContext();

    /// Get the program
    auto& GetProgram() { return program; };
    /// Get next symbol
    inline Parser::symbol_type NextSymbol() {
        Parser::symbol_type sym = *symbol_iterator;
        ++symbol_iterator;
        return sym;
    }

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

    /// Create a name from a keyword
    proto::Node NameFromKeyword(proto::Location loc, std::string_view text);
    /// Create a name from a string literal
    proto::Node NameFromStringLiteral(proto::Location loc);

    /// Read a float type
    proto::NumericType ReadFloatType(proto::Location bitsLoc);

    /// Add a node
    NodeID AddNode(proto::Node node);
    /// Add an error
    void AddError(proto::Location loc, const std::string& message);
    /// Add a statement
    void AddStatement(proto::Node node);

    /// Parse a module
    static std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> Parse(std::shared_ptr<ScannedScript> in,
                                                                             bool trace_scanning = false,
                                                                             bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql
