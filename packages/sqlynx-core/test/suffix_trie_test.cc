#include "sqlynx/utils/suffix_trie.h"

#include <initializer_list>

#include "sqlynx/proto/proto_generated.h"
#include "gtest/gtest.h"

using namespace sqlynx;

namespace {

void test_entries(std::initializer_list<SuffixTrie::StringView> entries_list,
                  std::initializer_list<SuffixTrie::StringView> suffixes_list) {
    std::vector<SuffixTrie::StringView> entries{entries_list};
    auto trie = SuffixTrie::BulkLoad(entries, [&](size_t i, auto& name) {
        return SuffixTrie::Entry{name, i, proto::NameTag::NONE};
    });
    std::vector<SuffixTrie::StringView> have;
    for (auto& entry : trie->GetEntries()) {
        have.push_back(entry.suffix);
    }
    std::vector<SuffixTrie::StringView> want{suffixes_list};
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

void test_prefix(SuffixTrie& trie, SuffixTrie::StringView prefix,
                 std::initializer_list<SuffixTrie::StringView> entries) {
    std::vector<SuffixTrie::StringView> have;
    SuffixTrie::IterationCallback cb = [](void* ctx, std::span<SuffixTrie::Entry> entries) {
        auto out = static_cast<std::vector<SuffixTrie::StringView>*>(ctx);
        for (auto& entry : entries) {
            out->push_back(entry.suffix);
        }
    };
    trie.IteratePrefix(prefix, cb, &have);
    std::vector<SuffixTrie::StringView> want{entries};
    ASSERT_EQ(have, want);
}

TEST(SuffixTrieTest, Prefixes0) {
    std::vector<SuffixTrie::StringView> entries;
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

TEST(SuffixTrieTest, CaseSensitivity) {
    std::vector<SuffixTrie::StringView> entries;
    entries = {"Some", "CaSE", "SensitiVe", "sensitive"};
    auto trie = SuffixTrie::BulkLoad(entries, [&](size_t i, auto& name) {
        return SuffixTrie::Entry{name, i, proto::NameTag::NONE};
    });
    test_prefix(*trie, "Som", {"Some"});
    test_prefix(*trie, "som", {"Some"});
    test_prefix(*trie, "cas", {"CaSE"});
    test_prefix(*trie, "sens", {"SensitiVe", "sensitive"});
}

}  // namespace
