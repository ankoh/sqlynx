#include "flatsql/utils/suffix_trie.h"

#include <initializer_list>

#include "flatsql/proto/proto_generated.h"
#include "gtest/gtest.h"

using namespace flatsql;

namespace {

void test_entries(std::initializer_list<std::string_view> entries_list,
                  std::initializer_list<std::string_view> suffixes_list) {
    std::vector<std::string_view> entries{entries_list};
    auto trie = SuffixTrie::BulkLoad(entries, [&](size_t i, auto& name) {
        return SuffixTrie::Entry{name, i, proto::NameTag::NONE};
    });
    std::vector<std::string_view> have;
    for (auto& entry : trie->GetEntries()) {
        have.push_back(entry.suffix);
    }
    std::vector<std::string_view> want{suffixes_list};
    ASSERT_EQ(have, want);
}

TEST(SuffixTrieTest, Entries0) {
    test_entries({}, {});
    test_entries({"foo"}, {"foo", "o", "oo"});
    test_entries({"foo", "bar"}, {"ar", "bar", "foo", "o", "oo", "r"});
}
TEST(SuffixTrieTest, Entries1) {
    test_entries({"1"}, {"1"});
    test_entries({"12"}, {"12", "2"});
    test_entries({"1234"}, {"1234", "234", "34", "4"});
    test_entries({"1234", "abcd"}, {"1234", "234", "34", "4", "abcd", "bcd", "cd", "d"});
}

void test_prefix(SuffixTrie& trie, std::string_view prefix, std::initializer_list<std::string_view> entries) {
    std::vector<std::string_view> have;
    SuffixTrie::IterationCallback cb = [](void* ctx, std::span<SuffixTrie::Entry> entries) {
        auto out = static_cast<std::vector<std::string_view>*>(ctx);
        for (auto& entry : entries) {
            out->push_back(entry.suffix);
        }
    };
    trie.IteratePrefix(prefix, cb, &have);
    std::vector<std::string_view> want{entries};
    ASSERT_EQ(have, want);
}

TEST(SuffixTrieTest, Prefixes0) {
    std::vector<std::string_view> entries;
    entries = {"foo", "bar"};
    auto trie = SuffixTrie::BulkLoad(entries, [&](size_t i, auto& name) {
        return SuffixTrie::Entry{name, i, proto::NameTag::NONE};
    });
    test_prefix(*trie, "f", {"foo"});
    test_prefix(*trie, "fo", {"foo"});
    test_prefix(*trie, "foo", {"foo"});
    test_prefix(*trie, "b", {"bar"});
    test_prefix(*trie, "ba", {"bar"});
    test_prefix(*trie, "bar", {"bar"});
    test_prefix(*trie, "barr", {});
    test_prefix(*trie, "baar", {});
    test_prefix(*trie, "", {"ar", "bar", "foo", "o", "oo", "r"});
    test_prefix(*trie, "not_exists", {});
}

}  // namespace
