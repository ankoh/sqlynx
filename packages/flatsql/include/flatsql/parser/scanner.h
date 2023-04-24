#ifndef INCLUDE_FLATSQL_PARSER_SCANNER_H_
#define INCLUDE_FLATSQL_PARSER_SCANNER_H_

#include <charconv>
#include <optional>
#include <string_view>
#include <unordered_set>

#include "flatsql/parser/parser.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"

namespace flatsql {
namespace parser {

class ParserDriver;

/// Note that flex requires the input to be padded with 2 additional characters to match YY_END_OF_BUFFER.
/// This scanner will blindly overwrite these last two characters and fall back to an empty buffer if the size of
/// the input is < 2.
class Scanner {
   protected:
    /// The internal scanner state
    void* internal_scanner_state = nullptr;

    /// The full input data
    rope::Rope& input_data;
    /// The current leaf node
    rope::LeafNode* current_leaf_node = nullptr;
    /// The local offset of the value within the current leaf
    size_t current_leaf_offset = 0;
    /// The global offset within the rope
    size_t current_input_offset = 0;

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
    /// The symbol iterator
    ChunkBuffer<Parser::symbol_type>::ForwardIterator symbol_scanner{symbols};

   public:
    // Helpers that are called from the generated flex scanner

    /// Get the input
    auto& GetInputData() noexcept { return input_data; }
    /// Get the input location
    auto GetInputOffset() noexcept { return current_input_offset; }
    /// Advance the input location
    void AdvanceInputOffset(size_t by) noexcept { current_input_offset += by; }
    /// Scan next input data
    void ScanNextInputData(void* out_buffer, int& out_bytes_read, size_t max_size);

    /// Read a parameter
    Parser::symbol_type ReadParameter(std::string_view text, proto::Location loc);
    /// Read an integer
    Parser::symbol_type ReadInteger(std::string_view text, proto::Location loc);

    /// Begin a literal
    void BeginLiteral(proto::Location loc);
    /// End a literal
    proto::Location EndLiteral(std::string_view text, proto::Location loc, bool trim_right = false);
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

   public:
    /// Constructor
    Scanner(rope::Rope& rope);
    /// Destructor
    ~Scanner();
    /// Delete the copy constructor
    Scanner(const Scanner& other) = delete;
    /// Delete the copy assignment
    Scanner& operator=(const Scanner& other) = delete;

    /// Scan input and produce all tokens
    void Tokenize();
    /// Get the next symbol
    Parser::symbol_type NextToken() {
        auto sym = symbol_scanner.GetValue();
        ++symbol_scanner;
        return sym;
    }

    /// Release the line breaks
    auto&& ReleaseLineBreaks() { return std::move(line_breaks); }
    /// Release the comments
    auto&& ReleaseComments() { return std::move(comments); }
    /// Pack syntax highlighting
    std::unique_ptr<proto::HighlightingT> BuildHighlighting();
};

}  // namespace parser
}  // namespace flatsql

#endif  // INCLUDE_FLATSQL_PARSER_PARSER_DRIVER_H_
