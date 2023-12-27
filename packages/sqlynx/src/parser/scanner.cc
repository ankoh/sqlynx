#include "sqlynx/parser/scanner.h"

#include <regex>

#include "sqlynx/external.h"
#include "sqlynx/parser/grammar/keywords.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/string_trimming.h"

using Parser = sqlynx::parser::Parser;

extern Parser::symbol_type sqlynx_yylex(void* state);

namespace sqlynx {
namespace parser {

/// Add an error
void Scanner::AddError(proto::Location location, const char* message) { output->errors.push_back({location, message}); }
/// Add an error
void Scanner::AddError(proto::Location location, std::string&& message) {
    output->errors.push_back({location, std::move(message)});
}
/// Add a line break
void Scanner::AddLineBreak(proto::Location location) { output->line_breaks.push_back(location); }
/// Add a comment
void Scanner::AddComment(proto::Location location) { output->comments.push_back(location); }

/// Read a parameter
Parser::symbol_type Scanner::ReadParameter(proto::Location loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    int64_t value;
    auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    if (result.ec == std::errc::invalid_argument) {
        AddError(loc, "invalid parameter");
    }
    return Parser::make_PARAM(loc);
}

/// Read an integer
Parser::symbol_type Scanner::ReadInteger(proto::Location loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    int64_t value;
    auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    if (result.ec == std::errc::invalid_argument) {
        return Parser::make_FCONST(loc);
    } else {
        return Parser::make_ICONST(loc);
    }
}

/// Read an unquoted identifier
Parser::symbol_type Scanner::ReadIdentifier(proto::Location loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    // Convert to lower-case
    temp_buffer = text;
    bool all_lower = true;
    for (size_t i = 0; i < temp_buffer.size(); ++i) {
        temp_buffer[i] = tolower_fuzzy(temp_buffer[i]);
        all_lower &= temp_buffer[i] == text[i];
    }
    // Check if it's a keyword
    if (auto k = Keyword::Find(temp_buffer); !!k) {
        return Parser::symbol_type(k->scanner_token, k->name, loc);
    }
    // Add string to dictionary
    std::string_view owned = text;
    if (!all_lower) {
        owned = output->name_pool.AllocateCopy(temp_buffer);
    }
    size_t id = output->RegisterName(owned, loc);
    return Parser::make_IDENT(id, loc);
}
/// Read a double quoted identifier
Parser::symbol_type Scanner::ReadDoubleQuotedIdentifier(proto::Location loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    // Trim spaces & quotes
    auto trimmed = trim_view_right(text, is_no_space);
    trimmed = trim_view(trimmed, is_no_double_quote);
    // Add string to dictionary
    size_t id = output->RegisterName(trimmed, loc);
    return Parser::make_IDENT(id, loc);
}

/// Read a string literal
Parser::symbol_type Scanner::ReadStringLiteral(proto::Location loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    auto trimmed = trim_view_right(text, is_no_space);
    return Parser::make_SCONST(sx::Location(loc.offset(), trimmed.size()));
}
/// Read a hex string literal
Parser::symbol_type Scanner::ReadHexStringLiteral(proto::Location loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    auto trimmed = trim_view_right(text, is_no_space);
    return Parser::make_XCONST(sx::Location(loc.offset(), trimmed.size()));
}
/// Read a bit string literal
Parser::symbol_type Scanner::ReadBitStringLiteral(proto::Location loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    auto trimmed = trim_view_right(text, is_no_space);
    return Parser::make_BCONST(sx::Location(loc.offset(), trimmed.size()));
}

/// Scan input and produce all tokens
std::pair<std::shared_ptr<ScannedScript>, proto::StatusCode> Scanner::Scan(const rope::Rope& text,
                                                                           ExternalID external_id) {
    // Function to get next token
    auto next = [](void* scanner_state_ptr, std::optional<Parser::symbol_type>& lookahead_symbol) {
        // Have lookahead?
        Parser::symbol_type current_symbol;
        if (lookahead_symbol) {
            current_symbol.move(*lookahead_symbol);
            lookahead_symbol.reset();
        } else {
            auto t = sqlynx_yylex(scanner_state_ptr);
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
        auto next_symbol = sqlynx_yylex(scanner_state_ptr);
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

    // Create the scanner
    Scanner scanner{text, external_id};
    // Collect all tokens until we hit EOF
    std::optional<Parser::symbol_type> lookahead_symbol;
    while (true) {
        auto token = next(scanner.scanner_state_ptr, lookahead_symbol);
        scanner.output->symbols.Append(token);
        if (token.kind() == Parser::symbol_kind::S_YYEOF) break;
    }

    // Collect scanner output
    return {std::move(scanner.output), proto::StatusCode::OK};
}

}  // namespace parser
}  // namespace sqlynx
