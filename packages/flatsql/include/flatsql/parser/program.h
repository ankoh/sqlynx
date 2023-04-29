#pragma once

#include <string_view>

#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"

namespace flatsql {
namespace parser {

class Scanner;

class ScannedProgram {
   public:
    /// The full input data
    rope::Rope& input_data;

    /// The scanner errors
    std::vector<std::pair<proto::Location, std::string>> errors;
    /// The line breaks
    std::vector<proto::Location> line_breaks;
    /// The comments
    std::vector<proto::Location> comments;
    /// The string dictionary
    std::vector<sx::Location> string_dictionary;

    /// All symbols
    ChunkBuffer<Parser::symbol_type> symbols;
    /// The symbol iterator
    ChunkBuffer<Parser::symbol_type>::ForwardIterator symbol_iterator;

   public:
    /// Constructor
    ScannedProgram(Scanner& scanner);

    /// Get next symbol
    inline Parser::symbol_type IterNext() {
        auto sym = symbol_iterator.GetValue();
        ++symbol_iterator;
        return sym;
    }
    /// Reset the symbol iterator
    inline void IterReset() { symbol_iterator.Reset(); }

    /// Read a text at a location
    std::string_view ReadTextAtLocation(sx::Location loc, std::string& tmp);
    /// Pack syntax highlighting
    std::unique_ptr<proto::HighlightingT> BuildHighlighting();
};

}  // namespace parser
}  // namespace flatsql
