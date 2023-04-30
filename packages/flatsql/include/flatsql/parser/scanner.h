#pragma once

#include <charconv>
#include <optional>
#include <string_view>
#include <unordered_set>

#include "ankerl/unordered_dense.h"
#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/string_pool.h"

namespace flatsql {
namespace parser {

class ParseContext;

class Scanner {
    friend class ScannedProgram;

   protected:
    /// The internal scanner state
    void* internal_scanner_state = nullptr;

    /// The full input data
    rope::Rope& input_data;
    /// The current leaf node
    rope::LeafNode* current_leaf_node = nullptr;
    /// The local offset of the value within the current leaf
    size_t current_leaf_offset = 0;

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

    /// The string pool
    StringPool<1024> string_pool;
    /// The string dictionary ids
    ankerl::unordered_dense::map<std::string_view, size_t> string_dictionary_ids;
    /// The string dictionary locations
    std::vector<sx::Location> string_dictionary_locations;

    /// All symbols
    ChunkBuffer<Parser::symbol_type> symbols = {};

   public:
    // Helpers that are used from the generated flex scanner

    /// The global offset within the rope
    size_t current_input_offset = 0;
    /// Temporary buffer to modify text across flex actions
    std::string temp_buffer;
    /// Begin of the active extended lexer rules
    sx::Location ext_begin;
    /// Nesting depth of the active extended lexer rules
    size_t ext_depth = 0;

    /// Scan next input data
    void ScanNextInputData(void* out_buffer, size_t& out_bytes_read, size_t max_size);

    /// Get a numeric identifier for a string
    size_t AddStringToDictionary(std::string_view s, sx::Location location);

    /// Read a parameter
    Parser::symbol_type ReadParameter(std::string_view text, proto::Location loc);
    /// Read an integer
    Parser::symbol_type ReadInteger(std::string_view text, proto::Location loc);
    /// Read an identifier
    Parser::symbol_type ReadIdentifier(std::string_view text, proto::Location loc);
    /// Read a double-quoted identifier
    Parser::symbol_type ReadDoubleQuotedIdentifier(std::string& text, proto::Location loc);
    /// Read a string literal
    Parser::symbol_type ReadStringLiteral(std::string& text, proto::Location loc);
    /// Read a hex literal
    Parser::symbol_type ReadHexStringLiteral(std::string& text, proto::Location loc);
    /// Read a hex literal
    Parser::symbol_type ReadBitStringLiteral(std::string& text, proto::Location loc);

    /// Add an error
    void AddError(proto::Location location, const char* message);
    /// Add an error
    void AddError(proto::Location location, std::string&& message);
    /// Add a line break
    void AddLineBreak(proto::Location location);
    /// Add a comment
    void AddComment(proto::Location location);

   protected:
    /// Constructor
    Scanner(rope::Rope& rope);
    /// Destructor
    ~Scanner();
    /// Delete the copy constructor
    Scanner(const Scanner& other) = delete;
    /// Delete the copy assignment
    Scanner& operator=(const Scanner& other) = delete;

   public:
    /// Scan input and produce all tokens
    static std::unique_ptr<ScannedProgram> Scan(rope::Rope& rope);
};

}  // namespace parser
}  // namespace flatsql
