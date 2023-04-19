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
    explicit TestableRope(size_t page_size, rope::NodePtr root_node, rope::TextInfo root_info,
                          rope::LeafNode* first_leaf, size_t tree_height)
        : rope::Rope(page_size, root_node, root_info, first_leaf, tree_height) {}
    explicit TestableRope(size_t page_size) : rope::Rope(page_size) {}

    using rope::Rope::InsertBounded;
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
    rope::TextInfo left_stats{left.GetData()};
    rope::TextInfo right_stats{right.GetData()};
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
        ASSERT_EQ(rope.GetInfo().text_bytes, expected.size());
        ASSERT_EQ(rope.GetInfo().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetInfo().line_breaks, 0);
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
        ASSERT_EQ(rope.GetInfo().text_bytes, expected.size());
        ASSERT_EQ(rope.GetInfo().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetInfo().line_breaks, 0);
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
        ASSERT_EQ(rope.GetInfo().text_bytes, expected.size());
        ASSERT_EQ(rope.GetInfo().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetInfo().line_breaks, 0);
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
        ASSERT_EQ(rope.GetInfo().text_bytes, expected.size());
        ASSERT_EQ(rope.GetInfo().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetInfo().line_breaks, 0);
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
        ASSERT_EQ(rope.GetInfo().text_bytes, expected.size());
        ASSERT_EQ(rope.GetInfo().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetInfo().line_breaks, 0);
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, FromText) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto rope = rope::Rope::FromString(128, expected);
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetInfo().utf8_codepoints, expected.size());
        rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOff0) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = 0;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), expected.substr(0, split));
        ASSERT_EQ(right.ToString(), expected.substr(split));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, split);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOff1) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = 1;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, split);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffNDiv2) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size() / 2;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, split);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - split);
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
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, i);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - i);
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
        auto left = rope::Rope::FromString(128, expected, 50, 2);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, i);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - i);
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
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, i);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - i);
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
        auto left = rope::Rope::FromString(256, expected, 120, 3);
        auto right = left.SplitOff(i);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, i));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(i));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, i);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - i);
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
        auto left = rope::Rope::FromString(128, expected, 50, 2);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, split);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffNMinus1) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size() - 1;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, split);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, SplitOffN) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size();
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
        ASSERT_EQ(left.GetInfo().utf8_codepoints, split);
        ASSERT_EQ(right.GetInfo().utf8_codepoints, expected.size() - split);
        left.CheckIntegrity();
        right.CheckIntegrity();
    }
}

TEST_F(RopeTest, AppendLeaf) {
    rope::Rope left{128};
    std::string expected;
    for (size_t i = 0; i < 100; ++i) {
        auto text = std::to_string(i);
        expected += text;
        auto right = rope::Rope::FromString(128, text);
        ASSERT_EQ(right.ToString(), text);
        left.Append(std::move(right));
        ASSERT_EQ(left.ToString(), expected);
        ASSERT_EQ(left.GetInfo().utf8_codepoints, expected.size());
        left.CheckIntegrity();
    }
}

TEST_F(RopeTest, AppendNDiv2) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, (expected.size() + 1) / 2);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = rope::Rope::FromString(128, left_text);
        auto right_rope = rope::Rope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
        ASSERT_EQ(left_rope.GetInfo().utf8_codepoints, expected.size());
        left_rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, AppendNDiv3) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, expected.size() / 3);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = rope::Rope::FromString(128, left_text);
        auto right_rope = rope::Rope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
        ASSERT_EQ(left_rope.GetInfo().utf8_codepoints, expected.size());
        left_rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, Append2NDiv3) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, 2 * expected.size() / 3);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = rope::Rope::FromString(128, left_text);
        auto right_rope = rope::Rope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
        ASSERT_EQ(left_rope.GetInfo().utf8_codepoints, expected.size());
        left_rope.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNothing) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(0, 0);
        buffer.Remove(text.size() * 3 / 4, 0);
        buffer.Remove(text.size() * 2 / 3, 0);
        buffer.Remove(text.size() / 2, 0);
        buffer.Remove(text.size() / 3, 0);
        buffer.Remove(text.size() / 4, 0);
        buffer.Remove(text.size() / 5, 0);
        buffer.Remove(text.size() - 1, 0);
        ASSERT_EQ(buffer.ToString(), text);
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, text.size());
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveFirst) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(0, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(1));
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, text.size() - 1);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveLast) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(text.size() - 1, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(0, text.size() - 1));
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, text.size() - 1);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveAll) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(0, text.size());
        ASSERT_EQ(buffer.ToString(), "");
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, 0);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNDiv2) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto mid = (text.size() + 1) / 2;
        auto prefix = std::string_view{text}.substr(0, mid);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(mid, text.size() - mid);
        ASSERT_EQ(buffer.ToString(), prefix);
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, prefix.size());
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
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(prefix.size(), inner);
        std::string combined{prefix};
        combined += suffix;
        ASSERT_EQ(buffer.ToString(), combined);
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, combined.size());
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
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(prefix.size(), inner);
        std::string combined{prefix};
        combined += suffix;
        ASSERT_EQ(buffer.ToString(), combined);
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, combined.size());
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNMinus1Front) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(0, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(1));
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, text.size() - 1);
        buffer.CheckIntegrity();
    }
}

TEST_F(RopeTest, RemoveNMinus1Back) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.Remove(text.size() - 1, 1);
        ASSERT_EQ(buffer.ToString(), text.substr(0, text.size() - 1));
        ASSERT_EQ(buffer.GetInfo().utf8_codepoints, text.size() - 1);
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
        /// The argument data
        std::string_view data;

        /// Apply the input operation to a string buffer
        void Apply(std::string& buffer) {
            switch (type) {
                case InteractionType::Insert:
                    assert(begin <= buffer.size());
                    buffer.insert(begin, data);
                    break;
                case InteractionType::Remove:
                    assert(begin <= buffer.size());
                    assert((begin + count) <= buffer.size());
                    buffer.erase(begin, count);
                    break;
            }
        }
        /// Aply the input operation to a rope
        void Apply(rope::Rope& buffer) {
            switch (type) {
                case InteractionType::Insert:
                    buffer.Insert(begin, data);
                    break;
                case InteractionType::Remove:
                    buffer.Remove(begin, count);
                    break;
            }
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
            return {.type = InteractionType::Insert,
                    .begin = begin,
                    .count = count,
                    .data = std::string_view{data_source}.substr(0, count)};
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
    static std::pair<std::string, std::vector<Interaction>> GenerateMany(size_t seed, size_t n, size_t max_bytes) {
        RopeInteractionGenerator gen{seed, max_bytes};
        std::vector<Interaction> out;
        for (size_t i = 0; i < n; ++i) {
            out.push_back(gen.GenerateOne());
        }
        return {gen.ReleaseDataSource(), out};
    }
};

struct RopeFuzzerTestSuite : public ::testing::TestWithParam<size_t> {};

struct SeedArgPrinter {
    std::string operator()(const ::testing::TestParamInfo<size_t>& info) const { return std::to_string(info.param); }
};

TEST_P(RopeFuzzerTestSuite, Test) {
    rope::Rope target{128};
    std::string expected;
    auto [data_buffer, input_ops] = RopeInteractionGenerator::GenerateMany(GetParam(), 128, 256);
    for (auto& op : input_ops) {
        op.Apply(expected);
        op.Apply(target);
        target.CheckIntegrity();
        ASSERT_EQ(target.ToString(), expected);
    }
}

static const std::array<size_t, 3> fixed_fuzzer_tests = {0, 1, 10};

INSTANTIATE_TEST_SUITE_P(RopeFuzzerTest, RopeFuzzerTestSuite, ::testing::ValuesIn(fixed_fuzzer_tests),
                         SeedArgPrinter());

}  // namespace
