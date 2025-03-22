#pragma once

#include <initializer_list>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include "dashql/parser/parser.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"
#include "dashql/utils/chunk_buffer.h"
#include "dashql/utils/temp_allocator.h"

namespace dashql {

class ScannedScript;
class ParsedScript;

namespace parser {

class ParseContext {
    friend class ::dashql::ParsedScript;
    friend class ::dashql::parser::Parser;

   protected:
    /// The scanner
    ScannedScript& program;
    /// The symbol iterator
    ChunkBuffer<Parser::symbol_type>::ConstTupleIterator symbol_iterator;

    /// The nodes
    ChunkBuffer<buffers::Node> nodes;
    /// The statements
    std::vector<ParsedScript::Statement> statements;
    /// The errors
    std::vector<std::pair<buffers::Location, std::string>> errors;

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
        if (symbol_iterator.IsAtEnd()) {
            return parser::Parser::make_EOF({static_cast<uint32_t>(program.text_buffer.size()), 0});
        }
        Parser::symbol_type sym = *symbol_iterator;
        ++symbol_iterator;
        return sym;
    }

    /// Create a list
    WeakUniquePtr<NodeList> List(std::initializer_list<buffers::Node> nodes = {});
    /// Add a an array
    buffers::Node Array(buffers::Location loc, WeakUniquePtr<NodeList>&& values, bool null_if_empty = true,
                      bool shrink_location = false);
    /// Add a an array
    buffers::Node Array(buffers::Location loc, std::span<ExpressionVariant> values, bool null_if_empty = true,
                      bool shrink_location = false);
    /// Add a an array
    inline buffers::Node Array(buffers::Location loc, std::initializer_list<buffers::Node> values, bool null_if_empty = true,
                             bool shrink_location = false) {
        return Array(loc, List(std::move(values)), null_if_empty, shrink_location);
    }
    /// Add an object
    buffers::Node Object(buffers::Location loc, buffers::NodeType type, WeakUniquePtr<NodeList>&& attrs,
                       bool null_if_empty = true, bool shrink_location = false);
    /// Add a an object
    inline buffers::Node Object(buffers::Location loc, buffers::NodeType type, std::initializer_list<buffers::Node> values = {},
                              bool null_if_empty = true, bool shrink_location = false) {
        return Object(loc, type, List(std::move(values)), null_if_empty, shrink_location);
    }
    /// Add an expression
    buffers::Node Expression(ExpressionVariant&& expr);
    /// Flatten an expression
    std::optional<ExpressionVariant> TryMerge(buffers::Location loc, buffers::Node opNode,
                                              std::span<ExpressionVariant> args);

    /// Create a name from a keyword
    buffers::Node NameFromKeyword(buffers::Location loc, std::string_view text);
    /// Create a name from a string literal
    buffers::Node NameFromStringLiteral(buffers::Location loc);
    /// Mark a trailing dot
    buffers::Node TrailingDot(buffers::Location loc);

    /// Read a float type
    buffers::NumericType ReadFloatType(buffers::Location bitsLoc);

    /// Add a node
    NodeID AddNode(buffers::Node node);
    /// Add an error
    void AddError(buffers::Location loc, const std::string& message);
    /// Add a statement
    void AddStatement(buffers::Node node);
    /// Reset a statement
    void ResetStatement();
};

}  // namespace parser
}  // namespace dashql
