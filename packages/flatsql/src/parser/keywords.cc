#include "flatsql/parser/grammar/keywords.h"

#include <unordered_map>

#include "frozen/string.h"
#include "frozen/unordered_map.h"

namespace flatsql {
namespace parser {

constexpr size_t KEYWORD_COUNT = 0
#define X(CATEGORY, NAME, TOKEN) +1
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
    ;

constexpr frozen::unordered_map<frozen::string, Keyword, KEYWORD_COUNT> KEYWORD_MAP = {
#define X(CATEGORY, NAME, TOKEN) {NAME, Keyword{NAME, Parser::token::FQL_##TOKEN, KeywordCategory::CATEGORY}},
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
};

constexpr size_t MAX_KEYWORD_LENGTH = std::max<size_t>({
#define X(CATEGORY, NAME, TOKEN) Keyword::ConstLength(NAME),
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
});

/// Find a keyword
const Keyword* Keyword::Find(std::string_view text) {
    // Abort early if the keyword exceeds the max keyword size
    if (text.size() > MAX_KEYWORD_LENGTH) return nullptr;

    // Convert to lowercase
    char buffer[MAX_KEYWORD_LENGTH + 1];
    for (unsigned i = 0; i < text.size(); ++i) buffer[i] = ::tolower(text[i]);
    std::string_view text_lc{buffer, text.size()};

    // Find the keyword
    if (auto iter = KEYWORD_MAP.find(text_lc); iter != KEYWORD_MAP.end()) return &iter->second;
    return nullptr;
}

}  // namespace parser
}  // namespace flatsql
