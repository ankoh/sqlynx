#include "dashql/parser/scanner.h"

#include <charconv>
#include <deque>

#include "dashql/buffers/index_generated.h"
#include "dashql/exception.h"
#include "dashql/external.h"
#include "dashql/parser/grammar/keywords.h"
#include "dashql/parser/parser.h"
#include "dashql/script.h"
#include "dashql/utils/string_conversion.h"
#include "dashql/utils/string_trimming.h"

using Parser = dashql::parser::Parser;

extern Parser::symbol_type dashql_yylex(void* state);

namespace dashql {
namespace parser {

/// Add an error
void Scanner::AddError(buffers::parser::SymbolSpan location, const char* message) {
    output->errors.push_back({buffers::parser::TextSpan(location.offset(), location.length()), message});
}
/// Add an error
void Scanner::AddError(buffers::parser::SymbolSpan location, std::string&& message) {
    output->errors.push_back({buffers::parser::TextSpan(location.offset(), location.length()), std::move(message)});
}
/// Add a line break
void Scanner::AddLineBreak(buffers::parser::SymbolSpan location) {
    output->line_breaks.push_back(buffers::parser::TextSpan(location.offset(), location.length()));
}
/// Add a comment
void Scanner::AddComment(buffers::parser::SymbolSpan location) {
    output->comments.push_back(buffers::parser::TextSpan(location.offset(), location.length()));
}

/// Add a literal that Hyper obfuscated.
/// The marker carries the type and a 4-digit hex hash, we derive a literal of that type from the hash.
void Scanner::AddObfuscatedLiteral(buffers::parser::SymbolSpan location) {
    auto marker = std::string_view{output->text_buffer}.substr(location.offset(), location.length());
    // /*<Type>(<HASH>)*/
    auto open = marker.find('(');
    auto type = marker.substr(2, open - 2);
    auto hash = marker.substr(open + 1, 4);
    auto value = std::stoul(std::string{hash}, nullptr, 16);
    std::string replacement;
    if (type == "String") {
        replacement = "'" + std::string{hash} + "'";
    } else if (type == "Integer") {
        replacement = std::to_string(value);
    } else if (type == "Float") {
        replacement = std::to_string(value) + ".0";
    } else if (type == "HexString") {
        replacement = "X'" + std::string{hash} + "'";
    } else {
        replacement = "B'";
        for (int bit = 15; bit >= 0; --bit) replacement += ((value >> bit) & 1) ? '1' : '0';
        replacement += "'";
    }
    output->obfuscated_literals.push_back(
        {buffers::parser::TextSpan(location.offset(), location.length()), std::move(replacement)});
}

/// Read an integer
Parser::symbol_type Scanner::ReadInteger(buffers::parser::SymbolSpan loc) {
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
Parser::symbol_type Scanner::ReadIdentifier(buffers::parser::SymbolSpan loc) {
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
        if (k->category == KeywordCategory::VIS_UNRESERVED) {
            output->name_registry.Register(k->name, buffers::parser::TextSpan(loc.offset(), loc.length()));
        }
        return Parser::symbol_type(k->scanner_token, k->name, loc);
    }
    // Add string to dictionary
    std::string_view owned = text;
    if (!all_lower) {
        owned = output->name_pool.AllocateCopy(temp_buffer);
    }
    size_t id = output->name_registry.Register(owned, buffers::parser::TextSpan(loc.offset(), loc.length())).name_id;
    return Parser::make_IDENT(id, loc);
}
/// Read a double quoted identifier
Parser::symbol_type Scanner::ReadDoubleQuotedIdentifier(buffers::parser::SymbolSpan loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    // Strip exactly the delimiters; doubled quotes belong to the identifier.
    auto trimmed = trim_view_right(text, is_no_space);
    trimmed = trimmed.substr(1, trimmed.size() - 2);
    if (trimmed.find('"') != std::string_view::npos) {
        temp_buffer.clear();
        for (size_t i = 0; i < trimmed.size(); ++i) {
            temp_buffer.push_back(trimmed[i]);
            if (trimmed[i] == '"' && i + 1 < trimmed.size() && trimmed[i + 1] == '"') ++i;
        }
        trimmed = output->name_pool.AllocateCopy(temp_buffer);
    }
    // Add string to dictionary
    size_t id = output->name_registry.Register(trimmed, buffers::parser::TextSpan(loc.offset(), loc.length())).name_id;
    return Parser::make_IDENT(id, loc);
}
/// Read a backtick quoted identifier
Parser::symbol_type Scanner::ReadBacktickQuotedIdentifier(buffers::parser::SymbolSpan loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    auto trimmed = trim_view_right(text, is_no_space);
    trimmed = trimmed.substr(1, trimmed.size() - 2);
    if (trimmed.find('`') != std::string_view::npos) {
        temp_buffer.clear();
        for (size_t i = 0; i < trimmed.size(); ++i) {
            temp_buffer.push_back(trimmed[i]);
            if (trimmed[i] == '`' && i + 1 < trimmed.size() && trimmed[i + 1] == '`') ++i;
        }
        trimmed = output->name_pool.AllocateCopy(temp_buffer);
    }
    size_t id = output->name_registry.Register(trimmed, buffers::parser::TextSpan(loc.offset(), loc.length())).name_id;
    return Parser::make_IDENT(id, loc);
}

/// Read a string literal
Parser::symbol_type Scanner::ReadStringLiteral(buffers::parser::SymbolSpan loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    auto trimmed = trim_view_right(text, is_no_space);
    return Parser::make_SCONST(sx::parser::SymbolSpan(loc.offset(), trimmed.size()));
}
/// Read a hex string literal
Parser::symbol_type Scanner::ReadHexStringLiteral(buffers::parser::SymbolSpan loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    auto trimmed = trim_view_right(text, is_no_space);
    return Parser::make_XCONST(sx::parser::SymbolSpan(loc.offset(), trimmed.size()));
}
/// Read a bit string literal
Parser::symbol_type Scanner::ReadBitStringLiteral(buffers::parser::SymbolSpan loc) {
    auto text = GetInputData().substr(loc.offset(), loc.length());
    auto trimmed = trim_view_right(text, is_no_space);
    return Parser::make_BCONST(sx::parser::SymbolSpan(loc.offset(), trimmed.size()));
}

/// Scan input and produce all tokens
std::shared_ptr<ScannedScript> Scanner::Scan(const rope::Rope& text, TextVersion text_version,
                                             CatalogEntryID external_id) {
    // Function to get next token
    auto next = [](void* scanner_state_ptr, std::deque<Parser::symbol_type>& lookahead_symbols) {
        // Have lookahead?
        Parser::symbol_type current_symbol;
        if (!lookahead_symbols.empty()) {
            current_symbol.move(lookahead_symbols.front());
            lookahead_symbols.pop_front();
        } else {
            auto t = dashql_yylex(scanner_state_ptr);
            current_symbol.move(t);
        }

        // Requires additional lookahead?
        switch (current_symbol.kind()) {
            case Parser::symbol_kind::S_NOT:
            case Parser::symbol_kind::S_NULLS_P:
            case Parser::symbol_kind::S_WITH:
            case Parser::symbol_kind::S_DOT:
            case Parser::symbol_kind::S_VISUALISE:
            case Parser::symbol_kind::S_VISUALIZE:
                break;
            default:
                return current_symbol;
        }

        // Get next token
        auto next_symbol = dashql_yylex(scanner_state_ptr);
        auto next_symbol_kind = next_symbol.kind();
        lookahead_symbols.push_back(std::move(next_symbol));

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
            case Parser::symbol_kind::S_DOT:
                // Separate qualified wildcards from ordinary dotted indirection.
                if (next_symbol_kind == Parser::symbol_kind::S_STAR) {
                    return Parser::make_DOT_STAR_LA(current_symbol.location);
                }
                break;
            case Parser::symbol_kind::S_VISUALISE:
            case Parser::symbol_kind::S_VISUALIZE:
                if (next_symbol_kind == Parser::symbol_kind::S_USING) {
                    auto renderer = dashql_yylex(scanner_state_ptr);
                    auto renderer_kind = renderer.kind();
                    lookahead_symbols.push_back(std::move(renderer));
                    if (renderer_kind == Parser::symbol_kind::S_VEGALITE ||
                        renderer_kind == Parser::symbol_kind::S_UMAP ||
                        renderer_kind == Parser::symbol_kind::S_MARKDOWN ||
                        renderer_kind == Parser::symbol_kind::S_TABLE) {
                        auto text = current_symbol.kind() == Parser::symbol_kind::S_VISUALISE
                                        ? std::string_view{"visualise"}
                                        : std::string_view{"visualize"};
                        return Parser::make_VISUALIZE_LA(text, current_symbol.location);
                    }
                }
                break;
            default:
                break;
        }
        return current_symbol;
    };

    // Create the scanner
    Scanner scanner{text, text_version, external_id};
    // Collect all tokens until we hit EOF
    std::deque<Parser::symbol_type> lookahead_symbols;
    while (true) {
        auto token = next(scanner.scanner_state_ptr, lookahead_symbols);
        scanner.output->symbols.PushBack(token);
        if (token.kind() == Parser::symbol_kind::S_YYEOF) break;
    }

    // Collect scanner output
    return std::move(scanner.output);
}

}  // namespace parser
}  // namespace dashql
