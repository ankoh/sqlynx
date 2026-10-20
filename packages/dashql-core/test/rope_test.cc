#include "dashql/text/rope.h"
#include "gtest/gtest.h"
#include "dashql/testing/rope_test_common.h"

using namespace dashql;
using namespace dashql::rope_test;

namespace {

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

TEST_F(RopeTest, RejectsCodepointIndexPastBuffer) {
    EXPECT_THROW(utf8::codepointToByteIdx(asBytes("abc"), 4), std::out_of_range);
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
        ASSERT_NO_THROW(rope.CheckIntegrity());
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
        ASSERT_NO_THROW(rope.CheckIntegrity());
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
        ASSERT_NO_THROW(rope.CheckIntegrity());
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
        ASSERT_NO_THROW(rope.CheckIntegrity());
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
        ASSERT_NO_THROW(rope.CheckIntegrity());
    }
}

TEST_F(RopeTest, FromText) {
    std::string expected;
    for (size_t i = 0; i < 1000; ++i) {
        expected += std::to_string(i);
        auto rope = TestableRope::FromString(128, expected);
        ASSERT_EQ(rope.ToString(), expected);
        ASSERT_EQ(rope.GetStats().utf8_codepoints, expected.size());
        ASSERT_NO_THROW(rope.CheckIntegrity());
    }
}

TEST_F(RopeTest, TracksGraphemeClustersAndPositions) {
    rope::Rope rope{128, "a👩‍💻é界"};
    EXPECT_EQ(rope.GetStats().utf8_codepoints, 7);
    EXPECT_EQ(rope.GetStats().utf16_code_units, 9);
    EXPECT_EQ(rope.GetStats().grapheme_clusters, 4);

    EXPECT_EQ(rope.ResolveGrapheme(0).text_bytes, 0);
    EXPECT_EQ(rope.ResolveGrapheme(1).text_bytes, 1);
    EXPECT_EQ(rope.ResolveGrapheme(2).text_bytes, 1 + std::string{"👩‍💻"}.size());
    EXPECT_EQ(rope.ResolveGrapheme(3).utf8_codepoints, 6);
    EXPECT_EQ(rope.ResolveGrapheme(4).text_bytes, rope.ToString().size());
    EXPECT_FALSE(rope.ResolveGraphemeBoundary(2).has_value());
    EXPECT_EQ(rope.ResolveGraphemeBoundaryAtOrAfter(2).grapheme_clusters, 2);
}

TEST_F(RopeTest, ResolvesUtf8AndUtf16CodepointBoundaries) {
    rope::Rope rope{64, "aé😀z", 8, 2};
    EXPECT_EQ(rope.GetStats().text_bytes, 8);
    EXPECT_EQ(rope.GetStats().utf8_codepoints, 4);
    EXPECT_EQ(rope.GetStats().utf16_code_units, 5);

    auto emoji_from_bytes = rope.ResolveByteBoundary(3);
    ASSERT_TRUE(emoji_from_bytes.has_value());
    EXPECT_EQ(emoji_from_bytes->utf16_code_units, 2);
    auto emoji_end = rope.ResolveUtf16Boundary(4);
    ASSERT_TRUE(emoji_end.has_value());
    EXPECT_EQ(emoji_end->text_bytes, 7);
    EXPECT_EQ(emoji_end->utf8_codepoints, 3);
    EXPECT_FALSE(rope.ResolveByteBoundary(4).has_value());
    EXPECT_FALSE(rope.ResolveUtf16Boundary(3).has_value());
}

TEST_F(RopeTest, KeepsLeafSplitsOnGraphemeBoundaries) {
    const std::string text = "alpha👩‍💻bravoécharlie界delta";
    auto rope = TestableRope::FromString(128, text, 16, 2);
    EXPECT_EQ(rope.ToString(), text);
    EXPECT_EQ(rope.GetStats().grapheme_clusters, 25);
    ASSERT_NO_THROW(rope.CheckIntegrity());

    size_t byte_offset = 0;
    for (auto* leaf = rope.GetFirstLeaf(); leaf != nullptr; leaf = leaf->GetNext()) {
        byte_offset += leaf->GetSize();
        EXPECT_TRUE(rope.ResolveGraphemeBoundary(byte_offset).has_value());
    }
}

TEST_F(RopeTest, RecomputesGraphemesAcrossEditBoundaries) {
    rope::Rope rope{128, "👩💻"};
    rope.Insert(1, "‍");
    EXPECT_EQ(rope.ToString(), "👩‍💻");
    EXPECT_EQ(rope.GetStats().grapheme_clusters, 1);
    ASSERT_NO_THROW(rope.CheckIntegrity());

    rope.Remove(1, 1);
    EXPECT_EQ(rope.ToString(), "👩💻");
    EXPECT_EQ(rope.GetStats().grapheme_clusters, 2);
    ASSERT_NO_THROW(rope.CheckIntegrity());
}

TEST_F(RopeTest, RemovesEmptyRangeAtEndOfMultiLeafText) {
    std::string text(4096, 'a');
    rope::Rope rope{128, text};
    for (size_t char_idx : {text.size(), text.size() + 1, size_t{0}, text.size() / 2}) {
        rope.Remove(char_idx, 0);
        EXPECT_EQ(rope.ToString(), text);
        ASSERT_NO_THROW(rope.CheckIntegrity());
    }
    rope.Remove(text.size(), 10);
    EXPECT_EQ(rope.ToString(), text);
    rope.Insert(text.size(), "b");
    EXPECT_EQ(rope.ToString(), text + "b");
    ASSERT_NO_THROW(rope.CheckIntegrity());
}

TEST_F(RopeTest, RejectsGraphemeLargerThanLeaf) {
    std::string combining = "a";
    for (size_t i = 0; i < 24; ++i) {
        combining += "́";
    }
    EXPECT_THROW((rope::Rope{64, combining}), std::length_error);
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
        ASSERT_NO_THROW(right.CheckIntegrity());
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
        ASSERT_NO_THROW(left.CheckIntegrity());
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
        ASSERT_NO_THROW(left_rope.CheckIntegrity());
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
        ASSERT_NO_THROW(left_rope.CheckIntegrity());
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
        ASSERT_NO_THROW(left_rope.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
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
        ASSERT_NO_THROW(buffer.CheckIntegrity());
    }
}

TEST_F(RopeTest, ReadEmpty) {
    rope::Rope rope{128};
    std::string tmp;
    ASSERT_EQ("", rope.Read(0, 10, tmp));
}

TEST_F(RopeTest, ReadHalf) {
    rope::Rope rope{128};
    std::string text;
    for (size_t i = 0; i < 1000; ++i) {
        text += std::to_string(i);
        rope.Insert(rope.GetStats().utf8_codepoints, std::to_string(i));
        auto half = text.size() / 2;
        std::string tmp;
        auto want = std::string_view{text}.substr(0, half);
        auto have = rope.Read(0, half, tmp);
        ASSERT_EQ(want, have);
        want = std::string_view{text}.substr(half);
        have = rope.Read(half, text.size() - half, tmp);
        ASSERT_EQ(want, have);
    }
}

TEST_F(RopeTest, OstreamAppend) {
    rope::Rope rope{128};
    rope << "test";
    ASSERT_EQ("test", rope.ToString());
    rope << "2";
    ASSERT_EQ("test2", rope.ToString());
    rope << "\n";
    ASSERT_EQ("test2\n", rope.ToString());
}

TEST_F(RopeTest, OstreamConcat) {
    rope::Rope rope1{128};
    rope::Rope rope2{128};
    rope1 << "test";
    ASSERT_EQ("test", rope1.ToString());
    rope2 << "2\n";
    ASSERT_EQ("2\n", rope2.ToString());
    rope1 << std::move(rope2);
    ASSERT_EQ("test2\n", rope1.ToString());
}

}  // namespace
