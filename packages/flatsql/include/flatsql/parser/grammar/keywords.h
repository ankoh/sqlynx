#pragma once

#include <string_view>

#include "flatsql/parser/parser.h"

namespace flatsql {
namespace parser {

/// A keyword category
enum class KeywordCategory { FLATSQL, SQL_COLUMN_NAME, SQL_RESERVED, SQL_TYPE_FUNC, SQL_UNRESERVED };

/// A keyword
struct Keyword {
    /// The name
    std::string_view name;
    /// The token
    Parser::token::token_kind_type token;
    /// The category
    KeywordCategory category;

    /// Get a span with all keywords
    static std::span<const Keyword> GetKeywords();
    /// Get a keyword name
    static std::string_view GetKeywordName(Parser::token::token_kind_type token);
    /// Find a keyword
    static const Keyword* Find(std::string_view text);
    /// Get the length of a keyword known at compile-time
    static constexpr size_t ConstLength(const char* str) { return *str ? 1 + ConstLength(str + 1) : 0; }
};

}  // namespace parser
}  // namespace flatsql
