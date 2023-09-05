#include "flatsql/analyzer/completion.h"

#include "gtest/gtest.h"

using namespace flatsql;

namespace {

TEST(CompletionTest, KeywordSuffixCount) {
    auto& keywords = CompletionIndex::Keywords();
    ASSERT_EQ(keywords.GetEntries().size(), 2875);
}

}  // namespace
