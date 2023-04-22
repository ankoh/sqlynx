#include "flatsql/text/rope.h"

#include <random>

#include "gtest/gtest.h"

using namespace flatsql;

namespace {

static std::span<const std::byte> asBytes(std::string_view str) {
    return {reinterpret_cast<const std::byte*>(str.data()), str.size()};
}

struct TestableRope : public rope::Rope {
    explicit TestableRope(rope::Rope&& rope) : rope::Rope(std::move(rope)) {}
    explicit TestableRope(size_t page_size, rope::NodePtr root_node, rope::TextStats root_info,
                          rope::LeafNode* first_leaf, size_t tree_height)
        : rope::Rope(page_size, root_node, root_info, first_leaf, tree_height) {}
    explicit TestableRope(size_t page_size) : rope::Rope(page_size) {}

    static TestableRope FromString(size_t page_size, std::string_view text,
                                   size_t leaf_capacity = std::numeric_limits<size_t>::max(),
                                   size_t inner_capacity = std::numeric_limits<size_t>::max()) {
        return TestableRope{rope::Rope::FromString(page_size, text, leaf_capacity, inner_capacity)};
    }

    using rope::Rope::Append;
    using rope::Rope::InsertBounded;
    using rope::Rope::SplitOff;
};

struct RopeTest : public ::testing::Test {};

TEST_F(RopeTest, LeafByteOps) {
    rope::NodePage page{128};
    auto& node = *new (page.Get()) rope::LeafNode(128);
    EXPECT_TRUE(node.IsEmpty());

    node.PushBytes(asBytes(""));
    node.PushBytes(asBytes("test"));
    EXPECT_EQ(node.GetStringView(), "test");
    node.PushBytes(asBytes("foo"));
    EXPECT_EQ(node.GetStringView(), "testfoo");

    node.PushBytes(asBytes("1"));
    node.PushBytes(asBytes("2"));
    node.PushBytes(asBytes("3"));
    EXPECT_EQ(node.GetStringView(), "testfoo123");
    node.RemoveByteRange(4, 3);
    EXPECT_EQ(node.GetStringView(), "test123");
    node.TruncateBytes(4);

    EXPECT_EQ(node.GetStringView(), "test");
    node.PushBytes(asBytes("nananana"));
    EXPECT_EQ(node.GetStringView(), "testnananana");

    rope::NodePage right_page{128};
    auto& right = *new (right_page.Get()) rope::LeafNode(128);
    node.SplitBytesOff(4, right);
    EXPECT_EQ(node.GetStringView(), "test");
    EXPECT_EQ(right.GetStringView(), "nananana");
}

TEST_F(RopeTest, LeafPushBytesAndSplit) {
    rope::NodePage left_page{128};
    rope::NodePage right_page{128};
    auto& left = *new (left_page.Get()) rope::LeafNode(128);
    auto& right = *new (right_page.Get()) rope::LeafNode(128);
    left.PushBytes(asBytes("0123456789"));
    left.PushBytesAndSplit(asBytes("abc"), right);
    EXPECT_EQ(left.GetStringView(), "012345");
    EXPECT_EQ(right.GetStringView(), "6789abc");
}

TEST_F(RopeTest, LeafBalanceBytesWith) {
    rope::NodePage left_page{128};
    rope::NodePage right_page{128};
    auto& left = *new (left_page.Get()) rope::LeafNode(128);
    auto& right = *new (right_page.Get()) rope::LeafNode(128);
    left.PushBytes(asBytes("01"));
    right.PushBytes(asBytes("23456789"));
    rope::TextStats left_stats{left.GetData()};
    rope::TextStats right_stats{right.GetData()};
    left.BalanceCharsRight(left_stats, right, right_stats, true);
    EXPECT_EQ(left.GetStringView(), "01234");
    EXPECT_EQ(right.GetStringView(), "56789");

    left.TruncateBytes(0);
    right.TruncateBytes(0);
    left.PushBytes(asBytes("abcdefgh"));
    right.PushBytes(asBytes("ij"));
    left_stats = {left.GetData()};
    right_stats = {right.GetData()};
    left.BalanceCharsRight(left_stats, right, right_stats, true);
    EXPECT_EQ(left.GetStringView(), "abcde");
    EXPECT_EQ(right.GetStringView(), "fghij");
}

TEST_F(RopeTest, InsertBoundedEnd) {
    TestableRope rope{128};
    std::string expected;
    size_t pos = 0;
    for (size_t i = 0; i < 1000; ++i) {
        auto s = std::to_string(i) + ",";
        expected += s;
        rope.InsertBounded(pos, asBytes(s));
        pos += s.size();
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetStats().text_bytes, expected.size());
        ASSERT_EQ(rope.GetStats().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetStats().line_breaks, 0);
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, InsertBounded0) {
    TestableRope rope{128};
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        auto s = std::to_string(i) + ",";
        expected = s + expected;
        rope.InsertBounded(0, asBytes(s));
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetStats().text_bytes, expected.size());
        ASSERT_EQ(rope.GetStats().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetStats().line_breaks, 0);
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, InsertBounded1IDiv2) {
    TestableRope rope{128};
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        auto s = std::to_string(i);
        auto mid = i / 2;
        auto prefix = expected.substr(0, mid);
        auto suffix = expected.substr(mid);
        expected = prefix + s + suffix;
        rope.InsertBounded(mid, asBytes(s));
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetStats().text_bytes, expected.size());
        ASSERT_EQ(rope.GetStats().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetStats().line_breaks, 0);
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, InsertBounded1IDiv3) {
    TestableRope rope{128};
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        auto s = std::to_string(i);
        auto mid = i / 3;
        auto prefix = expected.substr(0, mid);
        auto suffix = expected.substr(mid);
        expected = prefix + s + suffix;
        rope.InsertBounded(mid, asBytes(s));
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetStats().text_bytes, expected.size());
        ASSERT_EQ(rope.GetStats().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetStats().line_breaks, 0);
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, InsertBounded2IDiv3) {
    TestableRope rope{128};
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        auto s = std::to_string(i);
        auto mid = 2 * i / 3;
        auto prefix = expected.substr(0, mid);
        auto suffix = expected.substr(mid);
        expected = prefix + s + suffix;
        rope.InsertBounded(mid, asBytes(s));
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetStats().text_bytes, expected.size());
        ASSERT_EQ(rope.GetStats().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetStats().line_breaks, 0);
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, FromText) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto rope = TestableRope::FromString(128, expected);
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetStats().utf8_codepoints, expected.size());
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOff0) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = 0;
        auto left = TestableRope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), expected.substr(0, split));
        ASSERT_EQ(right.ToString(), expected.substr(split));
        ASSERT_EQ(left.GetStats().utf8_codepoints, split);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOff1) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = 1;
        auto left = TestableRope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetStats().utf8_codepoints, split);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffNDiv2) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size() / 2;
        auto left = TestableRope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetStats().utf8_codepoints, split);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffEverySecond) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
    }
    for (size_t i = 0; i < expected.size(); i += 2) {
        auto left = TestableRope::FromString(128, expected);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetStats().utf8_codepoints, i);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - i);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffEverySecondHalfFull) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
    }
    for (size_t i = 0; i < expected.size(); i += 2) {
        auto left = TestableRope::FromString(128, expected, 50, 2);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetStats().utf8_codepoints, i);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - i);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffEveryThird) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
    }
    for (size_t i = 0; i < expected.size(); i += 3) {
        auto left = TestableRope::FromString(128, expected);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetStats().utf8_codepoints, i);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - i);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffEveryThirdHalfFull) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
    }
    for (size_t i = 0; i < expected.size(); i += 3) {
        auto left = TestableRope::FromString(256, expected, 120, 3);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetStats().utf8_codepoints, i);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - i);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, NodeCapacities) {
    EXPECT_EQ(rope::LeafNode::Capacity(128), 104);
    EXPECT_EQ(rope::LeafNode::Capacity(256), 232);
    EXPECT_EQ(rope::InnerNode::Capacity(128), 3);
    EXPECT_EQ(rope::InnerNode::Capacity(256), 7);
}

TEST_F(RopeTest, SplitOffNDiv2HalfFill) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size() / 2;
        auto left = TestableRope::FromString(128, expected, 50, 2);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetStats().utf8_codepoints, split);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffNMinus1) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size() - 1;
        auto left = TestableRope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetStats().utf8_codepoints, split);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffN) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size();
        auto left = TestableRope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetStats().utf8_codepoints, split);
        ASSERT_EQ(right.GetStats().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, AppendLeaf) {
    TestableRope left{128};
    std::string expected;
    for (size_t i = 0; i < 100; ++i) {
        auto text = std::to_string(i);
        expected += text;
        auto right = TestableRope::FromString(128, text);
        ASSERT_EQ(right.ToString(), text);
        left.Append(std::move(right));
        ASSERT_EQ(left.ToString(), expected);
        ASSERT_EQ(left.GetStats().utf8_codepoints, expected.size());
        left.CheckIntegrity();
    }
}

TEST_F(RopeTest, AppendNDiv2) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, (expected.size() + 1) / 2);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = TestableRope::FromString(128, left_text);
        auto right_rope = TestableRope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
        ASSERT_EQ(left_rope.GetStats().utf8_codepoints, expected.size());
        left_rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, AppendNDiv3) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, expected.size() / 3);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = TestableRope::FromString(128, left_text);
        auto right_rope = TestableRope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
        ASSERT_EQ(left_rope.GetStats().utf8_codepoints, expected.size());
        left_rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, Append2NDiv3) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, 2 * expected.size() / 3);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = TestableRope::FromString(128, left_text);
        auto right_rope = TestableRope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
        ASSERT_EQ(left_rope.GetStats().utf8_codepoints, expected.size());
        left_rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNothing) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(0, 0);
        buffer.Remove(text.size() * 3 / 4, 0);
        buffer.Remove(text.size() * 2 / 3, 0);
        buffer.Remove(text.size() / 2, 0);
        buffer.Remove(text.size() / 3, 0);
        buffer.Remove(text.size() / 4, 0);
        buffer.Remove(text.size() / 5, 0);
        buffer.Remove(text.size() - 1, 0);
        ASSERT_EQ(buffer.ToString(), text);
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, text.size());
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveFirst) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(0, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(1));
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, text.size() - 1);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveLast) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(text.size() - 1, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(0, text.size() - 1));
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, text.size() - 1);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveAll) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(0, text.size());
        ASSERT_EQ(buffer.ToString(), "");
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, 0);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNDiv2) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto mid = (text.size() + 1) / 2;
        auto prefix = std::string_view{text}.substr(0, mid);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(mid, text.size() - mid);
        ASSERT_EQ(buffer.ToString(), prefix);
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, prefix.size());
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNDiv3Mid) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto n = text.size() / 3;
        auto prefix = std::string_view{text}.substr(0, n);
        auto inner = std::min(text.size() - prefix.size(), n);
        auto suffix = std::string_view{text}.substr(prefix.size() + inner);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(prefix.size(), inner);
        std::string combined{prefix};
        combined += suffix;
        ASSERT_EQ(buffer.ToString(), combined);
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, combined.size());
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNDiv4Mid) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto n = text.size() / 4;
        auto prefix = std::string_view{text}.substr(0, n);
        auto inner = std::min(text.size() - prefix.size(), n);
        auto suffix = std::string_view{text}.substr(prefix.size() + inner);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(prefix.size(), inner);
        std::string combined{prefix};
        combined += suffix;
        ASSERT_EQ(buffer.ToString(), combined);
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, combined.size());
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNMinus1Front) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(0, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(1));
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, text.size() - 1);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNMinus1Back) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = TestableRope::FromString(128, text);
        buffer.Remove(text.size() - 1, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(0, text.size() - 1));
        ASSERT_EQ(buffer.GetStats().utf8_codepoints, text.size() - 1);
        buffer.CheckIntegrity();
    }
}

struct RopeInteractionGenerator {
    /// A type of an interaction
    enum class InteractionType : uint8_t { Insert, Remove };
    /// A single user interaction
    struct Interaction {
        /// The input operation tyep
        InteractionType type;
        /// The begin of the operation
        size_t begin;
        /// The operation size
        size_t count;

        /// Apply the input operation to a string buffer
        void Apply(std::string& buffer, std::string_view data) {
            switch (type) {
                case InteractionType::Insert:
                    assert(begin <= buffer.size());
                    assert(count <= data.size());
                    buffer.insert(begin, data.substr(0, count));
                    break;
                case InteractionType::Remove:
                    assert(begin <= buffer.size());
                    assert((begin + count) <= buffer.size());
                    buffer.erase(begin, count);
                    break;
            }
        }
        /// Aply the input operation to a rope
        void Apply(rope::Rope& buffer, std::string_view data) {
            switch (type) {
                case InteractionType::Insert:
                    buffer.Insert(begin, data.substr(0, count));
                    break;
                case InteractionType::Remove:
                    buffer.Remove(begin, count);
                    break;
            }
        }

        /// Print the interaction as string
        std::string ToString() {
            std::string_view type_name = type == InteractionType::Insert ? "insert" : "remove";
            return std::string{type_name} + "(" + std::to_string(begin) + "," + std::to_string(count) + ")";
        }
    };

   protected:
    /// The seeded data generator
    std::mt19937 generator;
    /// The current data source
    std::string data_source = "";
    /// The current buffer size
    size_t current_buffer_size = 0;

    /// Generate a random number
    size_t rnd() { return static_cast<size_t>(generator()); }
    /// Constructor
    RopeInteractionGenerator(size_t seed, size_t max_bytes) : generator(seed) {
        data_source.reserve(max_bytes);
        for (size_t i = 0; i < max_bytes; ++i) {
            data_source.push_back(48 + (rnd() % (57 - 48)));
        }
    }
    /// Release the data source
    std::string ReleaseDataSource() { return std::move(data_source); }
    /// Generate the next edit
    Interaction GenerateOne() {
        size_t begin = (current_buffer_size == 0) ? 0 : (rnd() % current_buffer_size);
        assert(begin <= current_buffer_size);
        if ((rnd() & 0b1) == 0) {
            size_t count = rnd() % data_source.size();
            current_buffer_size += count;
            return {.type = InteractionType::Insert, .begin = begin, .count = count};
        } else {
            size_t end = begin + ((begin == current_buffer_size) ? 0 : (rnd() % (current_buffer_size - begin)));
            assert((end - begin) <= current_buffer_size);
            current_buffer_size -= end - begin;
            return {
                .type = InteractionType::Remove,
                .begin = begin,
                .count = end - begin,
            };
        }
    }

   public:
    /// Generate multiple input operations
    static std::pair<std::vector<Interaction>, std::string> GenerateMany(size_t seed, size_t n, size_t max_bytes) {
        RopeInteractionGenerator gen{seed, max_bytes};
        std::vector<Interaction> out;
        for (size_t i = 0; i < n; ++i) {
            out.push_back(gen.GenerateOne());
        }
        return {out, gen.ReleaseDataSource()};
    }
};

struct RopeFuzzerTest {
    size_t page_size;
    size_t max_bytes;
    size_t interaction_count;
    size_t seed;
};

struct RopeFuzzerTestPrinter {
    std::string operator()(const ::testing::TestParamInfo<RopeFuzzerTest>& info) const {
        auto& test = info.param;
        return std::to_string(test.page_size) + "_" + std::to_string(test.interaction_count) + "_" +
               std::to_string(test.max_bytes) + "_" + std::to_string(test.seed);
    }
};

std::vector<RopeFuzzerTest> generateTestSeries(size_t page_size, size_t interaction_count, size_t max_bytes,
                                               size_t test_count) {
    std::vector<RopeFuzzerTest> tests;
    tests.reserve(test_count);
    for (size_t i = 0; i < test_count; ++i) {
        tests.push_back(RopeFuzzerTest{
            .page_size = page_size, .max_bytes = max_bytes, .interaction_count = interaction_count, .seed = i});
    }
    return tests;
}

struct RopeFuzzerTestSuite : public ::testing::TestWithParam<RopeFuzzerTest> {};
TEST_P(RopeFuzzerTestSuite, Test) {
    auto& test = GetParam();
    rope::Rope target{test.page_size};
    std::string expected;
    auto [input_ops, data_buffer] =
        RopeInteractionGenerator::GenerateMany(test.seed, test.interaction_count, test.max_bytes);
    for (size_t i = 0; i < input_ops.size(); ++i) {
        auto& op = input_ops[i];
        op.Apply(expected, data_buffer);
        op.Apply(target, data_buffer);
        ASSERT_NO_THROW(target.CheckIntegrity()) << "[" << i << "] " << op.ToString();
        ASSERT_EQ(target.ToString(), expected) << "[" << i << "] " << op.ToString() << " " << data_buffer;
    }
}

INSTANTIATE_TEST_SUITE_P(RopeFuzzerTest128S, RopeFuzzerTestSuite,
                         ::testing::ValuesIn(generateTestSeries(128, 1024, 16, 100)), RopeFuzzerTestPrinter());
INSTANTIATE_TEST_SUITE_P(RopeFuzzerTest128L, RopeFuzzerTestSuite,
                         ::testing::ValuesIn(generateTestSeries(128, 128, 256, 100)), RopeFuzzerTestPrinter());

INSTANTIATE_TEST_SUITE_P(RopeFuzzerTest1024S, RopeFuzzerTestSuite,
                         ::testing::ValuesIn(generateTestSeries(1024, 1024, 16, 100)), RopeFuzzerTestPrinter());
INSTANTIATE_TEST_SUITE_P(RopeFuzzerTest1024L, RopeFuzzerTestSuite,
                         ::testing::ValuesIn(generateTestSeries(1024, 128, 2048, 100)), RopeFuzzerTestPrinter());

}  // namespace
