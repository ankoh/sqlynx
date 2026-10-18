#pragma once

#include <string_view>

#include "dashql/buffers/index_generated.h"
#include "dashql/external.h"
#include "dashql/parser/parser.h"
#include "dashql/script.h"
#include "dashql/text/rope.h"

namespace dashql {
namespace parser {

constexpr size_t YY_SCANNER_STATE_SIZE = 300;
constexpr size_t YY_BUFFER_STATE_SIZE = 200;

class Scanner {
    friend class ScannedProgram;

   protected:
    /// The scanner state
    std::array<char, YY_SCANNER_STATE_SIZE> scanner_state_mem = {};
    /// The buffer state
    std::array<char, YY_BUFFER_STATE_SIZE> scanner_buffer_state_mem = {};
    /// The scanner buffer stack
    std::array<void*, 2> scanner_buffer_stack = {};
    /// The scanner state ptr
    void* scanner_state_ptr = nullptr;

    /// The output
    std::shared_ptr<ScannedScript> output;

   public:
    /// The input data
    std::span<char> input_data;
    /// Temporary buffer to modify text across flex actions
    std::string temp_buffer;
    /// Begin of the active extended lexer rules
    sx::parser::SymbolSpan ext_begin;
    /// Nesting depth of the active extended lexer rules
    size_t ext_depth = 0;

    /// Read a parameter
    std::string_view GetInputData() const { return {input_data.data(), input_data.size()}; };
    /// Read a parameter
    /// Read an integer
    Parser::symbol_type ReadInteger(buffers::parser::SymbolSpan loc);
    /// Read an identifier
    Parser::symbol_type ReadIdentifier(buffers::parser::SymbolSpan loc);
    /// Read a double-quoted identifier
    Parser::symbol_type ReadDoubleQuotedIdentifier(buffers::parser::SymbolSpan loc);
    /// Read a backtick-quoted identifier
    Parser::symbol_type ReadBacktickQuotedIdentifier(buffers::parser::SymbolSpan loc);
    /// Read a string literal
    Parser::symbol_type ReadStringLiteral(buffers::parser::SymbolSpan loc);
    /// Read a hex literal
    Parser::symbol_type ReadHexStringLiteral(buffers::parser::SymbolSpan loc);
    /// Read a hex literal
    Parser::symbol_type ReadBitStringLiteral(buffers::parser::SymbolSpan loc);

    /// Add an error
    void AddError(buffers::parser::SymbolSpan location, const char* message);
    /// Add an error
    void AddError(buffers::parser::SymbolSpan location, std::string&& message);
    /// Add a line break
    void AddLineBreak(buffers::parser::SymbolSpan location);
    /// Add a comment
    void AddComment(buffers::parser::SymbolSpan location);
    /// Add a literal that Hyper obfuscated, e.g. /*Integer(4888)*/
    void AddObfuscatedLiteral(buffers::parser::SymbolSpan location);

   protected:
    /// Constructor
    Scanner(const rope::Rope& text, TextVersion text_version, CatalogEntryID external_id);
    /// Delete the copy constructor
    Scanner(const Scanner& other) = delete;
    /// Delete the copy assignment
    Scanner& operator=(const Scanner& other) = delete;

   public:
    /// Scan input and produce all tokens (throws Exception on error)
    static std::shared_ptr<ScannedScript> Scan(const rope::Rope& text, TextVersion text_version,
                                                CatalogEntryID external_id);
};

}  // namespace parser
}  // namespace dashql
