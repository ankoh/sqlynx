#include "sqlynx/utils/chunk_buffer.h"

#include "gtest/gtest.h"

using namespace sqlynx;

namespace {

TEST(ChunkBufferTest, Sequence) {
    ChunkBuffer<uint32_t> tree;
    for (size_t i = 0; i < 1024; ++i) {
        tree.Append(i);
        ASSERT_EQ(tree[i], i);
    }
    ASSERT_EQ(tree.GetSize(), 1024);
}

}  // namespace
