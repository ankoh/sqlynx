#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <span>
#include <string_view>
#include <type_traits>

#include "flatsql/text/utf8.h"
#include "flatsql/utils/small_vector.h"
#include "utf8proc/utf8proc_wrapper.hpp"

namespace flatsql::rope {

struct TextInfo {
    /// The text bytes
    size_t text_bytes = 0;
    /// The UTF-8 codepoints
    size_t utf8_codepoints = 0;
    /// The line breaks
    size_t line_breaks = 0;

    /// Constructor
    TextInfo() {}
    /// Constructor
    TextInfo(std::span<std::byte> data) : TextInfo(std::span<const std::byte>(data)) {}
    /// Constructor
    TextInfo(std::span<const std::byte> data) : text_bytes(data.size()) {
        for (auto b : data) {
            line_breaks += (b == std::byte{0x0A});
            utf8_codepoints += utf8::isCodepointBoundary(b);
        }
    }
    TextInfo operator+(const TextInfo& other) {
        TextInfo result = *this;
        result.text_bytes += other.text_bytes;
        result.utf8_codepoints += other.utf8_codepoints;
        result.line_breaks += other.line_breaks;
        return result;
    }
    TextInfo& operator+=(const TextInfo& other) {
        *this = *this + other;
        return *this;
    }
    TextInfo operator-(const TextInfo& other) {
        TextInfo result = *this;
        result.text_bytes -= other.text_bytes;
        result.utf8_codepoints -= other.utf8_codepoints;
        result.line_breaks -= other.line_breaks;
        return result;
    }
    TextInfo& operator-=(const TextInfo& other) {
        *this = *this - other;
        return *this;
    }
};

struct Rope;
struct LeafNode;
struct InnerNode;

struct PagePtr {
    protected:
    /// The page
    std::unique_ptr<std::byte[]> page;

    public:
    /// Constructor
    PagePtr(size_t page_size): page(std::make_unique_for_overwrite<std::byte[]>(page_size)) {}
    /// Constructor
    PagePtr(void* buffer): page() {}
    /// Move constructor
    PagePtr(PagePtr&& other) = default;
    /// Move assignment
    PagePtr& operator=(PagePtr&& other) = default;

    /// Get raw page pointer
    std::byte* Get() { return page.get(); }
    /// Cast leaf pointer
    template <typename T>
    T* Cast() { return reinterpret_cast<T*>(page.get()); }
    /// Release leaf pointer
    template <typename T = void>
    T* Release() { return reinterpret_cast<T*>(page.release()); }
};

struct NodePtr {
   protected:
    /// The raw pointer
    uintptr_t raw_ptr;

   public:
    /// Default constructor
    NodePtr() : raw_ptr(0) {}
    /// Create node ptr from leaf node
    NodePtr(LeafNode* ptr) : raw_ptr(reinterpret_cast<uintptr_t>(ptr)) {
        assert((reinterpret_cast<uintptr_t>(ptr) & 0b1) == 0);
    }
    /// Create node ptr from inner node
    NodePtr(InnerNode* ptr) : raw_ptr(reinterpret_cast<uintptr_t>(ptr) | 0b1) {
        assert((reinterpret_cast<uintptr_t>(ptr) & 0b1) == 0);
    }
    /// Get the tag
    uint8_t GetTag() { return raw_ptr & 0b1; }
    /// Is null?
    bool IsNull() { return raw_ptr == 0; }
    /// Is a leaf node?
    bool IsLeafNode() { return GetTag() == 0; }
    /// Is an inner node?
    bool IsInnerNode() { return GetTag() == 1; }
    /// Get as leaf node
    LeafNode* AsLeafNode() { return reinterpret_cast<LeafNode*>((raw_ptr >> 1) << 1); }
    /// Get as inner node
    InnerNode* AsInnerNode() { return reinterpret_cast<InnerNode*>((raw_ptr >> 1) << 1); }
};

struct LeafNode {
    friend struct Rope;
    static constexpr size_t Capacity(size_t page_size) {
        return page_size - 2 * sizeof(void*) - 2 * sizeof(uint32_t);
    }

   protected:
    /// The previous leaf (if any)
    LeafNode* previous_node = nullptr;
    /// The next leaf (if any)
    LeafNode* next_node = nullptr;
    /// The buffer capacity
    uint32_t buffer_capacity = 0;
    /// The buffer size
    uint32_t buffer_size = 0;

    /// Get the data
    auto GetDataBuffer() noexcept {
        auto buffer = reinterpret_cast<std::byte*>(this + 1);
        return std::span<std::byte>{buffer, buffer_capacity};
    }

   public:
    /// Constructor
    LeafNode(uint32_t page_size) : buffer_capacity(Capacity(page_size)) {}
    /// Get the capacity of the buffer
    auto GetCapacity() noexcept { return buffer_capacity; }
    /// Get the size of the buffer
    auto GetSize() noexcept { return buffer_size; }
    /// Get the data
    auto GetData() noexcept { return GetDataBuffer().subspan(0, buffer_size); }
    /// Get buffer content as string
    auto GetStringView() noexcept {
        return std::string_view{reinterpret_cast<char*>(GetData().data()), GetSize()};
    }

    /// Is valid?
    auto IsValid() noexcept { return utf8::isCodepointBoundary(GetData(), 0); }
    /// Is the node empty?
    auto IsEmpty() noexcept { return GetSize() == 0; }
    /// Reset the node
    auto Reset() noexcept { buffer_size = 0; }

    /// Link a neighbor
    void LinkNeighbors(LeafNode& other) {
        if (next_node) {
            other.next_node = next_node;
            next_node->previous_node = &other;
        }
        next_node = &other;
        other.previous_node = this;
    }
    /// Insert raw bytes at an offset
    void InsertBytes(size_t ofs, std::span<const std::byte> data) noexcept {
        assert(ofs <= GetSize());
        assert((GetCapacity() - ofs) >= data.size());
        assert(utf8::isCodepointBoundary(GetData(), ofs));

        auto buffer = GetDataBuffer();
        std::memmove(&buffer[ofs + data.size()], &buffer[ofs], buffer_size - ofs);
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

        auto buffer = GetDataBuffer();
        std::memmove(&buffer[start_byte_idx], &buffer[end_byte_idx], GetSize() - end_byte_idx);
        buffer_size -= end_byte_idx - start_byte_idx;
    }
    /// Remove text in range
    TextInfo RemoveCharRange(size_t start_idx, size_t end_idx) noexcept {
        auto byte_start = utf8::codepointToByteIdx(GetData(), start_idx);
        auto byte_end = byte_start + utf8::codepointToByteIdx(GetData().subspan(byte_start), end_idx - start_idx);
        auto byte_count = byte_end - byte_start;
        TextInfo stats{GetData().subspan(byte_start, byte_count)};
        RemoveByteRange(byte_start, byte_count);
        return stats;
    }
    /// Removes text after byte_idx
    std::span<std::byte> TruncateBytes(size_t byte_idx = 0) noexcept {
        assert(byte_idx <= GetSize());
        assert(utf8::isCodepointBoundary(GetData(), byte_idx));

        auto buffer = GetDataBuffer();
        std::span<std::byte> tail{&buffer[byte_idx], GetSize() - byte_idx};
        buffer_size = byte_idx;
        return tail;
    }
    /// Splits bytes at index
    void SplitBytesOff(size_t byte_idx, LeafNode& right) noexcept {
        assert(right.IsEmpty());
        assert(byte_idx <= GetSize());
        assert(utf8::isCodepointBoundary(GetData(), byte_idx));

        right.InsertBytes(0, TruncateBytes(byte_idx));
        LinkNeighbors(right);
    }
    /// Split chars at index
    void SplitCharsOff(size_t char_idx, LeafNode& right) noexcept {
        auto byte_idx = utf8::codepointToByteIdx(GetData(), char_idx);
        SplitBytesOff(byte_idx, right);
    }
    /// Inserts `string` at `byte_idx` and splits the resulting string in half.
    /// Only splits on code point boundaries, so if the whole string is a single code point the right node will be
    /// empty.
    void InsertBytesAndSplit(size_t byte_idx, std::span<const std::byte> str, LeafNode& right) {
        assert(right.IsEmpty());
        assert(utf8::isCodepointBoundary(GetData(), byte_idx));

        auto buffer = GetDataBuffer();
        auto total_length = GetSize() + str.size();
        auto mid_idx = total_length / 2;
        auto insert_begin = byte_idx;
        auto insert_end = byte_idx + str.size();

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
                if (i < insert_begin) {
                    // The string will be inserted after i, just copy the buffer
                    out = buffer[i];
                } else if (i < insert_end) {
                    // The string will be inserted around the mid point, read the new chars
                    out = str[i - insert_begin];
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
        if (split_idx < insert_begin) {
            right.PushBytes(data.subspan(split_idx, insert_begin - split_idx));
            right.PushBytes(str);
            right.PushBytes(data.subspan(insert_begin));
            TruncateBytes(split_idx);
        } else if (split_idx < insert_end) {
            right.PushBytes(str.subspan(split_idx - insert_begin));
            right.PushBytes(data.subspan(insert_begin));
            TruncateBytes(insert_begin);
            PushBytes(str.subspan(0, split_idx - insert_begin));
        } else {
            auto tail_after_inserting = split_idx - str.size();
            right.PushBytes(data.subspan(tail_after_inserting));
            TruncateBytes(tail_after_inserting);
            InsertBytes(insert_begin, str);
        }

        // Store as neighbor
        LinkNeighbors(right);
    }
    /// Appends a string and splits the resulting string in half.
    ///
    /// Only splits on code point boundaries, so if the whole string is a single code point,
    /// the split will fail and the returned string will be empty.
    void PushBytesAndSplit(std::span<const std::byte> str, LeafNode& right) {
        InsertBytesAndSplit(GetSize(), str, right);
    }
    /// Distribute children equally between nodes
    void BalanceBytes(LeafNode& right) {
        auto left_buffer = GetDataBuffer();
        auto right_buffer = right.GetDataBuffer();

        if (buffer_size < right.buffer_size) {
            // Right got more children than left, append surplus to left
            auto half_surplus = (right.buffer_size - buffer_size) / 2;
            auto move_left = utf8::findCodepoint(right.GetData(), half_surplus);
            std::memcpy(left_buffer.data() + GetSize(), right_buffer.data(), move_left);
            std::memmove(right_buffer.data(), right_buffer.data() + move_left, right.GetSize() - move_left);
            right.buffer_size -= move_left;
            buffer_size += move_left;

        } else if (buffer_size > right.buffer_size) {
            // Left got more children than right, prepend surplus to right
            auto half_surplus = (buffer_size - right.buffer_size) / 2;
            // Find first codepoint > (GetSize() - half_surplus - 1)
            auto move_right_from = utf8::findCodepoint(GetData(), GetSize() - half_surplus);
            auto move_right = GetSize() - move_right_from;
            std::memmove(right_buffer.data() + move_right, right_buffer.data(), move_right);
            std::memcpy(right_buffer.data(), left_buffer.data() + move_right_from, move_right);
            right.buffer_size += move_right;
            buffer_size -= move_right;
        }
        assert(IsValid());
        assert(right.IsValid());
    }

    /// Create a leaf node from a string
    static PagePtr FromString(size_t page_size, std::string_view& text) {
        PagePtr leaf_page{page_size};
        auto leaf = new (leaf_page.Get()) LeafNode(page_size);
        std::span<const std::byte> bytes{reinterpret_cast<const std::byte*>(text.data()), text.size()};
        if (text.size() <= leaf->GetCapacity()) {
            leaf->PushBytes(bytes);
            text = {};
            return leaf_page;
        }
        bytes = bytes.subspan(0, std::min<size_t>(leaf->GetCapacity(), text.size()));
        for (auto iter = bytes.rbegin(); iter != bytes.rend(); ++iter) {
            if (utf8::isCodepointBoundary(*iter)) {
                bytes = bytes.subspan(0, bytes.rend() - iter);
                break;
            }
        }
        leaf->PushBytes(bytes);
        text = text.substr(bytes.size());
        return leaf_page;
    }
};

struct InnerNode {
    friend struct Rope;
    static constexpr size_t Capacity(size_t page_size) {
        return (page_size - 2 * sizeof(void*) - 2 * sizeof(uint32_t) - 8) / (sizeof(TextInfo) + sizeof(NodePtr));
    }

   protected:
    /// The previous leaf (if any)
    InnerNode* previous_node = nullptr;
    /// The next leaf (if any)
    InnerNode* next_node = nullptr;
    /// The child capacity
    uint32_t child_capacity = 0;
    /// The child count
    uint32_t child_count = 0;

    /// Get the child stats buffer
    auto GetChildStatsBuffer() noexcept {
        auto buffer = reinterpret_cast<TextInfo*>(this + 1);
        return std::span<TextInfo>{buffer, child_capacity};
    }
    /// Get the child nodes buffer
    auto GetChildNodesBuffer() noexcept {
        auto stats_end = GetChildStatsBuffer().data() + child_capacity;
        auto buffer = reinterpret_cast<NodePtr*>(stats_end);
        return std::span<NodePtr>{buffer, child_capacity};
    }


   public:
    /// Constructor
    InnerNode(size_t page_size)
        : child_capacity(Capacity(page_size)) {}

    /// Get the capacity of the node
    size_t GetCapacity() noexcept { return child_capacity; }
    /// Get the size of the node
    size_t GetSize() noexcept { return child_count; }
    /// Get the statistics
    auto GetChildStats() noexcept { return GetChildStatsBuffer().subspan(0, GetSize()); }
    /// Get child nodes
    auto GetChildNodes() noexcept { return GetChildNodesBuffer().subspan(0, GetSize()); }
    /// Is the node empty?
    auto IsEmpty() noexcept { return GetSize() == 0; }
    /// Is the node full?
    auto IsFull() noexcept { return GetSize() >= GetCapacity(); }

    /// Link a neighbor
    void LinkNeighbors(InnerNode& other) {
        if (next_node) {
            other.next_node = next_node;
            next_node->previous_node = &other;
        }
        next_node = &other;
        other.previous_node = this;
    }
    /// Combine the text statistics
    auto AggregateTextInfo() noexcept {
        TextInfo acc;
        for (auto stats : GetChildStats()) {
            acc += stats;
        }
        return acc;
    }
    /// Pushes an item into the array
    void Push(NodePtr child, TextInfo stats) {
        assert(!IsFull());
        GetChildStatsBuffer()[child_count] = stats;
        GetChildNodesBuffer()[child_count] = child;
        ++child_count;
    }
    /// Pushes items into the array
    void Push(std::span<const NodePtr> nodes, std::span<const TextInfo> stats) {
        assert(nodes.size() == stats.size());
        assert((GetCapacity() - GetSize()) <= nodes.size());
        std::memcpy(GetChildNodesBuffer().data() + GetSize(), nodes.data(), nodes.size() * sizeof(NodePtr));
        std::memcpy(GetChildNodesBuffer().data() + GetSize(), stats.data(), nodes.size() * sizeof(TextInfo));
        child_count += nodes.size();
    }
    /// Pops an item from the end of the array
    std::pair<NodePtr, TextInfo> Pop() {
        assert(!IsEmpty());
        --child_count;
        return {GetChildNodesBuffer()[child_count], GetChildStatsBuffer()[child_count]};
    }
    /// Inserts an item at a position
    void Insert(size_t idx, NodePtr child, TextInfo stats) {
        assert(idx <= GetSize());
        assert(GetSize() < GetCapacity());
        auto tail = GetSize() - idx;
        auto child_nodes = GetChildNodesBuffer();
        auto child_stats = GetChildStatsBuffer();
        std::memmove(&child_nodes[idx + 1], &child_nodes[idx], tail * sizeof(NodePtr));
        std::memmove(&child_stats[idx + 1], &child_stats[idx], tail * sizeof(TextInfo));
        child_nodes[idx] = child;
        child_stats[idx] = stats;
        ++child_count;
    }
    /// Remove an element at a position
    std::pair<NodePtr, TextInfo> Remove(size_t idx) {
        assert(GetSize() > 0);
        assert(idx < GetSize());
        auto child_nodes = GetChildNodesBuffer();
        auto child_stats = GetChildStatsBuffer();
        auto n = child_nodes[idx];
        auto s = child_stats[idx];
        if ((idx + 1) < GetSize()) {
            auto tail = GetSize() - (idx + 1);
            std::memmove(&child_nodes[idx], &child_nodes[idx + 1], tail * sizeof(NodePtr));
            std::memmove(&child_stats[idx], &child_stats[idx + 1], tail * sizeof(TextInfo));
        }
        --child_count;
        return {n, s};
    }
    /// Truncate children from a position
    std::pair<std::span<const NodePtr>, std::span<const TextInfo>> Truncate(size_t idx) noexcept {
        assert(idx <= GetSize());
        std::span<const NodePtr> tail_nodes{&GetChildNodesBuffer()[idx], GetSize() - idx};
        std::span<const TextInfo> tail_stats{&GetChildStatsBuffer()[idx], GetSize() - idx};
        child_count = idx;
        return {tail_nodes, tail_stats};
    }
    /// Splits node at index
    void SplitOff(size_t child_idx, InnerNode& right) {
        assert(right.IsEmpty());
        assert(child_idx <= GetSize());

        right.child_count = GetSize() - child_idx;
        std::memcpy(right.GetChildNodesBuffer().data(), &GetChildNodesBuffer()[child_idx], right.child_count * sizeof(NodePtr));
        std::memcpy(right.GetChildStatsBuffer().data(), &GetChildStatsBuffer()[child_idx], right.child_count * sizeof(TextInfo));
        child_count = child_idx;

        LinkNeighbors(right);
    }
    /// Pushes an element onto the end of the array, and then splits it in half
    void PushAndSplit(NodePtr child, TextInfo stats, InnerNode& dst) {
        auto r_count = (GetSize() + 1) / 2;
        auto l_count = (GetSize() + 1) - r_count;
        SplitOff(l_count, dst);
        dst.Push(child, stats);
    }
    /// Inserts an element into a the array, and then splits it in half
    void InsertAndSplit(size_t idx, NodePtr child, TextInfo stats, InnerNode& other) {
        assert(GetSize() > 0);
        assert(idx <= GetSize());
        std::pair<NodePtr, TextInfo> extra{child, stats};
        if (idx < GetSize()) {
            extra = Pop();
            Insert(idx, child, stats);
        }
        PushAndSplit(std::get<0>(extra), std::get<1>(extra), other);
    }
    /// Distribute children equally between nodes
    void Balance(InnerNode& right) {
        auto left_nodes = GetChildNodesBuffer();
        auto left_stats = GetChildStatsBuffer();
        auto right_nodes = GetChildNodesBuffer();
        auto right_stats = GetChildStatsBuffer();

        if (child_count < right.child_count) {
            // Right got more children than left, append surplus to left
            auto move = (right.child_count - child_count) / 2;
            std::memcpy(left_nodes.data() + GetSize(), right_nodes.data(), move * sizeof(NodePtr));
            std::memcpy(left_stats.data() + GetSize(), right_stats.data(), move * sizeof(TextInfo));
            std::memmove(right_nodes.data(), right_nodes.data() + move,
                         (right.GetSize() - move) * sizeof(NodePtr));
            std::memmove(right_stats.data(), right_stats.data() + move,
                         (right.GetSize() - move) * sizeof(TextInfo));
            right.child_count -= move;
            child_count += move;

        } else if (child_count > right.child_count) {
            // Left got more children than right, prepend surplus to right
            auto move = (child_count - right.child_count) / 2;
            auto move_from = GetSize() - move - 1;
            std::memmove(right_nodes.data() + move, right_nodes.data(), move * sizeof(NodePtr));
            std::memmove(right_stats.data() + move, right_stats.data(), move * sizeof(TextInfo));
            std::memcpy(right_nodes.data(), left_nodes.data() + move_from, move * sizeof(NodePtr));
            std::memcpy(right_stats.data(), left_stats.data() + move_from, move * sizeof(TextInfo));
            right.child_count += move;
            child_count -= move;
        }
    }

//    /// Attempts to merge two nodes, and if it's too much data to merge equi-distributes it between the two
//    /// Returns:
//    /// - True, if merge was successful.
//    /// - False, if merge failed, equidistributed instead.
//    bool MergeOrBalance(size_t idx1, size_t idx2) {
//        auto child_nodes = GetChildNodesBuffer();
//        auto child_stats = GetChildStatsBuffer();
//        NodePtr child_node_1 = child_nodes[idx1];
//        NodePtr child_node_2 = child_nodes[idx2];
//        TextInfo child_stats_1 = child_stats[idx1];
//        TextInfo child_stats_2 = child_stats[idx2];
//
//        bool remove_right = false;
//        if (child_node_1.IsLeafNode()) {
//            assert(child_node_2.IsLeafNode());
//            LeafNode* child_1 = child_node_1.AsLeafNode();
//            LeafNode* child_2 = child_node_2.AsLeafNode();
//
//            // Text fits into a single node?
//            auto combined = child_1->GetSize() + child_2->GetSize();
//            if (combined <= child_1->GetCapacity()) {
//                child_1->PushBytes(child_2->TruncateBytes());
//                assert(child_1->IsValid());
//                remove_right = true;
//            } else {
//                child_1->BalanceBytes(*child_2);
//                assert(child_1->IsValid());
//                assert(child_2->IsValid());
//            }
//        } else {
//            assert(child_node_1.IsInnerNode());
//            assert(child_node_2.IsInnerNode());
//            InnerNode* child_1 = child_node_1.AsInnerNode();
//            InnerNode* child_2 = child_node_2.AsInnerNode();
//
//            // Children fit into a single node?
//            auto combined = child_1->GetSize() + child_2->GetSize();
//            if (combined <= child_1->GetCapacity()) {
//                child_1->Push(child_2->TruncateChildren());
//                remove_right = true;
//            } else {
//                child_1->EquiDistribute(*child_2);
//            }
//        }
//    }
    /// Equi-distributes the children between the two child arrays, preserving ordering
    void Balance(size_t idx1, size_t idx2);
    /// If the children are leaf nodes, compacts them to take up the fewest nodes
    void CompactLeafs();
    /// Removes the item at the given index from the the array.
    /// Decreases length by one.  Preserves ordering of the other items.
    std::pair<TextInfo, NodePtr> Remove();

    using Child = std::pair<size_t, TextInfo>;

    /// Helper to find a child that contains a byte index
    static bool ChildContainsByte(size_t byte_idx, TextInfo prev, TextInfo next) { return next.text_bytes > byte_idx; }
    /// Helper to find a child that contains a character index
    static bool ChildContainsCodepoint(size_t char_idx, TextInfo prev, TextInfo next) {
        return next.utf8_codepoints > char_idx;
    }
    /// Helper to find a child that contains a line break index
    static bool ChildContainsLineBreak(size_t line_break_idx, TextInfo prev, TextInfo next) {
        return next.line_breaks > line_break_idx;
    }

    /// Find the first child where a predicate returns true or the last child if none qualify
    template <typename Predicate> Child Find(size_t arg, Predicate predicate) {
        auto child_stats = GetChildStats();
        TextInfo next;
        for (size_t child_idx = 0; (child_idx + 1) < child_stats.size(); ++child_idx) {
            TextInfo prev = next;
            next += child_stats[child_idx];
            if (predicate(arg, prev, next)) {
                return {child_idx, prev};
            }
        }
        return {child_stats.size() - 1, next};
    }

    /// Find the child that contains a byte index
    std::pair<size_t, size_t> FindByte(size_t byte_idx) {
        auto [child, stats] = Find(byte_idx, ChildContainsByte);
        return {child, stats.text_bytes};
    }
    /// Find the child that contains a character
    std::pair<size_t, size_t> FindCodepoint(size_t char_idx) {
        auto [child, stats] = Find(char_idx, ChildContainsCodepoint);
        return {child, stats.utf8_codepoints};
    }
    /// Find the child that contains a line break
    std::pair<size_t, size_t> FindLineBreak(size_t line_break_idx) {
        auto [child, stats] = Find(line_break_idx, ChildContainsLineBreak);
        return {child, stats.line_breaks};
    }

    /// Find a range where two predicate return true
    template <typename Predicate> std::pair<Child, Child> FindRange(size_t arg0, size_t arg1, Predicate predicate) {
        auto child_stats = GetChildStats();
        std::pair<size_t, TextInfo> begin, end;
        TextInfo next;
        size_t child_idx = 0;
        for (; child_idx < child_stats.size(); ++child_idx) {
            TextInfo prev = next;
            next += child_stats[child_idx];
            if (predicate(arg0, prev, next)) {
                begin = {child_idx, prev};
                end = begin;
                if (predicate(arg1, prev, next)) {
                    return {begin, end};
                }
                break;
            }
        }
        for (; child_idx < child_stats.size(); ++child_idx) {
            TextInfo prev = next;
            next += child_stats[child_idx];
            if (predicate(arg1, prev, next)) {
                end = {child_idx, prev};
                break;
            }
        }
        return {begin, end};
    }
};

struct Rope {
    static constexpr size_t ComputeFragmentationThreshold(size_t page_size) { return page_size / 6; }
    static constexpr size_t ComputeBulkloadThreshold(size_t page_size) { return page_size * 6; }

    /// The page size
    const size_t page_size;
    /// The root page
    NodePtr root_node;
    /// The root page
    TextInfo root_info;
    /// The first leaf
    LeafNode* first_leaf;

    /// Constructor
    Rope(size_t page_size, NodePtr root_node, TextInfo root_info, LeafNode* first_leaf)
        : page_size(page_size), root_node(root_node), root_info(root_info), first_leaf(first_leaf) {}
    /// Constructor
    Rope(size_t page_size, std::string_view text = {})
        : page_size(page_size) {
        PagePtr first_page{page_size};
        first_leaf = new (first_page.Get()) LeafNode(page_size);
        root_node = {first_leaf};
        root_info = {};
        first_page.Release();
    }
    /// Destructor
    ~Rope() {
        NodePtr level = root_node;
        while (true) {
            if (level.IsLeafNode()) {
                LeafNode* iter = level.AsLeafNode();
                while (iter) {
                    auto next = iter->next_node;
                    delete[] reinterpret_cast<std::byte*>(iter);
                    iter = next;
                }
                break;
            }
            InnerNode* iter = level.AsInnerNode();
            assert(iter->GetSize() > 0);
            level = {iter->GetChildNodes()[0]};
            while (iter) {
                auto next = iter->next_node;
                delete[] reinterpret_cast<std::byte*>(iter);
                iter = next;
            }
        }
        root_node = {};
    }
    /// Copy constructor
    Rope(Rope& other) = delete;
    /// Move constructor
    Rope(Rope&& other) : page_size(other.page_size), root_node(other.root_node), root_info(other.root_info), first_leaf(other.first_leaf) {
        other.root_node = {};
        other.root_info = TextInfo{};
        other.first_leaf = nullptr;
    };
    /// Copy assignment
    Rope& operator=(Rope& other) = delete;

    /// Get the root text info
    auto& GetInfo() { return root_info; }
    /// Copy the rope to a std::string
    std::string ToString() {
        std::string buffer;
        buffer.reserve(root_info.text_bytes);
        for (auto iter = first_leaf; iter; iter = iter->next_node) {
            buffer += iter->GetStringView();
        }
        return buffer;
    }

    /// Split off a rope
    Rope SplitOff(size_t char_idx) {
        // Remember information about an inner node that we traversed.
        struct VisitedInnerNode {
            TextInfo* node_info;
            InnerNode* node;
            size_t child_idx;
        };

        // Locate leaf node and remember traversed inner nodes
        SmallVector<VisitedInnerNode, 8> inner_path;
        auto next_node = root_node;
        auto next_stats = &root_info;
        while (!next_node.IsLeafNode()) {
            // Find child with codepoint
            InnerNode* next_as_inner = next_node.AsInnerNode();
            auto [child_idx, child_prefix_chars] = next_as_inner->FindCodepoint(char_idx);
            inner_path.push_back(
                VisitedInnerNode{.node_info = next_stats, .node = next_as_inner, .child_idx = child_idx});

            // Continue with child
            next_node = next_as_inner->GetChildNodes()[child_idx];
            next_stats = &next_as_inner->GetChildStats()[child_idx];
            char_idx -= child_prefix_chars;
            assert(!next_node.IsNull());
        }

        // Edit when reached leaf
        LeafNode* leaf_node = next_node.AsLeafNode();

        // Create leaf node
        PagePtr new_leaf_page{page_size};
        auto new_leaf = new (new_leaf_page.Get()) LeafNode(page_size);
        leaf_node->SplitCharsOff(char_idx, *new_leaf);
        leaf_node->next_node = nullptr;
        new_leaf->previous_node = nullptr;
        TextInfo child_stats{new_leaf->GetData()};
        NodePtr child_node{new_leaf};

        // Create new inner nodes
        std::vector<PagePtr> new_inners;
        new_inners.reserve(inner_path.getSize());
        for (auto iter = inner_path.rbegin(); iter != inner_path.rend(); ++iter) {
            new_inners.emplace_back(page_size);
            auto right = new (new_inners.back().Get()) InnerNode(page_size);
            auto* left = iter->node;
            left->SplitOff(iter->child_idx, *right);
            ++left->child_count;
            left->next_node = nullptr;
            right->previous_node = nullptr;
            right->GetChildStatsBuffer()[0] = child_stats;
            right->GetChildNodesBuffer()[0] = child_node;
            child_stats = right->AggregateTextInfo();
            child_node = {right};
        }

        // Release inner nodes
        for (auto& inner : new_inners) {
            inner.Release();
        }
        // Create new root
        return Rope{page_size, child_node, child_stats, new_leaf_page.Release<LeafNode>()};
    }

    /// Append a rope to this rope
    void Append(Rope other) {}

    /// Insert a small text at index.
    /// The text to be inserted must not exceed the size of leaf page.
    /// That guarantees that we need at most one split.
    void InsertBounded(size_t char_idx, std::span<const std::byte> text_bytes) {
        assert(text_bytes.size() <= LeafNode::Capacity(page_size));
        TextInfo insert_info{text_bytes};

        // Remember information about an inner node that we traversed.
        struct VisitedInnerNode {
            TextInfo* node_info;
            InnerNode* node;
            size_t child_idx;
        };

        // Locate leaf node and remember traversed inner nodes
        SmallVector<VisitedInnerNode, 8> inner_path;
        auto next_node = root_node;
        auto next_stats = &root_info;
        while (!next_node.IsLeafNode()) {
            // Find child with codepoint
            InnerNode* next_as_inner = next_node.AsInnerNode();
            auto [child_idx, child_prefix_chars] = next_as_inner->FindCodepoint(char_idx);
            inner_path.push_back(
                VisitedInnerNode{.node_info = next_stats, .node = next_as_inner, .child_idx = child_idx});

            // Continue with child
            next_node = next_as_inner->GetChildNodes()[child_idx];
            next_stats = &next_as_inner->GetChildStats()[child_idx];
            char_idx -= child_prefix_chars;
            assert(!next_node.IsNull());
        }

        // Edit when reached leaf
        LeafNode* leaf_node = next_node.AsLeafNode();
        auto leaf_info = next_stats;
        auto insert_at = utf8::codepointToByteIdx(leaf_node->GetData(), char_idx);
        assert(char_idx <= leaf_info->utf8_codepoints);

        // Fits in leaf?
        if ((leaf_node->GetSize() + text_bytes.size()) <= leaf_node->GetCapacity()) {
            assert(insert_at <= leaf_node->GetSize());
            leaf_node->InsertBytes(insert_at, text_bytes);
            // Update the text statistics in the parent
            *leaf_info += insert_info;
            // Propagate the inserted text info to all parents
            for (auto iter = inner_path.rbegin(); iter != inner_path.rend(); ++iter) {
                *iter->node_info += insert_info;
            }
            return;
        }

        // Text does not fit on leaf, split the leaf
        PagePtr new_leaf_page{page_size};
        auto new_leaf = new (new_leaf_page.Get()) LeafNode(page_size);
        leaf_node->InsertBytesAndSplit(insert_at, text_bytes, *new_leaf);

        // Collect split node
        TextInfo split_info{new_leaf->GetData()};
        NodePtr split_node{new_leaf_page.Release<LeafNode>()};
        *leaf_info = *leaf_info + insert_info - split_info;

        // Propagate split upwards
        for (auto iter = inner_path.rbegin(); iter != inner_path.rend(); ++iter) {
            auto prev_visit = *iter;

            // Is there enough space in the inner node? - Then we're done splitting!
            if (!prev_visit.node->IsFull()) {
                prev_visit.node->Insert(prev_visit.child_idx + 1, split_node, split_info);
                *prev_visit.node_info += insert_info;

                // Propagate the inserted text info to all parents
                for (++iter; iter != inner_path.rend(); ++iter) {
                    *iter->node_info += insert_info;
                }
                return;
            }

            // Otherwise it's a split of the inner node!
            PagePtr new_inner_page{page_size};
            auto new_inner = new (new_inner_page.Get()) InnerNode(page_size);
            prev_visit.node->InsertAndSplit(prev_visit.child_idx + 1, split_node, split_info, *new_inner);
            split_info = new_inner->AggregateTextInfo();
            split_node = NodePtr{new_inner_page.Release<InnerNode>()};
            *prev_visit.node_info = *prev_visit.node_info + insert_info - split_info;
        }

        // Is not null, then we have to split the root!
        if (!split_node.IsNull()) {
            PagePtr new_root_page{page_size};
            auto new_root = new (new_root_page.Get()) InnerNode(page_size);
            new_root->Push(root_node, root_info);
            new_root->Push(split_node, split_info);
            root_info = new_root->AggregateTextInfo();
            root_node = new_root_page.Release<InnerNode>();
        }
    }

    /// Insert at index
    void Insert(size_t char_idx, std::string_view text) {
        // Make sure the char idx is not out of bounds
        char_idx = std::min(char_idx, root_info.utf8_codepoints);
        std::span<const std::byte> text_buffer{reinterpret_cast<const std::byte*>(text.data()), text.size()};

        // // Bulk-load the text into a new rope and merge it?
        // if (text.size() >= BULKLOAD_THRESHOLD) {
        //     auto right = SplitOff(char_idx);
        //     Append(text.size());
        //     Append(right);
        //     return;
        // }

        // Split the input text in chunks and insert it into the rope
        while (!text.empty()) {
            auto split_idx = utf8::findCodepoint(text_buffer, std::min(LeafNode::Capacity(page_size) - 4, text.size()), false);
            auto tail = text_buffer.subspan(split_idx);
            text = text.substr(0, split_idx);
            InsertBounded(char_idx, tail);
        }
    }

    /// Create a rope from a string
    static Rope FromString(size_t page_size, std::string_view text) {
        // Create leaf nodes
        std::vector<PagePtr> leafs;
        auto leaf_capacity = LeafNode::Capacity(page_size);
        leafs.reserve((text.size() + leaf_capacity - 1) / leaf_capacity);
        LeafNode* prev_leaf = nullptr;
        while (!text.empty()) {
            leafs.push_back(LeafNode::FromString(page_size, text));
            auto new_leaf = leafs.back().Cast<LeafNode>();

            // Link leaf node
            if (prev_leaf != nullptr) {
                prev_leaf->next_node = new_leaf;
                new_leaf->previous_node = prev_leaf;
            }
            prev_leaf = new_leaf;
        }

        // Is a leaf single leaf?
        if (leafs.size() == 1) {
            auto leaf_node = leafs.back().Cast<LeafNode>();
            auto root_node = NodePtr{leaf_node};
            auto root_info = TextInfo{leaf_node->GetData()};
            Rope rope{page_size, root_node, root_info, leaf_node};
            leafs.back().Release();
            return rope;
        }

        // Create inner nodes from leafs
        std::vector<PagePtr> inners;
        InnerNode* prev_inner = nullptr;
        for (size_t begin = 0; begin < leafs.size();) {
            inners.emplace_back(page_size);
            auto next = new (inners.back().Get()) InnerNode(page_size);

            // Store child nodes
            auto n = std::min(leafs.size() - begin, InnerNode::Capacity(page_size));
            for (auto i = 0; i < n; ++i) {
                auto leaf = leafs[begin + i].Cast<LeafNode>();
                next->GetChildNodesBuffer()[i] = NodePtr{leaf};
                next->GetChildStatsBuffer()[i] = TextInfo{leaf->GetData()};
            }
            begin += n;
            next->child_count = n;

            // Link inner node
            if (prev_inner != nullptr) {
                prev_inner->next_node = next;
                next->previous_node = prev_inner;
            }
            prev_inner = next;
        }

        // Create inner nodes from inner nodes
        auto level_begin = 0;
        auto level_end = inners.size();
        while ((level_end - level_begin) > 1) {
            prev_inner = nullptr;

            // Iterate of inner nodes of previous level
            for (size_t begin = level_begin; begin < level_end;) {
                inners.emplace_back(page_size);
                auto next = new (inners.back().Get()) InnerNode(page_size);

                // Store children
                auto n = std::min(level_end - begin, InnerNode::Capacity(page_size));
                for (auto i = 0; i < n; ++i) {
                    auto inner = inners[begin + i].Cast<InnerNode>();
                    next->GetChildNodesBuffer()[i] = NodePtr{inner};
                    next->GetChildStatsBuffer()[i] = inner->AggregateTextInfo();
                }
                begin += n;
                next->child_count = n;

                // Link inner node
                if (prev_inner != nullptr) {
                    prev_inner->next_node = next;
                    next->previous_node = prev_inner;
                }
                prev_inner = next;
            }

            // Update level
            level_begin = level_end;
            level_end = inners.size();
        }
        assert((level_end - level_begin) == 1);

        // Store root
        auto root_inner_node = inners[level_begin].Cast<InnerNode>();
        auto root_node = NodePtr{root_inner_node};
        auto root_info = root_inner_node->AggregateTextInfo();
        auto first_leaf = leafs.front().Cast<LeafNode>();
        Rope rope{page_size, root_node, root_info, first_leaf};

        for (auto& leaf : leafs) {
            leaf.Release();
        }
        for (auto& inner : inners) {
            inner.Release();
        }
        return rope;
    }
};

}  // namespace flatsql::rope
