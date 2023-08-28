#include "flatsql/parser/grammar/keywords.h"

#include <algorithm>

#include "gtest/gtest.h"

using namespace flatsql::parser;

namespace {

TEST(KeywordsTest, ConstLength) { EXPECT_EQ(Keyword::ConstLength("foo"), 3); }

TEST(KeywordsTest, KeywordsAreSorted) {
    auto keywords = Keyword::GetKeywords();
    auto keywords_are_sorted =
        std::is_sorted(keywords.begin(), keywords.end(), [](auto& l, auto& r) { return l.name < r.name; });
    EXPECT_TRUE(keywords_are_sorted);
}

}  // namespace
