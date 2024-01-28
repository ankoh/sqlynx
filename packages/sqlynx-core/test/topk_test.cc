#include "sqlynx/utils/topk.h"

#include <initializer_list>

#include "gtest/gtest.h"

namespace {

using ValueType = size_t;
using ScoreType = size_t;

struct Entry {
    /// The value
    ValueType value;
    /// The score
    ScoreType score;
    /// Constructor
    Entry(ValueType value, ScoreType score) : value(value), score(score) {}
    /// Operator
    bool operator<(const Entry& entry) const { return score < entry.score; }
};

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

std::vector<size_t> getTopK(const std::vector<Entry>& entries) {
    std::vector<ValueType> values;
    values.reserve(entries.size());
    for (auto& entry : entries) {
        values.push_back(entry.value);
    }
    return values;
}

TEST_P(TopKTestSuite, Test) {
    auto& param = GetParam();
    sqlynx::TopKHeap<Entry> heap{param.k};

    // Insert heap values
    for (auto& entry : param.entries) {
        heap.Insert(entry);
    }
    auto values = getTopK(heap.Finish());

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
             {0, 1}),
    TopKTest("swap_2", 4,
             {
                 Entry(0, 20),
                 Entry(1, 10),
             },
             {1, 0}),
    TopKTest("capacity_reached", 4,
             {
                 Entry(0, 50),
                 Entry(1, 40),
                 Entry(2, 30),
                 Entry(3, 20),
             },
             {3, 2, 1, 0}),
    TopKTest("capacity_exceeded_1", 4,
             {
                 Entry(0, 50),
                 Entry(1, 40),
                 Entry(2, 30),
                 Entry(3, 20),
                 Entry(4, 10),
             },
             {3, 2, 1, 0}),
});

INSTANTIATE_TEST_SUITE_P(TopKBasics, TopKTestSuite, TESTS, TopKTestPrinter());

TEST(TopKTests, AscendingSequence) {
    sqlynx::TopKHeap<Entry> heap{10};
    for (size_t i = 0; i < 1000; ++i) {
        heap.Insert(Entry{i, i * 10});
    }

    auto values = getTopK(heap.Finish());
    ASSERT_EQ(values.size(), 10);

    std::vector<size_t> expected{990, 991, 992, 993, 994, 995, 996, 997, 998, 999};
    ASSERT_EQ(values, expected);
}

TEST(TopKTests, DescendingSequence) {
    sqlynx::TopKHeap<Entry> heap{10};
    for (size_t i = 0; i < 1000; ++i) {
        heap.Insert(Entry{i, 1000 * 10 - i * 10});
    }

    auto values = getTopK(heap.Finish());
    ASSERT_EQ(values.size(), 10);

    std::vector<size_t> expected{9, 8, 7, 6, 5, 4, 3, 2, 1, 0};
    ASSERT_EQ(values, expected);
}

}  // namespace
