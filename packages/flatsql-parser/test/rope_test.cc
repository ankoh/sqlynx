#include "flatsql/text/rope.h"
#include "gtest/gtest.h"

using namespace flatsql;

static std::span<const std::byte> asBytes(std::string_view str) {
    return {reinterpret_cast<const std::byte*>(str.data()), str.size()};
}

TEST(RopeLeaf, SimpleOps) {
    Rope<128>::LeafNode node;
    EXPECT_TRUE(node.IsEmpty());

    node.PushString(asBytes(""));
    node.PushString(asBytes("test"));
    EXPECT_EQ(node.GetString(), "test");
    node.PushString(asBytes("foo"));
    EXPECT_EQ(node.GetString(), "testfoo");

    node.PushString(asBytes("1"));
    node.PushString(asBytes("2"));
    node.PushString(asBytes("3"));
    EXPECT_EQ(node.GetString(), "testfoo123");
    node.RemoveRange(4, 7);
    EXPECT_EQ(node.GetString(), "test123");
    node.Truncate(4);

    EXPECT_EQ(node.GetString(), "test");
    node.PushString(asBytes("nananana"));
    EXPECT_EQ(node.GetString(), "testnananana");
    Rope<128>::LeafNode right;
    node.SplitOff(4, right);
    EXPECT_EQ(node.GetString(), "test");
    EXPECT_EQ(right.GetString(), "nananana");
}

TEST(RopeLeaf, InsertStringSplit) {
    Rope<128>::LeafNode node;
    node.PushString(asBytes("0123456789"));
    Rope<128>::LeafNode right;
    node.PushStringSplit(asBytes("abc"), right);
    EXPECT_EQ(node.GetString(), "012345");
    EXPECT_EQ(right.GetString(), "6789abc");
}

TEST(RopeLeaf, EquiDistribute) {
    Rope<128>::LeafNode left;
    Rope<128>::LeafNode right;
    left.PushString(asBytes("01"));
    right.PushString(asBytes("23456789"));
    left.EquiDistribute(right);
    EXPECT_EQ(left.GetString(), "01234");
    EXPECT_EQ(right.GetString(), "56789");
}
