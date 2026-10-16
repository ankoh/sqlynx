#pragma once

#include <string_view>

#include "dashql/parser/parser.h"
#include "dashql/buffers/index_generated.h"

namespace dashql {
namespace parser {

/// Helper to match raw characters.
/// These characters are matched directly in the PostgreSQL grammar.
/// We introduce dedicated tokens to
inline Parser::symbol_type matchSpecialCharacter(char c, Parser::location_type loc) {
    switch (c) {
#define X(CHAR, SYMBOL) \
    case CHAR:          \
        return Parser::make_##SYMBOL(loc)
        X(',', COMMA);
        X('(', LRB);
        X(')', RRB);
        X('[', LSB);
        X(']', RSB);
        X('{', LCB);
        X('}', RCB);
        X('.', DOT);
        X(';', SEMICOLON);
        X(':', COLON);
        X('+', PLUS);
        X('-', MINUS);
        X('*', STAR);
        X('/', DIVIDE);
        X('%', MODULO);
        X('?', QUESTION_MARK);
        X('^', CIRCUMFLEX);
        X('&', AMPERSAND);
        X('|', PIPE);
        X('!', EXCLAMATION_MARK);
        X('<', LESS_THAN);
        X('>', GREATER_THAN);
        X('=', EQUALS);
#undef X
        default:
            __builtin_unreachable();
    }
}

}  // namespace parser
}  // namespace dashql
