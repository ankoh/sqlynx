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

std::vector<size_t> getTopK(std::vector<Entry> entries) {
    std::sort(entries.begin(), entries.end(), [](auto& l, auto& r) { return l.score > r.score; });
    std::vector<ValueType> values;
    values.reserve(entries.size());
    for (auto& entry : entries) {
        values.push_back(entry.value);
    }
    return values;
}

TEST_P(TopKTestSuite, Test) {
    auto& param = GetParam();
    flatsql::TopKHeap<ValueType, ScoreType> heap{param.k};

    // Insert heap values
    for (auto& entry : param.entries) {
        heap.Insert(entry.value, entry.score);
    }
    auto values = getTopK(heap.GetEntries());

    // Test values
    ASSERT_EQ(values, param.expected);
}

static auto TESTS = ::testing::ValuesIn({
    TopKTest("empty", 4, {}, {}),
    TopKTest("ordered_1", 4, {Entry(0, 10)}, {0}),
    TopKTest("ordered_2", 4,
             {
                 Entry(0, 10),
                 Entry(1, 20),
             },
             {1, 0}),
    TopKTest("swap_2", 4,
             {
                 Entry(0, 20),
                 Entry(1, 10),
             },
             {0, 1}),
    TopKTest("capacity_reached", 4,
             {
                 Entry(0, 50),
                 Entry(1, 40),
                 Entry(2, 30),
                 Entry(3, 20),
             },
             {0, 1, 2, 3}),
    TopKTest("capacity_exceeded_1", 4,
             {
                 Entry(0, 50),
                 Entry(1, 40),
                 Entry(2, 30),
                 Entry(3, 20),
                 Entry(4, 10),
             },
             {0, 1, 2, 3}),
});

INSTANTIATE_TEST_SUITE_P(TopKBasics, TopKTestSuite, TESTS, TopKTestPrinter());

TEST(TopKTests, AscendingSequence) {
    flatsql::TopKHeap<size_t, uint32_t> heap{10};
    for (size_t i = 0; i < 1000; ++i) {
        heap.Insert(i, i * 10);
    }

    auto values = getTopK(heap.GetEntries());
    ASSERT_EQ(values.size(), 10);

    std::vector<size_t> expected{999, 998, 997, 996, 995, 994, 993, 992, 991, 990};
    ASSERT_EQ(values, expected);
}

TEST(TopKTests, DescendingSequence) {
    flatsql::TopKHeap<size_t, uint32_t> heap{10};
    for (size_t i = 0; i < 1000; ++i) {
        heap.Insert(i, 1000 * 10 - i * 10);
    }

    auto values = getTopK(heap.GetEntries());
    ASSERT_EQ(values.size(), 10);

    std::vector<size_t> expected{0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
    ASSERT_EQ(values, expected);
}

}  // namespace
