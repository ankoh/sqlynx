#include "flatsql/utils/append_tree.h"
#include "gtest/gtest.h"

using namespace flatsql;

TEST(AppendTree, Ops_8_2) {
    AppendTree<uint32_t, 8, 2> tree;

    auto [leaf, leaf_idx] = tree.Find(0);
    ASSERT_EQ(leaf, nullptr);

    for (size_t i = 0; i < 17; ++i) {
        tree.Append(i);
        ASSERT_EQ(tree.GetSize(), i + 1);
    }
    ASSERT_EQ(tree.GetLevelCount(), 2);
    ASSERT_EQ(tree.GetRoot()->child_count, 2);

    for (size_t i = 0; i < 17; ++i) {
        auto [leaf, leaf_idx] = tree.Find(i);
        ASSERT_EQ(leaf->values[leaf_idx], i) << leaf_idx;
    }
    for (size_t i = 17; i < 24; ++i) {
        tree.Append(i);
        ASSERT_EQ(tree.GetSize(), i + 1);
    }
    ASSERT_EQ(tree.GetLevelCount(), 2);

    for (size_t i = 24; i < 32; ++i) {
        tree.Append(i);
        ASSERT_EQ(tree.GetSize(), i + 1);
    }
    ASSERT_EQ(tree.GetLevelCount(), 2);
    ASSERT_EQ(tree.GetRoot()->child_count, 2);

    for (size_t i = 32; i < 48; ++i) {
        tree.Append(i);
        ASSERT_EQ(tree.GetSize(), i + 1);
    }
    ASSERT_EQ(tree.GetLevelCount(), 3);
    ASSERT_EQ(tree.GetRoot()->child_count, 2);
    ASSERT_EQ(tree.GetSize(), 48);
}

TEST(AppendTree, Sequence_8_2) {
    AppendTree<uint32_t, 8, 2> tree;
    for (size_t i = 0; i < 1024; ++i) {
        tree.Append(i);
    }
    uint32_t next = 0;
    for (auto leaf = tree.GetLeafs(); leaf != nullptr; leaf = leaf->next_node) {
        for (auto value: leaf->GetValues()) {
            ASSERT_EQ(value, next++);
        }
    }
    ASSERT_EQ(tree.GetSize(), 1024);
}

TEST(AppendTree, Sequence_32_8) {
    AppendTree<uint32_t, 32, 8> tree;
    for (size_t i = 0; i < 1024; ++i) {
        tree.Append(i);
    }
    uint32_t next = 0;
    for (auto leaf = tree.GetLeafs(); leaf != nullptr; leaf = leaf->next_node) {
        for (auto value: leaf->GetValues()) {
            ASSERT_EQ(value, next++);
        }
    }
    ASSERT_EQ(tree.GetSize(), 1024);
}
