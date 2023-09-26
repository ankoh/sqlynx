#include "flatsql/parser/grammar/keywords.h"

#include "flatsql/analyzer/completion.h"
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

constexpr int64_t KEYWORD_MAX_ID = std::max<int64_t>({
#define X(CATEGORY, NAME, TOKEN) static_cast<int64_t>(Parser::token::FQL_##TOKEN),
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
    0});
constexpr size_t KEYWORD_NAME_COUNT = KEYWORD_MAX_ID + 1;

constexpr frozen::unordered_map<frozen::string, Keyword, KEYWORD_COUNT> KEYWORD_MAP = {
#define X(CATEGORY, NAME, TOKEN) {NAME, Keyword{NAME, Parser::token::FQL_##TOKEN, KeywordCategory::CATEGORY}},
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
};

static constexpr std::array<std::string_view, KEYWORD_NAME_COUNT> GetKeywordNames() {
    std::array<std::string_view, KEYWORD_NAME_COUNT> keywords;
    for (auto& [key, value] : KEYWORD_MAP) {
        int64_t i = static_cast<int64_t>(value.token);
        if (i >= 0) {
            keywords[i] = value.name;
        }
    }
    return keywords;
}
static const std::array<std::string_view, KEYWORD_NAME_COUNT> KEYWORD_NAMES = GetKeywordNames();

const constexpr std::array<Keyword, KEYWORD_COUNT> SortKeywords() {
    std::array<Keyword, KEYWORD_COUNT> keywords{
#define X(CATEGORY, NAME, TOKEN) Keyword{NAME, Parser::token::FQL_##TOKEN, KeywordCategory::CATEGORY},
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
    };
    std::sort(keywords.begin(), keywords.end(), [](auto& l, auto& r) { return l.name < r.name; });
    return keywords;
};
static const std::array<Keyword, KEYWORD_COUNT> SORTED_KEYWORDS = SortKeywords();

constexpr size_t MAX_KEYWORD_LENGTH = std::max<size_t>({
#define X(CATEGORY, NAME, TOKEN) Keyword::ConstLength(NAME),
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
});

/// Get sorted keywords
std::span<const Keyword> Keyword::GetKeywords() { return {SORTED_KEYWORDS.begin(), SORTED_KEYWORDS.size()}; }
/// Get a keyword name
std::string_view Keyword::GetKeywordName(Parser::token::token_kind_type token) {
    return KEYWORD_NAMES[std::max<int64_t>(0, static_cast<int64_t>(token))];
}
/// Find a keyword
const Keyword* Keyword::Find(std::string_view text) {
    // Abort early if the keyword exceeds the max keyword size
    if (text.size() > MAX_KEYWORD_LENGTH) return nullptr;
    // Find the keyword
    if (auto iter = KEYWORD_MAP.find(text); iter != KEYWORD_MAP.end()) return &iter->second;
    return nullptr;
}

}  // namespace parser
}  // namespace flatsql
