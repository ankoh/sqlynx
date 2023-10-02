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

constexpr int64_t KEYWORD_MAX_SYMBOL_ID = std::max<int64_t>({
#define X(CATEGORY, NAME, KEYWORD) static_cast<int64_t>(Parser::symbol_kind_type::S_##KEYWORD),
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
    0});
constexpr size_t KEYWORD_SYMBOL_COUNT = KEYWORD_MAX_SYMBOL_ID + 1;

constexpr frozen::unordered_map<frozen::string, Keyword, KEYWORD_COUNT> KEYWORD_MAP = {
#define X(CATEGORY, NAME, KEYWORD) \
    {NAME,                         \
     Keyword{NAME, Parser::token::FQL_##KEYWORD, Parser::symbol_kind_type::S_##KEYWORD, KeywordCategory::CATEGORY}},
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
};

static constexpr std::array<std::string_view, KEYWORD_SYMBOL_COUNT> GetKeywordSymbolNames() {
    std::array<std::string_view, KEYWORD_SYMBOL_COUNT> keywords;
    for (auto& [key, value] : KEYWORD_MAP) {
        int64_t i = static_cast<int64_t>(value.parser_symbol);
        if (i >= 0) {
            keywords[i] = value.name;
        }
    }
    return keywords;
}
static const std::array<std::string_view, KEYWORD_SYMBOL_COUNT> KEYWORD_SYMBOL_NAMES = GetKeywordSymbolNames();

const constexpr std::array<Keyword, KEYWORD_COUNT> SortKeywords() {
    std::array<Keyword, KEYWORD_COUNT> keywords{
#define X(CATEGORY, NAME, TOKEN) \
    Keyword{NAME, Parser::token::FQL_##TOKEN, Parser::symbol_kind_type::S_##TOKEN, KeywordCategory::CATEGORY},
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
std::string_view Keyword::GetKeywordName(Parser::symbol_kind_type sym) {
    auto sym_id = static_cast<int64_t>(sym);
    if (sym_id >= 0 && sym_id < KEYWORD_SYMBOL_COUNT) {
        return KEYWORD_SYMBOL_NAMES[sym_id];
    }
    return "";
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
