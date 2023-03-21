#include "flatsql/utils/append_buffer.h"
#include "gtest/gtest.h"

using namespace flatsql;

TEST(AppendBuffer, Sequence) {
    AppendBuffer<uint32_t> tree;
    for (size_t i = 0; i < 1024; ++i) {
        tree.Append(i);
        ASSERT_EQ(tree[i], i);
    }
    ASSERT_EQ(tree.GetSize(), 1024);
}
