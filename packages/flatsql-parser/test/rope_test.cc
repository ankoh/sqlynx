#include "flatsql/text/rope.h"
#include "gtest/gtest.h"

using namespace flatsql;

static std::span<const std::byte> asBytes(std::string_view str) {
    return {reinterpret_cast<const std::byte*>(str.data()), str.size()};
}

TEST(RopeLeafNode, ByteOps) {
    rope::LeafNode<128> node;
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
    node.RemoveByteRange(4, 7);
    EXPECT_EQ(node.GetStringView(), "test123");
    node.TruncateBytes(4);

    EXPECT_EQ(node.GetStringView(), "test");
    node.PushBytes(asBytes("nananana"));
    EXPECT_EQ(node.GetStringView(), "testnananana");
    rope::LeafNode<128> right;
    node.SplitBytesOff(4, right);
    EXPECT_EQ(node.GetStringView(), "test");
    EXPECT_EQ(right.GetStringView(), "nananana");
}

TEST(RopeLeafNode, PushBytesAndSplit) {
    rope::LeafNode<128> node;
    node.PushBytes(asBytes("0123456789"));
    rope::LeafNode<128> right;
    node.PushBytesAndSplit(asBytes("abc"), right);
    EXPECT_EQ(node.GetStringView(), "012345");
    EXPECT_EQ(right.GetStringView(), "6789abc");
}

TEST(RopeLeafNode, BalanceBytesWith) {
    rope::LeafNode<128> left;
    rope::LeafNode<128> right;
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
    rope::Rope<128> rope;
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
    rope::Rope<128> rope;
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
    rope::Rope<128> rope;
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
    rope::Rope<128> rope;
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
    rope::Rope<128> rope;
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
        auto rope = rope::Rope<128>::FromString(expected);
        ASSERT_EQ(rope.ToString(), expected);
    }
    auto rope = rope::Rope<128>::FromString(expected);
    for (size_t i = 0; i < 1000; ++i) {
        auto v = std::to_string(i);
        expected.insert(i, std::to_string(i));
        rope.InsertBounded(i, asBytes(v));
        ASSERT_EQ(rope.ToString(), expected);
    }
}

TEST(Rope, SplitOffMid) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto half = expected.size() / 2;
        auto left = rope::Rope<128>::FromString(expected);
        auto right = left.SplitOff(half);
        ASSERT_EQ(left.ToString(), expected.substr(0, half));
        ASSERT_EQ(right.ToString(), expected.substr(half));
    }
}
