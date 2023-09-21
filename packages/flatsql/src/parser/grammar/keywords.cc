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

constexpr frozen::unordered_map<frozen::string, Keyword, KEYWORD_COUNT> KEYWORD_MAP = {
#define X(CATEGORY, NAME, TOKEN) {NAME, Keyword{NAME, Parser::token::FQL_##TOKEN, KeywordCategory::CATEGORY, 0}},
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
};

constexpr size_t GetCompletionWeight(std::string_view text) {
#define X(NAME, WEIGHT) \
    if (text == NAME) return WEIGHT;
    X("and", 50)
    X("as", 20)
    X("between", 20)
    X("bigint", 20)
    X("by", 20)
    X("case", 20)
    X("char", 20)
    X("count", 20)
    X("create", 20)
    X("date", 20)
    X("double", 20)
    X("end", 20)
    X("exists", 20)
    X("float", 20)
    X("from", 50)
    X("group", 20)
    X("in", 20)
    X("integer", 20)
    X("like", 20)
    X("limit", 20)
    X("not", 20)
    X("null", 50)
    X("order", 20)
    X("partition", 20)
    X("precision", 20)
    X("rows", 20)
    X("select", 50)
    X("sum", 20)
    X("table", 20)
    X("time", 20)
    X("timestamp", 20)
    X("tinyint", 20)
    X("varchar", 20)
    X("view", 20)
    X("when", 20)
    X("where", 50)
#undef X
    return 0;
};

const constexpr std::array<Keyword, KEYWORD_COUNT> SortKeywords() {
    std::array<Keyword, KEYWORD_COUNT> keywords{
#define X(CATEGORY, NAME, TOKEN) Keyword{NAME, Parser::token::FQL_##TOKEN, KeywordCategory::CATEGORY, 0},
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
    };
    std::sort(keywords.begin(), keywords.end(), [](auto& l, auto& r) { return l.name < r.name; });
    for (auto& keyword : keywords) {
        keyword.completion_weight = GetCompletionWeight(keyword.name);
    }
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
