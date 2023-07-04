#include "flatsql/parser/grammar/keywords.h"

#include "gtest/gtest.h"

using namespace flatsql::parser;

namespace {

TEST(KeywordsTest, ConstLength) { EXPECT_EQ(Keyword::ConstLength("foo"), 3); }

}  // namespace
