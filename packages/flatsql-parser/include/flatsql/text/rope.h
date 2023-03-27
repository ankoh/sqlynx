#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
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

template <size_t PageSize> struct Rope;
template <size_t PageSize> struct LeafNode;
template <size_t PageSize> struct InnerNode;

constexpr size_t DEFAULT_PAGE_SIZE = 1024;

template <size_t PageSize = DEFAULT_PAGE_SIZE> struct NodePtr {
   protected:
    /// The raw pointer
    uintptr_t raw_ptr;

   public:
    /// Create node ptr from leaf node
    NodePtr() : raw_ptr(0) {}
    /// Create node ptr from leaf node
    NodePtr(LeafNode<PageSize>* ptr) : raw_ptr(reinterpret_cast<uintptr_t>(ptr)) {
        assert((reinterpret_cast<uintptr_t>(ptr) & 0b1) == 0);
    }
    /// Create node ptr from inner node
    NodePtr(InnerNode<PageSize>* ptr) : raw_ptr(reinterpret_cast<uintptr_t>(ptr) | 0b1) {
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
    LeafNode<PageSize>* AsLeafNode() { return reinterpret_cast<LeafNode<PageSize>*>((raw_ptr >> 1) << 1); }
    /// Get as inner node
    InnerNode<PageSize>* AsInnerNode() { return reinterpret_cast<InnerNode<PageSize>*>((raw_ptr >> 1) << 1); }
};

template <size_t PageSize = DEFAULT_PAGE_SIZE> struct LeafNode {
    friend struct Rope<PageSize>;
    static constexpr size_t CAPACITY = PageSize - sizeof(uint16_t) - 2 * sizeof(void*);

   protected:
    /// The previous leaf (if any)
    LeafNode<PageSize>* previous_node = nullptr;
    /// The next leaf (if any)
    LeafNode<PageSize>* next_node = nullptr;
    /// The buffer size
    uint16_t buffer_size = 0;
    /// The string buffer
    std::array<std::byte, CAPACITY> buffer;

   public:
    /// Constructor
    LeafNode(std::string_view data = {}) : buffer_size(data.size()), buffer() {
        std::memcpy(buffer.data(), data.data(), data.size());
        for (auto i = 0; i < buffer.size(); ++i) {
            buffer[i] = std::byte{0xFF};
        }
    }
    /// Get the size of the buffer
    auto GetSize() noexcept { return buffer_size; }
    /// Get the capacity of the buffer
    auto GetCapacity() noexcept { return CAPACITY; }
    /// Get the data
    auto GetData() noexcept { return std::span<std::byte>{buffer.data(), buffer_size}; }
    /// Get buffer content as string
    auto GetStringView() noexcept { return std::string_view{reinterpret_cast<char*>(buffer.data()), GetSize()}; }

    /// Is valid?
    auto IsValid() noexcept { return utf8::isCodepointBoundary(GetData(), 0); }
    /// Is the node empty?
    auto IsEmpty() noexcept { return GetSize() == 0; }
    /// Reset the node
    auto Reset() noexcept { buffer_size = 0; }

    /// Link a neighbor
    void LinkNeighbors(LeafNode<PageSize>& other) {
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
        assert(data.size() <= (GetCapacity() - ofs));
        assert(utf8::isCodepointBoundary(GetData(), ofs));

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

        std::span<std::byte> tail{&buffer[byte_idx], GetSize() - byte_idx};
        buffer_size = byte_idx;
        return tail;
    }
    /// Splits bytes at index
    void SplitBytesOff(size_t byte_idx, LeafNode& dst) noexcept {
        assert(dst.IsEmpty());
        assert(byte_idx <= GetSize());
        assert(utf8::isCodepointBoundary(GetData(), byte_idx));

        dst.InsertBytes(0, TruncateBytes(byte_idx));
    }
    /// Split chars at index
    void SplitCharsOff(size_t char_idx, LeafNode& dst) noexcept {
        auto byte_idx = utf8::codepointToByteIdx(GetData(), char_idx);
        SplitBytesOff(byte_idx, dst);
    }
    /// Inserts `string` at `byte_idx` and splits the resulting string in half.
    /// Only splits on code point boundaries, so if the whole string is a single code point the right node will be
    /// empty.
    void InsertBytesAndSplit(size_t byte_idx, std::span<const std::byte> str, LeafNode& right) {
        assert(right.IsEmpty());
        assert(utf8::isCodepointBoundary(GetData(), byte_idx));

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

    /// Create a leaf node from a string
    static std::unique_ptr<LeafNode<PageSize>> FromString(std::string_view& text) {
        auto leaf = std::make_unique<LeafNode<PageSize>>();
        auto max_bytes = std::min(LeafNode<PageSize>::CAPACITY, text.size());
        std::span<const std::byte> bytes{reinterpret_cast<const std::byte*>(text.data()), max_bytes};
        for (auto iter = bytes.rbegin(); iter != bytes.rend(); ++iter) {
            if (utf8::isCodepointBoundary(*iter)) {
                bytes = bytes.subspan(0, bytes.rend() - iter);
                break;
            }
        }
        leaf->buffer_size = bytes.size();
        std::memcpy(leaf->buffer.data(), text.data(), leaf->buffer_size);
        text = text.substr(bytes.size());
        return leaf;
    }
};

template <size_t PageSize = DEFAULT_PAGE_SIZE> struct InnerNode {
    friend struct Rope<PageSize>;
    static constexpr size_t CAPACITY =
        (PageSize - sizeof(uint8_t) - 2 * sizeof(void*)) / (sizeof(TextInfo) + sizeof(NodePtr<PageSize>));
    static_assert(CAPACITY >= 2, "Inner mode must have space for at least two children");

   protected:
    /// The previous leaf (if any)
    InnerNode<PageSize>* previous_node = nullptr;
    /// The next leaf (if any)
    InnerNode<PageSize>* next_node = nullptr;
    /// The child statistics
    std::array<TextInfo, CAPACITY> child_stats;
    /// The child nodes
    std::array<NodePtr<PageSize>, CAPACITY> child_nodes;
    /// The children count
    uint8_t child_count = 0;

   public:
    /// Constructor
    InnerNode() : child_stats(), child_nodes() {}

    /// Get the size of the node
    size_t GetSize() noexcept { return child_count; }
    /// Get the capacity of the node
    size_t GetCapacity() noexcept { return CAPACITY; }
    /// Get the statistics
    auto GetChildStats() noexcept { return std::span{child_stats.data(), GetSize()}; }
    /// Get child nodes
    auto GetChildNodes() noexcept { return std::span{child_nodes.data(), GetSize()}; }
    /// Is the node empty?
    auto IsEmpty() noexcept { return GetSize() == 0; }
    /// Is the node full?
    auto IsFull() noexcept { return GetSize() >= GetCapacity(); }

    /// Link a neighbor
    void LinkNeighbors(InnerNode<PageSize>& other) {
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
    void Push(NodePtr<PageSize> child, TextInfo stats) {
        assert(!IsFull());
        child_stats[child_count] = stats;
        child_nodes[child_count] = child;
        ++child_count;
    }
    /// Pushes items into the array
    void Push(std::span<const NodePtr<PageSize>> nodes, std::span<const TextInfo> stats) {
        assert(nodes.size() == stats.size()) assert((GetCapacity() - GetSize()) <= nodes.size());
        std::memcpy(child_nodes.data() + GetSize(), nodes.data(), nodes.size() * sizeof(NodePtr<PageSize>));
        std::memcpy(child_stats.data() + GetSize(), stats.data(), nodes.size() * sizeof(TextInfo));
        child_count += nodes.size();
    }
    /// Pops an item from the end of the array
    std::pair<NodePtr<PageSize>, TextInfo> Pop() {
        assert(!IsEmpty());
        --child_count;
        return {child_nodes[child_count], child_stats[child_count]};
    }
    /// Inserts an item at a position
    void Insert(size_t idx, NodePtr<PageSize> child, TextInfo stats) {
        assert(idx <= GetSize());
        assert(GetSize() < GetCapacity());
        auto tail = GetSize() - idx;
        std::memmove(&child_nodes[idx + 1], &child_nodes[idx], tail * sizeof(NodePtr<PageSize>));
        std::memmove(&child_stats[idx + 1], &child_stats[idx], tail * sizeof(TextInfo));
        child_nodes[idx] = child;
        child_stats[idx] = stats;
        ++child_count;
    }
    /// Remove an element at a position
    std::pair<NodePtr<PageSize>, TextInfo> Remove(size_t idx) {
        assert(GetSize() > 0);
        assert(idx < GetSize());
        if ((idx + 1) < GetSize()) {
            auto tail = GetSize() - (idx + 1);
            std::memmove(&child_nodes[idx], &child_nodes[idx + 1], tail * sizeof(NodePtr<PageSize>));
            std::memmove(&child_stats[idx], &child_stats[idx + 1], tail * sizeof(TextInfo));
        }
        --child_count;
    }
    /// Truncate children from a position
    std::pair<std::span<const NodePtr<PageSize>>, std::span<const TextInfo>> Truncate(size_t idx) noexcept {
        assert(idx <= GetSize());
        std::span<const NodePtr<PageSize>> tail_nodes{&child_nodes[idx], GetSize() - idx};
        std::span<const TextInfo> tail_stats{&child_stats[idx], GetSize() - idx};
        child_count = idx;
        return {tail_nodes, tail_stats};
    }
    /// Splits node at index
    void SplitOff(size_t child_idx, InnerNode& dst) {
        assert(dst.IsEmpty());
        assert(child_idx <= GetSize());

        dst.child_count = GetSize() - child_idx;
        std::memcpy(dst.child_nodes.data(), &child_nodes[child_idx], dst.child_count * sizeof(NodePtr<PageSize>));
        std::memcpy(dst.child_stats.data(), &child_stats[child_idx], dst.child_count * sizeof(TextInfo));
        child_count = child_idx;

        LinkNeighbors(dst);
    }
    /// Pushes an element onto the end of the array, and then splits it in half
    void PushAndSplit(NodePtr<PageSize> child, TextInfo stats, InnerNode& dst) {
        auto r_count = (GetSize() + 1) / 2;
        auto l_count = (GetSize() + 1) - r_count;
        SplitOff(l_count, dst);
        dst.Push(child, stats);
    }
    /// Inserts an element into a the array, and then splits it in half
    void InsertAndSplit(size_t idx, NodePtr<PageSize> child, TextInfo stats, InnerNode& other) {
        assert(GetSize() > 0);
        assert(idx <= GetSize());
        std::pair<NodePtr<PageSize>, TextInfo> extra{child, stats};
        if (idx < GetSize()) {
            extra = Pop();
            Insert(idx, child, stats);
        }
        PushAndSplit(std::get<0>(extra), std::get<1>(extra), other);
    }
    /// Distribute children equally between nodes
    void Balance(InnerNode& right) {
        if (child_count < right.child_count) {
            // Right got more children than left, append surplus to left
            auto move = (right.child_count - child_count) / 2;
            std::memcpy(child_nodes.data() + GetSize(), right.child_nodes.data(), move * sizeof(NodePtr<PageSize>));
            std::memcpy(child_stats.data() + GetSize(), right.child_stats.data(), move * sizeof(TextInfo));
            std::memmove(right.child_nodes.data(), right.child_nodes.data() + move,
                         (right.GetSize() - move) * sizeof(NodePtr<PageSize>));
            std::memmove(right.child_stats.data(), right.child_stats.data() + move,
                         (right.GetSize() - move) * sizeof(TextInfo));
            right.child_count -= move;
            child_count += move;

        } else if (child_count > right.child_count) {
            // Left got more children than right, prepend surplus to right
            auto move = (child_count - right.child_count) / 2;
            auto move_from = GetSize() - move - 1;
            std::memmove(right.child_nodes.data() + move, right.child_nodes.data(), move * sizeof(NodePtr<PageSize>));
            std::memmove(right.child_stats.data() + move, right.child_stats.data(), move * sizeof(TextInfo));
            std::memcpy(right.child_nodes.data(), child_nodes.data() + move_from, move * sizeof(NodePtr<PageSize>));
            std::memcpy(right.child_stats.data(), child_stats.data() + move_from, move * sizeof(TextInfo));
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
            LeafNode<PageSize>* child_1 = child_node_1.AsLeafNode();
            LeafNode<PageSize>* child_2 = child_node_2.AsLeafNode();

            // Text fits into a single node?
            auto combined = child_1->GetSize() + child_2->GetSize();
            if (combined <= child_1->GetCapacity()) {
                child_1->PushBytes(child_2->TruncateBytes());
                assert(child_1->IsValid());
                remove_right = true;
            } else {
                child_1->BalanceBytes(*child_2);
                assert(child_1->IsValid());
                assert(child_2->IsValid());
            }
        } else {
            assert(child_node_1.IsInnerNode());
            assert(child_node_2.IsInnerNode());
            InnerNode<PageSize>* child_1 = child_node_1.AsInnerNode();
            InnerNode<PageSize>* child_2 = child_node_2.AsInnerNode();

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
    void Balance(size_t idx1, size_t idx2);
    /// If the children are leaf nodes, compacts them to take up the fewest nodes
    void CompactLeafs();
    /// Removes the item at the given index from the the array.
    /// Decreases length by one.  Preserves ordering of the other items.
    std::pair<TextInfo, NodePtr<PageSize>> Remove();

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

template <size_t PageSize = DEFAULT_PAGE_SIZE> struct Rope {
    const static size_t FRAGMENTATION_THRESHOLD = PageSize / 6;
    const static size_t BULKLOAD_THRESHOLD = PageSize * 6;

    /// The root page
    NodePtr<PageSize> root_node;
    /// The root page
    TextInfo root_info;
    /// The first leaf
    LeafNode<PageSize>* first_leaf;

    /// Constructor
    Rope(std::string_view text = {}) {
        first_leaf = new LeafNode<PageSize>();
        root_node = {first_leaf};
    }
    /// Destructor
    ~Rope() {
        NodePtr<PageSize> level = root_node;
        while (true) {
            if (level.IsLeafNode()) {
                LeafNode<PageSize>* iter = level.AsLeafNode();
                while (iter) {
                    auto next = iter->next_node;
                    delete iter;
                    iter = next;
                }
                break;
            }
            InnerNode<PageSize>* iter = level.AsInnerNode();
            assert(iter->GetSize() > 0);
            level = {iter->GetChildNodes()[0]};
            while (iter) {
                auto next = iter->next_node;
                delete iter;
                iter = next;
            }
        }
        root_node = {};
    }
    /// Copy constructor
    Rope(Rope& other) = delete;
    /// Move constructor
    Rope(Rope&& other)
        : root_node(other.root_node), root_info(other.root_info), first_leaf(other.first_leaf) {
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
    Rope SplitOff(size_t char_idx) {}
    /// Append a rope to this rope
    void Append(Rope other) {}

    /// Insert a small text at index.
    /// The text to be inserted must not exceed the size of leaf page.
    /// That guarantees that we need at most one split.
    void InsertBounded(size_t char_idx, std::span<const std::byte> text_bytes) {
        assert(text_bytes.size() <= LeafNode<PageSize>::CAPACITY);
        TextInfo insert_info{text_bytes};

        // Remember information about an inner node that we traversed.
        struct VisitedInnerNode {
            /// The text info of the parent
            TextInfo* parent_info;
            /// The parent node pointer
            InnerNode<PageSize>* parent_node;
            /// The child idx within the node
            size_t child_idx;
        };

        // Locate leaf node and remember traversed inner nodes
        SmallVector<VisitedInnerNode, 8> inner_node_path;
        auto next_node = root_node;
        auto next_info = &root_info;
        while (!next_node.IsLeafNode()) {
            // Find child with codepoint
            InnerNode<PageSize>* next_as_inner = next_node.AsInnerNode();
            auto [child_idx, child_prefix_chars] = next_as_inner->FindCodepoint(char_idx);
            inner_node_path.push_back(
                VisitedInnerNode{.parent_info = next_info, .parent_node = next_as_inner, .child_idx = child_idx});

            // Continue with child
            next_node = next_as_inner->GetChildNodes()[child_idx];
            next_info = &next_as_inner->GetChildStats()[child_idx];
            char_idx -= child_prefix_chars;
            assert(!next_node.IsNull());
        }

        // Edit when reached leaf
        LeafNode<PageSize>* leaf_node = next_node.AsLeafNode();
        auto leaf_info = next_info;
        auto insert_at = utf8::codepointToByteIdx(leaf_node->GetData(), char_idx);
        assert(char_idx <= leaf_info->utf8_codepoints);

        // Fits in leaf?
        if ((leaf_node->GetSize() + text_bytes.size()) <= leaf_node->GetCapacity()) {
            assert(insert_at <= leaf_node->GetSize());
            leaf_node->InsertBytes(insert_at, text_bytes);
            // Update the text statistics in the parent
            *leaf_info += insert_info;
            // Propagate the inserted text info to all parents
            for (auto iter = inner_node_path.rbegin(); iter != inner_node_path.rend(); ++iter) {
                *iter->parent_info += insert_info;
            }
            return;
        }

        // Text does not fit on leaf, split the leaf
        auto new_leaf = std::make_unique<LeafNode<PageSize>>();
        leaf_node->InsertBytesAndSplit(insert_at, text_bytes, *new_leaf);

        // Collect split node
        TextInfo split_info{new_leaf->GetData()};
        NodePtr<PageSize> split_node{new_leaf.release()};
        *leaf_info = *leaf_info + insert_info - split_info;

        // Propagate split upwards
        for (auto iter = inner_node_path.rbegin(); iter != inner_node_path.rend(); ++iter) {
            auto prev_visit = *iter;

            // Is there enough space in the inner node? - Then we're done splitting!
            if (!prev_visit.parent_node->IsFull()) {
                prev_visit.parent_node->Insert(prev_visit.child_idx + 1, split_node, split_info);
                *prev_visit.parent_info += insert_info;

                // Propagate the inserted text info to all parents
                for (++iter; iter != inner_node_path.rend(); ++iter) {
                    *iter->parent_info += insert_info;
                }
                return;
            }

            // Otherwise it's a split of the inner node!
            auto new_inner = std::make_unique<InnerNode<PageSize>>();
            prev_visit.parent_node->InsertAndSplit(prev_visit.child_idx + 1, split_node, split_info, *new_inner);
            split_info = new_inner->AggregateTextInfo();
            split_node = NodePtr<PageSize>{new_inner.release()};
            *prev_visit.parent_info = *prev_visit.parent_info + insert_info - split_info;
        }

        // Is not null, then we have to split the root!
        if (!split_node.IsNull()) {
            auto new_root = std::make_unique<InnerNode<PageSize>>();
            new_root->Push(root_node, root_info);
            new_root->Push(split_node, split_info);
            root_info = new_root->AggregateTextInfo();
            root_node = new_root.release();
        }
    }

    /// Insert at index
    void Insert(size_t char_idx, std::string_view text) {
        // Make sure the char idx is not out of bounds
        char_idx = std::min(char_idx, root_info.utf8_codepoints);

        // // Bulk-load the text into a new rope and merge it?
        // if (text.size() >= BULKLOAD_THRESHOLD) {
        //     auto right = SplitOff(char_idx);
        //     Append(text.size());
        //     Append(right);
        //     return;
        // }

        // Split the input text in chunks and insert it into the rope
        while (!text.empty()) {
            auto split_idx = utf8::findCodepoint(text, std::min(LeafNode<PageSize>::CAPACITY - 4, text.size()), false);
            auto tail = text.substr(split_idx);
            text = text.substr(0, split_idx);
            InsertBounded(char_idx, tail);
        }
    }

    /// Create a rope from a string
    static Rope<PageSize> FromString(std::string_view text) {
        // Create leaf nodes
        std::vector<std::unique_ptr<LeafNode<PageSize>>> leafs;
        leafs.reserve((text.size() + LeafNode<PageSize>::CAPACITY - 1) / LeafNode<PageSize>::CAPACITY);
        LeafNode<PageSize>* prev_leaf = nullptr;
        while (!text.empty()) {
            leafs.push_back(LeafNode<PageSize>::FromString(text));
            auto new_leaf = leafs.back().get();

            // Link leaf node
            if (prev_leaf != nullptr) {
                prev_leaf->next_node = new_leaf;
                new_leaf->previous_node = prev_leaf;
            }
            prev_leaf = new_leaf;
        }

        // Is a leaf single leaf?
        if (leafs.size() == 1) {
            Rope<PageSize> rope;
            rope.root_node = NodePtr<PageSize>{leafs.back().get()};
            rope.root_info = TextInfo{leafs.back()->GetData()};
            rope.first_leaf = leafs.back().get();
            leafs.back().release();
            return rope;
        }

        // Create inner nodes from leafs
        std::vector<std::unique_ptr<InnerNode<PageSize>>> inners;
        InnerNode<PageSize>* prev_inner = nullptr;
        for (size_t begin = 0; begin < leafs.size();) {
            inners.push_back(std::make_unique<InnerNode<PageSize>>());
            auto& next = inners.back();

            // Store child nodes
            auto n = std::min(leafs.size() - begin, InnerNode<PageSize>::CAPACITY);
            for (auto i = 0; i < n; ++i) {
                next->child_nodes[i] = NodePtr<PageSize>{leafs[begin + i].get()};
                next->child_stats[i] = TextInfo{leafs[begin + i]->GetData()};
            }
            begin += n;
            next->child_count = n;

            // Link child node
            if (prev_inner != nullptr) {
                prev_inner->next_node = next.get();
                next->previous_node = prev_inner;
            }
            prev_inner = next.get();
        }

        // Create inner nodes from inner nodes
        auto level_begin = 0;
        auto level_end = inners.size();
        while ((level_end - level_begin) > 1) {
            InnerNode<PageSize>* prev_inner = nullptr;

            // Iterate of inner nodes of previous level
            for (size_t begin = level_begin; begin < level_end;) {
                inners.push_back(std::make_unique<InnerNode<PageSize>>());
                auto& next = inners.back();

                // Store children
                auto n = std::min(level_end - begin, InnerNode<PageSize>::CAPACITY);
                for (auto i = 0; i < n; ++i) {
                    next->child_nodes[i] = NodePtr<PageSize>{inners[begin + i].get()};
                    next->child_stats[i] = inners[begin + i]->AggregateTextInfo();
                }
                begin += n;
                next->child_count = n;

                // Link child node
                if (prev_inner != nullptr) {
                    prev_inner->next_node = next.get();
                    next->previous_node = prev_inner;
                }
                prev_inner = next.get();
            }

            // Update level
            level_begin = level_end;
            level_end = inners.size();
        }
        assert((level_end - level_begin) == 1);

        // Store root
        Rope<PageSize> rope;
        rope.root_node = NodePtr<PageSize>{inners[level_begin].get()};
        rope.root_info = inners[level_begin]->AggregateTextInfo();
        rope.first_leaf = leafs.front().get();

        for (auto& leaf : leafs) {
            leaf.release();
        }
        for (auto& inner : inners) {
            inner.release();
        }
        return rope;
    }
};

static_assert(sizeof(LeafNode<DEFAULT_PAGE_SIZE>) <= DEFAULT_PAGE_SIZE, "Leaf node must fit on a page");
static_assert(sizeof(InnerNode<DEFAULT_PAGE_SIZE>) <= DEFAULT_PAGE_SIZE, "Inner node must fit on a page");
static_assert(std::is_trivially_copyable_v<LeafNode<DEFAULT_PAGE_SIZE>>, "Leaf node must be trivially copyable");
static_assert(std::is_trivially_copyable_v<InnerNode<DEFAULT_PAGE_SIZE>>, "Inner node must be trivially copyable");

}  // namespace flatsql::rope
