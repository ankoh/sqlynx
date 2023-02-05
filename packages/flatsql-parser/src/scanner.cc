#include "flatsql/parser/scanner.h"

#include <regex>

#include "flatsql/parser/parser_driver.h"

using Parser = flatsql::parser::Parser;

extern Parser::symbol_type flatsql_yylex(void* state);

namespace flatsql {
namespace parser {

/// Get the text at location
std::string_view Scanner::TextAt(proto::Location loc) { return input_text().substr(loc.offset(), loc.length()); }
/// Get the text at location
proto::Location Scanner::LocationOf(std::string_view text) {
    return proto::Location(text.begin() - input_text().begin(), text.length());
}
/// Begin a literal
void Scanner::BeginLiteral(proto::Location loc) { literal_begin_ = loc; }

/// End a literal
proto::Location Scanner::EndLiteral(proto::Location loc, bool trim_right) {
    auto begin = literal_begin_.offset();
    auto end = loc.offset() + loc.length();
    if (trim_right) {
        auto text = input_text();
        for (; begin < end; --end) {
            auto c = text[end - 1];
            if (c == ' ' || c == '\n') {
                continue;
            }
            break;
        }
    }
    return proto::Location(begin, end - begin);
}

/// Begin a comment
void Scanner::BeginComment(proto::Location loc) {
    if (comment_depth_++ == 0) {
        comment_begin_ = loc;
    }
}
/// End a comment
std::optional<proto::Location> Scanner::EndComment(proto::Location loc) {
    if (--comment_depth_ == 0) {
        return proto::Location(literal_begin_.offset(), loc.offset() + loc.length() - literal_begin_.offset());
    }
    return std::nullopt;
}

/// Add an error
void Scanner::AddError(proto::Location location, const char* message) { errors_.push_back({location, message}); }

/// Add an error
void Scanner::AddError(proto::Location location, std::string&& message) {
    errors_.push_back({location, std::move(message)});
}

/// Add a line break
void Scanner::AddLineBreak(proto::Location location) {
    line_breaks_.push_back(location);
    symbol_line_breaks_.push_back(symbols_.size());
}

/// Add a comment
void Scanner::AddComment(proto::Location location) { comments_.push_back(location); }
/// Mark a location as start of an option key
void Scanner::MarkAsVarArgKey(proto::Location location) { dson_key_offsets_.insert(location.offset()); }

/// Read a parameter
Parser::symbol_type Scanner::ReadParameter(proto::Location loc) {
    auto text = TextAt(loc);
    int64_t value;
    auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    if (result.ec == std::errc::invalid_argument) {
        AddError(loc, "invalid parameter");
    }
    return Parser::make_PARAM(loc);
}

/// Read an integer
Parser::symbol_type Scanner::ReadInteger(proto::Location loc) {
    auto text = TextAt(loc);
    int64_t value;
    auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    if (result.ec == std::errc::invalid_argument) {
        return Parser::make_FCONST(loc);
    } else {
        return Parser::make_ICONST(loc);
    }
}

/// Produce all tokens
void Scanner::Produce() {
    Parser::symbol_type current_symbol;
    std::optional<Parser::symbol_type> lookahead_symbol_;

    // Function to get next token
    auto next = [&]() {
        // Have lookahead?
        Parser::symbol_type current_symbol;
        if (lookahead_symbol_) {
            current_symbol.move(*lookahead_symbol_);
            lookahead_symbol_.reset();
        } else {
            auto t = flatsql_yylex(scanner_state_ptr_);
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
        auto next_symbol = flatsql_yylex(scanner_state_ptr_);
        auto next_symbol_kind = next_symbol.kind();
        lookahead_symbol_.emplace(std::move(next_symbol));

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
    if (symbols_.empty()) {
        while (true) {
            auto token = next();
            symbols_.push_back(token);
            if (token.kind() == Parser::symbol_kind::S_YYEOF) break;
        }
    }
    next_symbol_index_ = 0;
}

/// Get the next symbole
Parser::symbol_type Scanner::Next() {
    assert(next_symbol_index_ < symbols_.size());
    return symbols_[next_symbol_index_++];
}

}  // namespace parser
}  // namespace flatsql
