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
    EXPECT_EQ(node.GetString(), "test");
    node.PushBytes(asBytes("foo"));
    EXPECT_EQ(node.GetString(), "testfoo");

    node.PushBytes(asBytes("1"));
    node.PushBytes(asBytes("2"));
    node.PushBytes(asBytes("3"));
    EXPECT_EQ(node.GetString(), "testfoo123");
    node.RemoveByteRange(4, 7);
    EXPECT_EQ(node.GetString(), "test123");
    node.TruncateBytes(4);

    EXPECT_EQ(node.GetString(), "test");
    node.PushBytes(asBytes("nananana"));
    EXPECT_EQ(node.GetString(), "testnananana");
    rope::LeafNode<128> right;
    node.SplitBytesOff(4, right);
    EXPECT_EQ(node.GetString(), "test");
    EXPECT_EQ(right.GetString(), "nananana");
}

TEST(RopeLeafNode, PushBytesAndSplit) {
    rope::LeafNode<128> node;
    node.PushBytes(asBytes("0123456789"));
    rope::LeafNode<128> right;
    node.PushBytesAndSplit(asBytes("abc"), right);
    EXPECT_EQ(node.GetString(), "012345");
    EXPECT_EQ(right.GetString(), "6789abc");
}

TEST(RopeLeafNode, BalanceBytesWith) {
    rope::LeafNode<128> left;
    rope::LeafNode<128> right;
    left.PushBytes(asBytes("01"));
    right.PushBytes(asBytes("23456789"));
    left.BalanceBytes(right);
    EXPECT_EQ(left.GetString(), "01234");
    EXPECT_EQ(right.GetString(), "56789");

    left.TruncateBytes(0);
    right.TruncateBytes(0);
    left.PushBytes(asBytes("abcdefgh"));
    right.PushBytes(asBytes("ij"));
    left.BalanceBytes(right);
    EXPECT_EQ(left.GetString(), "abcde");
    EXPECT_EQ(right.GetString(), "fghij");
}

TEST(RopeInnerNode, InsertBoundedEnd) {
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

TEST(RopeInnerNode, InsertBounded0) {
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

TEST(RopeInnerNode, InsertBounded1IDiv2) {
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

TEST(RopeInnerNode, InsertBounded1IDiv3) {
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

TEST(RopeInnerNode, InsertBounded2IDiv3) {
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
