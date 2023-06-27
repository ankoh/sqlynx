#include "flatsql/parser/grammar/keywords.h"
#include "gtest/gtest.h"

using namespace flatsql::parser;

TEST(KeywordsTest, ConstLength) {
    ASSERT_EQ(Keyword::ConstLength("foo"), 3);
}
