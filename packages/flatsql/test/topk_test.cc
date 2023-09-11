#include "flatsql/utils/topk.h"

#include <initializer_list>

#include "gtest/gtest.h"

namespace {

using ValueType = size_t;
using ScoreType = uint32_t;
using Entry = flatsql::TopKHeap<ValueType, ScoreType>::Entry;

struct TopKTest {
    /// The name
    std::string_view name;
    /// The entries
    std::vector<Entry> entries;
    /// The k
    size_t k;
    /// The output
    std::vector<size_t> expected;

    /// Constructor
    TopKTest(std::string_view name, size_t k, std::initializer_list<Entry> entries,
             std::initializer_list<size_t> expected)
        : name(name), entries(entries), k(k), expected(expected) {}
};
void operator<<(std::ostream& out, const TopKTest& p) { out << p.name; }

struct TopKTestPrinter {
    std::string operator()(const ::testing::TestParamInfo<TopKTest>& info) const {
        return std::string{info.param.name};
    }
};
struct TopKTestSuite : public ::testing::TestWithParam<TopKTest> {};

TEST_P(TopKTestSuite, Test) {
    auto& param = GetParam();
    flatsql::TopKHeap<ValueType, ScoreType> heap{param.k};

    // Insert heap values
    for (auto& entry : param.entries) {
        heap.Insert(entry.value, entry.score);
    }

    // Collect values
    auto entries = heap.GetEntries();
    std::sort(entries.begin(), entries.end(), [](auto& l, auto& r) { return l.score < r.score; });
    std::vector<ValueType> values;
    values.reserve(entries.size());
    for (auto& entry : entries) {
        values.push_back(entry.value);
    }

    // Test values
    ASSERT_EQ(values, param.expected);
}

static auto TESTS = ::testing::ValuesIn({
    TopKTest("empty", 10, {}, {}),
    TopKTest("swap2", 10,
             {
                 Entry(0, 20),
                 Entry(1, 10),
             },
             {1, 0}),
});

INSTANTIATE_TEST_SUITE_P(Simple, TopKTestSuite, TESTS, TopKTestPrinter());

}  // namespace
