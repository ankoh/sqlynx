#ifndef INCLUDE_FLATSQL_PARSER_SCANNER_H_
#define INCLUDE_FLATSQL_PARSER_SCANNER_H_

#include <charconv>
#include <optional>
#include <string_view>
#include <unordered_set>

#include "flatsql/parser/parser.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

class ParserDriver;

constexpr size_t YY_SCANNER_STATE_SIZE = 300;
constexpr size_t YY_BUFFER_STATE_SIZE = 200;

/// XXX Note that flex requires the input to be padded with 2 additional characters to match YY_END_OF_BUFFER.
///     This scanner will blindly overwrite these last two characters and fall back to an empty buffer if the size of
///     the input is < 2.
class Scanner {
   protected:
    /// The full input buffer
    std::span<char> input_buffer;
    /// The invalid input buffer
    std::array<char, 2> null_buffer = {};

    /// The scanner state
    std::array<char, YY_SCANNER_STATE_SIZE> scanner_state_mem = {};
    /// The buffer state
    std::array<char, YY_BUFFER_STATE_SIZE> scanner_buffer_state_mem = {};
    /// The scanner buffer stack
    std::array<void*, 2> scanner_buffer_stack = {};
    /// The address of the scanner state
    void* scanner_state_ptr = nullptr;

    /// The begin of the comment
    proto::Location comment_begin = proto::Location();
    /// The comment depth
    int comment_depth = 0;
    /// The begin of the literal
    proto::Location literal_begin = proto::Location();

    /// The scanner errors
    std::vector<std::pair<proto::Location, std::string>> errors = {};
    /// The line breaks
    std::vector<proto::Location> line_breaks = {};
    /// The comments
    std::vector<proto::Location> comments = {};
    /// The vararg keys
    std::unordered_set<size_t> vararg_key_offsets = {};

    /// All symbols
    ChunkBuffer<Parser::symbol_type> symbols = {};
    /// All symbols linebreaks
    std::vector<size_t> symbol_line_breaks = {};
    /// The symbol iterator
    ChunkBuffer<Parser::symbol_type>::ForwardIterator symbol_scanner{symbols};

   public:
    /// Constructor
    Scanner(std::span<char> input);
    /// Delete the copy constructor
    Scanner(const Scanner& other) = delete;
    /// Delete the copy assignment
    Scanner& operator=(const Scanner& other) = delete;

    /// Scan entire input and produce all tokens
    void Produce();

    /// Access the input
    std::string_view GetInputText() {
        assert(input_buffer.size() >= 2);
        return std::string_view{input_buffer.data(), input_buffer.size() - 2};
    }

    /// Release the line breaks
    auto&& ReleaseLineBreaks() { return std::move(line_breaks); }
    /// Release the comments
    auto&& ReleaseComments() { return std::move(comments); }
    /// Pack syntax highlighting
    std::unique_ptr<proto::HighlightingT> BuildHighlighting();

    /// Get the text at location
    std::string_view TextAt(proto::Location loc);
    /// The the location of a text
    proto::Location LocationOf(std::string_view text);

    /// Begin a literal
    void BeginLiteral(proto::Location loc);
    /// End a literal
    proto::Location EndLiteral(proto::Location loc, bool trim_right = false);

    /// Begin a comment
    void BeginComment(proto::Location loc);
    /// End a comment
    std::optional<proto::Location> EndComment(proto::Location loc);

    /// Add an error
    void AddError(proto::Location location, const char* message);
    /// Add an error
    void AddError(proto::Location location, std::string&& message);
    /// Add a line break
    void AddLineBreak(proto::Location location);
    /// Add a comment
    void AddComment(proto::Location location);
    /// Mark as vararg key
    void MarkAsVarArgKey(proto::Location location);

    /// Read a parameter
    Parser::symbol_type ReadParameter(proto::Location loc);
    /// Read an integer
    Parser::symbol_type ReadInteger(proto::Location loc);

    /// Get the next symbol
    Parser::symbol_type Next() {
        auto sym = symbol_scanner.GetValue();
        ++symbol_scanner;
        return sym;
    }
};

}  // namespace parser
}  // namespace flatsql

#endif  // INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_
