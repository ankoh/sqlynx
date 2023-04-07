#include "flatsql/text/rope.h"
#include "gtest/gtest.h"

using namespace flatsql;

static std::span<const std::byte> asBytes(std::string_view str) {
    return {reinterpret_cast<const std::byte*>(str.data()), str.size()};
}

TEST(RopeLeafNode, ByteOps) {
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

TEST(RopeLeafNode, PushBytesAndSplit) {
    rope::NodePage left_page{128};
    rope::NodePage right_page{128};
    auto& left = *new (left_page.Get()) rope::LeafNode(128);
    auto& right = *new (right_page.Get()) rope::LeafNode(128);
    left.PushBytes(asBytes("0123456789"));
    left.PushBytesAndSplit(asBytes("abc"), right);
    EXPECT_EQ(left.GetStringView(), "012345");
    EXPECT_EQ(right.GetStringView(), "6789abc");
}

TEST(RopeLeafNode, BalanceBytesWith) {
    rope::NodePage left_page{128};
    rope::NodePage right_page{128};
    auto& left = *new (left_page.Get()) rope::LeafNode(128);
    auto& right = *new (right_page.Get()) rope::LeafNode(128);
    left.PushBytes(asBytes("01"));
    right.PushBytes(asBytes("23456789"));
    left.BalanceBytes(right);
    EXPECT_EQ(left.GetStringView(), "01234");
    EXPECT_EQ(right.GetStringView(), "56789");

    left.TruncateBytes(0);
    right.TruncateBytes(0);
    left.PushBytes(asBytes("abcdefgh"));
    right.PushBytes(asBytes("ij"));
    left.BalanceBytes(right);
    EXPECT_EQ(left.GetStringView(), "abcde");
    EXPECT_EQ(right.GetStringView(), "fghij");
}

TEST(Rope, InsertBoundedEnd) {
    rope::Rope rope{128};
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
    }
}

TEST(Rope, InsertBounded0) {
    rope::Rope rope{128};
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        auto s = std::to_string(i) + ",";
        expected = s + expected;
        rope.InsertBounded(0, asBytes(s));
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetInfo().text_bytes, expected.size());
        ASSERT_EQ(rope.GetInfo().utf8_codepoints, expected.size());
        ASSERT_EQ(rope.GetInfo().line_breaks, 0);
    }
}

TEST(Rope, InsertBounded1IDiv2) {
    rope::Rope rope{128};
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
    }
}

TEST(Rope, InsertBounded1IDiv3) {
    rope::Rope rope{128};
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
    }
}

TEST(Rope, InsertBounded2IDiv3) {
    rope::Rope rope{128};
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
    }
}

TEST(Rope, FromText) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto rope = rope::Rope::FromString(128, expected);
        ASSERT_EQ(rope.ToString(), expected);
    }
    auto rope = rope::Rope::FromString(128, expected);
    for (size_t i = 0; i < 1000; ++i) {
        auto v = std::to_string(i);
        expected.insert(i, std::to_string(i));
        rope.InsertBounded(i, asBytes(v));
        ASSERT_EQ(rope.ToString(), expected);
    }
}

TEST(Rope, SplitOff0) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = 0;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), expected.substr(0, split));
        ASSERT_EQ(right.ToString(), expected.substr(split));
    }
}

TEST(Rope, SplitOff1) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = 1;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
    }
}

TEST(Rope, SplitOffNDiv2) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size() / 2;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
    }
}

TEST(Rope, SplitOffNMinus1) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size() - 1;
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
    }
}

TEST(Rope, SplitOffN) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto split = expected.size();
        auto left = rope::Rope::FromString(128, expected);
        auto right = left.SplitOff(split);
        ASSERT_EQ(left.ToString(), std::string_view{expected}.substr(0, split));
        ASSERT_EQ(right.ToString(), std::string_view{expected}.substr(split));
    }
}

TEST(Rope, AppendLeaf) {
    rope::Rope left{128};
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        auto text = std::to_string(i);
        expected += text;
        auto right = rope::Rope::FromString(128, text);
        ASSERT_EQ(right.ToString(), text);
        left.Append(std::move(right));
        ASSERT_EQ(left.ToString(), expected);
    }
}

TEST(Rope, AppendNDiv2) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, (expected.size() + 1) / 2);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = rope::Rope::FromString(128, left_text);
        auto right_rope = rope::Rope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
    }
}

TEST(Rope, AppendNDiv3) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, expected.size() / 3);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = rope::Rope::FromString(128, left_text);
        auto right_rope = rope::Rope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
    }
}

TEST(Rope, Append2NDiv3) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto left_text = std::string_view{expected}.substr(0, 2 * expected.size() / 3);
        auto right_text = std::string_view{expected}.substr(left_text.size());
        auto left_rope = rope::Rope::FromString(128, left_text);
        auto right_rope = rope::Rope::FromString(128, right_text);
        left_rope.Append(std::move(right_rope));
        ASSERT_EQ(left_rope.ToString(), expected);
    }
}

TEST(Rope, RemoveRangeNDiv2) {
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        auto mid = (text.size() + 1) / 2;
        auto prefix = std::string_view{text}.substr(0, mid);
        auto buffer = rope::Rope::FromString(128, text);
        buffer.RemoveRange(mid, text.size() - mid);
        ASSERT_EQ(buffer.ToString(), prefix);
    }
}
