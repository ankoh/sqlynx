/// Significant parts of this file were derived from the Rust B-tree Rope "ropey".
///
/// Copyright (c) 2017 Nathan Vegdahl
///
/// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
/// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
/// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
/// permit persons to whom the Software is furnished to do so, subject to the following conditions:
///
/// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
/// Software.
///
/// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
/// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
/// OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
/// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cassert>
#include <span>
#include <string_view>
#include <type_traits>

#include "flatsql/text/utf8.h"
#include "utf8proc/utf8proc_wrapper.hpp"

namespace flatsql {

template <size_t PAGE_SIZE = 1024> struct Rope {
    struct TextStatistics {
        /// The text bytes
        size_t text_bytes;
        /// The UTF-8 characters (aka codepoints)
        size_t utf8_chars;
        /// The line breaks
        size_t line_breaks;
    };

    struct LeafNode;
    struct InnerNode;

    struct NodePtr {
       protected:
        /// The raw pointer
        uintptr_t raw_ptr;

       public:
        /// Create node ptr from leaf node
        static NodePtr From(LeafNode* ptr) {
            assert((reinterpret_cast<uintptr_t>(ptr) & 0b1) == 0);
            return {.raw_ptr = ptr};
        }
        /// Create node ptr from inner node
        static NodePtr From(InnerNode* ptr) {
            assert((reinterpret_cast<uintptr_t>(ptr) & 0b1) == 0);
            return {.raw_ptr = reinterpret_cast<uintptr_t>(ptr) | 0b1};
        }
        /// Get the tag
        uint8_t GetTag() { return raw_ptr & 0b1; }
        /// Is a leaf node?
        bool IsLeafNode() { return GetTag() == 0; }
        /// Is an inner node?
        bool IsInnerNode() { return GetTag() == 1; }
        /// Get as leaf node
        LeafNode* AsLeafNode() { return reinterpret_cast<LeafNode*>((raw_ptr >> 1) << 1); }
        /// Get as inner node
        InnerNode* AsInnerNode() { return reinterpret_cast<InnerNode*>((raw_ptr >> 1) << 1); }

        
    };

    static const size_t LEAF_NODE_CAPACITY = PAGE_SIZE - sizeof(uint16_t);
    static const size_t INNER_NODE_CAPACITY =
        (PAGE_SIZE - sizeof(uint8_t)) / (sizeof(TextStatistics) + sizeof(NodePtr));

    struct LeafNode {
       protected:
        /// The buffer size
        uint16_t buffer_size;
        /// The string buffer
        std::array<std::byte, LEAF_NODE_CAPACITY> buffer;

       public:
        /// Constructor
        LeafNode(std::string_view data = {}) : buffer_size(data.size()), buffer() {
            std::memcpy(buffer.data(), data.data(), data.size());
        }
        /// Get the size of the buffer
        auto GetSize() noexcept { return buffer_size; }
        /// Get the capacity of the buffer
        auto GetCapacity() noexcept { return LEAF_NODE_CAPACITY; }
        /// Get the data
        auto GetData() noexcept { return std::span<std::byte>{buffer.data(), buffer_size}; }
        /// Get buffer content as string
        auto GetString() noexcept { return std::string_view{reinterpret_cast<char*>(buffer.data()), GetSize()}; }

        /// Is valid?
        auto IsValid() noexcept { return utf8::isCodepointBoundary(GetData(), 0); }
        /// Is the node empty?
        auto IsEmpty() noexcept { return GetSize() == 0; }
        /// Reset the node
        auto Reset() noexcept { buffer_size = 0; }

        /// Insert raw bytes at an offset
        void InsertBytes(size_t ofs, std::span<const std::byte> data) noexcept {
            assert(ofs <= GetSize());
            assert(data.size() <= (GetCapacity() - ofs));
            assert(utf8::isCodepointBoundary(GetData(), ofs));

            std::memcpy(&buffer[ofs], data.data(), data.size());
            buffer_size += data.size();
        }
        /// Appends a string to the end of the buffer
        void PushBytes(std::span<const std::byte> str) noexcept { InsertBytes(GetSize(), str); }
        /// Remove text in range
        void RemoveByteRange(size_t start_byte_idx, size_t end_byte_idx) noexcept {
            assert(start_byte_idx <= end_byte_idx);
            assert(end_byte_idx <= GetSize());
            assert(utf8::isCodepointBoundary(GetData(), start_byte_idx));
            assert(utf8::isCodepointBoundary(GetData(), end_byte_idx));

            std::memmove(&buffer[start_byte_idx], &buffer[end_byte_idx], GetSize() - end_byte_idx);
            buffer_size -= end_byte_idx - start_byte_idx;
        }
        /// Removes text after byte_idx
        std::span<std::byte> TruncateBytes(size_t byte_idx) noexcept {
            assert(byte_idx <= GetSize());
            assert(utf8::isCodepointBoundary(GetData(), byte_idx));

            std::span<std::byte> tail{&buffer[byte_idx], GetSize() - byte_idx};
            buffer_size = byte_idx;
            return tail;
        }
        /// Splits node at index
        void SplitBytesOff(size_t byte_idx, LeafNode& dst) noexcept {
            assert(dst.IsEmpty());
            assert(byte_idx <= GetSize());
            assert(utf8::isCodepointBoundary(GetData(), byte_idx));

            dst.InsertBytes(0, TruncateBytes(byte_idx));
        }
        /// Inserts `string` at `byte_idx` and splits the resulting string in half.
        ///
        /// Only splits on code point boundaries, so if the whole string is a single code point the right node will be empty.
        void InsertBytesAndSplit(size_t byte_idx, std::span<const std::byte> str, LeafNode& right) {
            assert(right.IsEmpty());
            assert(utf8::isCodepointBoundary(GetData(), byte_idx));

            auto total_length = GetSize() + str.size();
            auto mid_idx = total_length / 2;
            auto inserted_begin = byte_idx;
            auto inserted_end = byte_idx + str.size();

            // Figure out the split index, accounting for code point boundaries.
            // We first copy the bytes in the area of the proposed split point into a small 8-byte buffer.
            // We then use that buffer to look for the real split point.
            size_t split_idx;
            {
                std::array<std::byte, 8> splitCandidates;
                auto candidates_begin = mid_idx - std::min<size_t>(4, mid_idx);
                auto candidates_end = std::min(mid_idx + 4, total_length);
                for (size_t i = candidates_begin; i < candidates_end; ++i) {
                    std::byte out;
                    if (i < inserted_begin) {
                        // The string will be inserted after i, just copy the buffer
                        out = buffer[i];
                    } else if (i < inserted_end) {
                        // The string will be inserted around the mid point, read the new chars
                        out = str[i - inserted_begin];
                    } else {
                        // The string will be inserted BEFORE i, thus we're seeing earlier chars
                        out = buffer[i - str.size()];
                    }
                    splitCandidates[i - candidates_begin] = out;
                }
                std::span<const std::byte> candidates{splitCandidates.data(), candidates_end - candidates_begin};
                split_idx = utf8::findNearestCodepoint(candidates, mid_idx - candidates_begin) + candidates_begin;
            }

            // Divide strings
            auto data = GetData();
            if (split_idx <= inserted_begin) {
                right.PushBytes(data.subspan(split_idx, inserted_begin - split_idx));
                right.PushBytes(str);
                right.PushBytes(data.subspan(inserted_begin));
                TruncateBytes(split_idx);
            } else if (split_idx <= inserted_end) {
                right.PushBytes(str.subspan(split_idx - inserted_begin));
                right.PushBytes(data.subspan(inserted_begin));
                TruncateBytes(inserted_begin);
                PushBytes(str.subspan(0, split_idx - inserted_begin));
            } else {
                right.PushBytes(data.subspan(split_idx - str.size()));
                TruncateBytes(split_idx - str.size());
                InsertBytes(inserted_begin, str);
            }
        }
        /// Appends a string and splits the resulting string in half.
        ///
        /// Only splits on code point boundaries, so if the whole string is a single code point,
        /// the split will fail and the returned string will be empty.
        void PushBytesAndSplit(std::span<const std::byte> str, LeafNode& right) {
            InsertBytesAndSplit(GetSize(), str, right);
        }
        /// Distribute children equally between nodes
        void BalanceBytesWith(LeafNode& right) {
            if (buffer_size < right.buffer_size) {
                // Right got more children than left, append surplus to left
                auto half_surplus = (right.buffer_size - buffer_size) / 2;
                auto move_left = utf8::findCodepoint(right.GetData(), half_surplus);
                std::memcpy(buffer.data() + GetSize(), right.buffer.data(), move_left);
                std::memmove(right.buffer.data(), right.buffer.data() + move_left, right.GetSize() - move_left);
                right.buffer_size -= move_left;
                buffer_size += move_left;

            } else if (buffer_size > right.buffer_size) {
                // Left got more children than right, prepend surplus to right
                auto half_surplus = (buffer_size - right.buffer_size) / 2;
                // Find first codepoint > (GetSize() - half_surplus - 1)
                auto move_right_from = utf8::findCodepoint(GetData(), GetSize() - half_surplus);
                auto move_right = GetSize() - move_right_from;
                std::memmove(right.buffer.data() + move_right, right.buffer.data(), move_right);
                std::memcpy(right.buffer.data(), buffer.data() + move_right_from, move_right);
                right.buffer_size += move_right;
                buffer_size -= move_right;
            }
            assert(IsValid());
            assert(right.IsValid());
        }
    };
    static_assert(sizeof(LeafNode) <= PAGE_SIZE, "Leaf node must fit on a page");
    static_assert(std::is_trivially_copyable_v<LeafNode>, "Leaf node must be trivially copyable");

    struct InnerNode {
       protected:
        /// The child statistics
        std::array<TextStatistics, INNER_NODE_CAPACITY> child_stats;
        /// The child nodes
        std::array<NodePtr, INNER_NODE_CAPACITY> child_nodes;
        /// The children count
        uint8_t child_count;

       public:
        /// Constructor
        InnerNode() : child_stats(), child_nodes(), child_count(0) {}

        /// Get the size of the node
        auto GetSize() noexcept { return child_count; }
        /// Get the capacity of the node
        auto GetCapacity() noexcept { return INNER_NODE_CAPACITY; }
        /// Get the statistics
        auto GetChildStats() noexcept { return std::span{child_stats.data(), GetSize()}; }
        /// Get child nodes
        auto GetChildNodes() noexcept { return std::span{child_nodes.data(), GetSize()}; }
        /// Is the node empty?
        auto IsEmpty() noexcept { return GetSize() == 0; }
        /// Is the node full?
        auto IsFull() noexcept { return GetSize() >= GetCapacity(); }

        /// Pushes an item into the array
        void Push(NodePtr child, TextStatistics childStats) {
            assert(!IsFull());
            childStats[child_count] = childStats;
            child_nodes[child_count] = child;
            ++child_count;
        }
        /// Pushes items into the array
        void Push(std::span<const NodePtr> nodes, std::span<const TextStatistics> stats) {
            assert(nodes.size() == stats.size())
            assert((GetCapacity() - GetSize()) <= nodes.size());
            std::memcpy(child_nodes.data() + GetSize(), nodes.data(), nodes.size());
            std::memcpy(child_stats.data() + GetSize(), stats.data(), nodes.size());
            child_count += nodes.size();
        }
        /// Pops an item from the end of the array
        std::pair<NodePtr, TextStatistics> Pop() {
            assert(!IsEmpty());
            --child_count;
            return {child_nodes[child_count], child_stats[child_count]};
        }
        /// Inserts an item at a position
        void Insert(size_t idx, NodePtr child, TextStatistics child_stats) {
            assert(idx <= GetSize());
            assert(GetSize() < GetCapacity());
            auto n = GetSize() - idx;
            std::memmove(&child_nodes[idx + 1], &child_nodes[idx], n);
            std::memmove(&child_stats[idx + 1], &child_stats[idx], n);
            child_nodes[idx] = child;
            child_stats[idx] = child_stats;
            ++child_count;
        }
        /// Remove an element at a position
        std::pair<NodePtr, TextStatistics> Remove(size_t idx) {
            assert(GetSize() > 0);
            assert(idx < GetSize());
            if ((idx + 1) < GetSize()) {
                auto tail = GetSize() - (idx + 1);
                std::memmove(&child_nodes[idx], &child_nodes[idx + 1], tail);
                std::memmove(&child_stats[idx], &child_nodes[idx + 1], tail);
            }
            --child_count;
        }
        /// Truncate children from a position
        std::pair<std::span<const NodePtr>, std::span<const TextStatistics>> Truncate(size_t idx) noexcept {
            assert(idx <= GetSize());
            std::span<const NodePtr> tail_nodes{&child_nodes[idx], GetSize() - idx};
            std::span<const TextStatistics> tail_stats{&child_stats[idx], GetSize() - idx};
            child_count = idx;
            return {tail_nodes, tail_stats};
        }
        /// Splits node at index
        void SplitOff(size_t byte_idx, InnerNode& dst) {
            assert(dst.IsEmpty());
            assert(byte_idx <= GetSize());

            dst.child_count = GetSize() - byte_idx;
            std::memcpy(dst.child_nodes.data(), &child_nodes[byte_idx], GetSize() - byte_idx);
            std::memcpy(dst.child_stats.data(), &child_stats[byte_idx], GetSize() - byte_idx);
            child_count = byte_idx;
        }
        /// Pushes an element onto the end of the array, and then splits it in half
        void PushAndSplit(NodePtr child, TextStatistics stats, InnerNode& dst) {
            auto r_count = (GetSize() + 1) / 2;
            auto l_count = (GetSize() + 1) - r_count;
            SplitChildrenOff(l_count, dst);
            dst.Push(child, stats);
        }
        /// Distribute children equally between nodes
        void BalanceWith(InnerNode& right) {
            if (child_count < right.child_count) {
                // Right got more children than left, append surplus to left
                auto move = (right.child_count - child_count) / 2;
                std::memcpy(child_nodes.data() + GetSize(), right.child_nodes.data(), move);
                std::memcpy(child_nodes.data() + GetSize(), right.child_stats.data(), move);
                std::memmove(right.child_nodes.data(), right.child_nodes.data() + move, right.GetSize() - move);
                std::memmove(right.child_stats.data(), right.child_stats.data() + move, right.GetSize() - move);
                right.child_count -= move;
                child_count += move;

            } else if (child_count > right.child_count) {
                // Left got more children than right, prepend surplus to right
                auto move = (child_count - right.child_count) / 2;
                auto move_from = GetSize() - move - 1;
                std::memmove(right.child_nodes.data() + move, right.child_nodes.data(), move);
                std::memmove(right.child_stats.data() + move, right.child_stats.data(), move);
                std::memcpy(right.child_nodes.data(), child_nodes.data() + move_from, move);
                std::memcpy(right.child_stats.data(), child_stats.data() + move_from, move);
                right.child_count += move;
                child_count -= move;
            }
        }
        /// Attempts to merge two nodes, and if it's too much data to merge equi-distributes it between the two
        /// Returns:
        /// - True, if merge was successful.
        /// - False, if merge failed, equidistributed instead.
        bool MergeOrBalance(size_t idx1, size_t idx2) {
            NodePtr child_node_1 = child_nodes[idx1];
            NodePtr child_node_2 = child_nodes[idx2];
            NodePtr child_stats_1 = child_stats[idx1];
            NodePtr child_stats_2 = child_stats[idx2];

            bool remove_right = false;
            if (child_node_1.IsLeafNode()) {
                assert(child_node_2.IsLeafNode());
                LeafNode* child_1 = child_node_1.AsLeafNode();
                LeafNode* child_2 = child_node_2.AsLeafNode();

                // Text fits into a single node?
                auto combined = child_1->GetSize() + child_2->GetSize();
                if (combined <= child_1->GetCapacity()) {
                    child_1->PushBytes(child_2->TruncateBytes());
                    assert(child_1->IsValid());
                    remove_right = true;
                } else {
                    child_1->BalanceBytesWith(*child_2);
                    assert(child_1->IsValid());
                    assert(child_2->IsValid());
                }
            } else {
                assert(child_node_1.IsInnerNode());
                assert(child_node_2.IsInnerNode());
                InnerNode* child_1 = child_node_1.AsInnerNode();
                InnerNode* child_2 = child_node_2.AsInnerNode();

                // Children fit into a single node?
                auto combined = child_1->GetSize() + child_2->GetSize();
                if (combined <= child_1->GetCapacity()) {
                    child_1->Push(child_2->TruncateChildren());
                    remove_right = true;
                } else {
                    child_1->EquiDistribute(*child_2);
                }
            }
        }
        /// Equi-distributes the children between the two child arrays, preserving ordering
        void DistributeWith(size_t idx1, size_t idx2);
        /// If the children are leaf nodes, compacts them to take up the fewest nodes
        void CompactLeafs();
        /// Inserts an element into a the array, and then splits it in half
        void InsertSplit(size_t idx, NodePtr child, TextStatistics stats, InnerNode& other);
        /// Removes the item at the given index from the the array.
        /// Decreases length by one.  Preserves ordering of the other items.
        std::pair<TextStatistics, NodePtr> Remove();
    };
    static_assert(sizeof(InnerNode) <= PAGE_SIZE, "Inner node must fit on a page");
    static_assert(std::is_trivially_copyable_v<InnerNode>, "Inner node must be trivially copyable");
};

}  // namespace flatsql
