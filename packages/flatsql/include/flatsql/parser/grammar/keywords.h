#ifndef INCLUDE_FLATSQL_PARSER_GRAMMAR_KEYWORDS_H_
#define INCLUDE_FLATSQL_PARSER_GRAMMAR_KEYWORDS_H_

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

    /// Find a keyword
    static const Keyword* Find(std::string_view text);
};

}  // namespace parser
}  // namespace flatsql

#endif
