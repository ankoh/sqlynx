#include "flatsql/parser/scanner.h"

#include <regex>

#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/parser/parser_driver.h"
#include "flatsql/utils/string.h"

using Parser = flatsql::parser::Parser;

extern Parser::symbol_type flatsql_yylex(void* state);

namespace flatsql {
namespace parser {

/// Add an error
void Scanner::AddError(proto::Location location, const char* message) { errors.push_back({location, message}); }
/// Add an error
void Scanner::AddError(proto::Location location, std::string&& message) {
    errors.push_back({location, std::move(message)});
}
/// Add a line break
void Scanner::AddLineBreak(proto::Location location) { line_breaks.push_back(location); }
/// Add a comment
void Scanner::AddComment(proto::Location location) { comments.push_back(location); }

/// Read a parameter
Parser::symbol_type Scanner::ReadParameter(std::string_view text, proto::Location loc) {
    int64_t value;
    auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    if (result.ec == std::errc::invalid_argument) {
        AddError(loc, "invalid parameter");
    }
    return Parser::make_PARAM(loc);
}

/// Read an integer
Parser::symbol_type Scanner::ReadInteger(std::string_view text, proto::Location loc) {
    int64_t value;
    auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    if (result.ec == std::errc::invalid_argument) {
        return Parser::make_FCONST(loc);
    } else {
        return Parser::make_ICONST(loc);
    }
}

/// Add a string to the string dicationary
size_t Scanner::AddStringToDictionary(std::string_view s, sx::Location location) {
    auto iter = string_dictionary_ids.find(s);
    if (iter != string_dictionary_ids.end()) {
        return iter->second;
    }
    auto copy = string_pool.AllocateCopy(s);
    // XXX Harmonize the string
    auto id = string_dictionary_locations.size();
    string_dictionary_ids.insert({copy, id});
    string_dictionary_locations.push_back(location);
    return id;
}
/// Read an unquoted identifier
Parser::symbol_type Scanner::ReadIdentifier(std::string_view text, proto::Location loc) {
    if (auto k = Keyword::Find(text); !!k) {
        return Parser::symbol_type(k->token, loc);
    }
    size_t id = AddStringToDictionary(text, loc);
    return Parser::make_IDENT(id, loc);
}
/// Read a double quoted identifier
Parser::symbol_type Scanner::ReadDoubleQuotedIdentifier(std::string& text, proto::Location loc) {
    // XXX
    return Parser::make_IDENT(0, loc);
}

/// Read a string literal
Parser::symbol_type Scanner::ReadStringLiteral(std::string& text, proto::Location loc) {
    auto trimmed = rtrimview(text, isNoSpace);
    return Parser::make_SCONST(sx::Location(loc.offset(), trimmed.size()));
}
/// Read a hex string literal
Parser::symbol_type Scanner::ReadHexStringLiteral(std::string& text, proto::Location loc) {
    auto trimmed = rtrimview(text, isNoSpace);
    return Parser::make_XCONST(sx::Location(loc.offset(), trimmed.size()));
}
/// Read a bit string literal
Parser::symbol_type Scanner::ReadBitStringLiteral(std::string& text, proto::Location loc) {
    auto trimmed = rtrimview(text, isNoSpace);
    return Parser::make_BCONST(sx::Location(loc.offset(), trimmed.size()));
}

/// Scan the next input data
void Scanner::ScanNextInputData(void* out_buffer, size_t& out_bytes_read, size_t max_size) {
    // Invariant: current_leaf_node != nullptr means we have data
    assert(current_leaf_node == nullptr || current_leaf_node->GetSize() > current_leaf_offset);
    // Check if we reached the end
    if (current_leaf_node == nullptr) {
        out_bytes_read = 0;
        return;
    }
    // Copy input data
    auto max_here = current_leaf_node->GetSize() - current_leaf_offset;
    auto read_here = std::min<size_t>(max_size, max_here);
    std::memcpy(out_buffer, current_leaf_node->GetData().data() + current_leaf_offset, read_here);
    current_leaf_offset += read_here;
    // Did we hit the end of the leaf?
    if (current_leaf_offset == current_leaf_node->GetSize()) {
        current_leaf_node = current_leaf_node->GetNext();
        current_leaf_offset = 0;
    }
    out_bytes_read = read_here;
}

/// Scan input and produce all tokens
void Scanner::Tokenize() {
    // Function to get next token
    auto next = [](void* scanner_state_ptr, std::optional<Parser::symbol_type>& lookahead_symbol) {
        // Have lookahead?
        Parser::symbol_type current_symbol;
        if (lookahead_symbol) {
            current_symbol.move(*lookahead_symbol);
            lookahead_symbol.reset();
        } else {
            auto t = flatsql_yylex(scanner_state_ptr);
            current_symbol.move(t);
        }

        // Requires additional lookahead?
        switch (current_symbol.kind()) {
            case Parser::symbol_kind::S_NOT:
            case Parser::symbol_kind::S_NULLS_P:
            case Parser::symbol_kind::S_WITH:
                break;
            default:
                return current_symbol;
        }

        // Get next token
        auto next_symbol = flatsql_yylex(scanner_state_ptr);
        auto next_symbol_kind = next_symbol.kind();
        lookahead_symbol.emplace(std::move(next_symbol));

        // Should replace current token?
        switch (current_symbol.kind()) {
            case Parser::symbol_kind::S_NOT:
                // Replace NOT by NOT_LA if it's followed by BETWEEN, IN, etc
                switch (next_symbol_kind) {
                    case Parser::symbol_kind::S_BETWEEN:
                    case Parser::symbol_kind::S_IN_P:
                    case Parser::symbol_kind::S_LIKE:
                    case Parser::symbol_kind::S_ILIKE:
                    case Parser::symbol_kind::S_SIMILAR:
                        return Parser::make_NOT_LA(current_symbol.location);
                    default:
                        break;
                }
                break;

            case Parser::symbol_kind::S_NULLS_P:
                // Replace NULLS_P by NULLS_LA if it's followed by FIRST or LAST
                switch (next_symbol_kind) {
                    case Parser::symbol_kind::S_FIRST_P:
                    case Parser::symbol_kind::S_LAST_P:
                        return Parser::make_NULLS_LA(current_symbol.location);
                    default:
                        break;
                }
                break;
            case Parser::symbol_kind::S_WITH:
                // Replace WITH by WITH_LA if it's followed by TIME or ORDINALITY
                switch (next_symbol_kind) {
                    case Parser::symbol_kind::S_TIME:
                    case Parser::symbol_kind::S_ORDINALITY:
                        return Parser::make_WITH_LA(current_symbol.location);
                    default:
                        break;
                }
                break;
            default:
                break;
        }
        return current_symbol;
    };

    // Collect all tokens until we hit EOF
    if (symbols.GetSize() == 0) {
        std::optional<Parser::symbol_type> lookahead_symbol;
        while (true) {
            auto token = next(internal_scanner_state, lookahead_symbol);
            symbols.Append(token);
            if (token.kind() == Parser::symbol_kind::S_YYEOF) break;
        }
    }
    symbol_scanner.Reset();
}

}  // namespace parser
}  // namespace flatsql
