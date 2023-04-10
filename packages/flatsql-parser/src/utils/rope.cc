#include "flatsql/text/rope.h"

#include <stdexcept>

namespace flatsql::rope {

/// Constructor
TextInfo::TextInfo() {}
/// Constructor
TextInfo::TextInfo(std::span<std::byte> data) : TextInfo(std::span<const std::byte>(data)) {}
/// Constructor
TextInfo::TextInfo(std::span<const std::byte> data) : text_bytes(data.size()) {
    for (auto b : data) {
        line_breaks += (b == std::byte{0x0A});
        utf8_codepoints += utf8::isCodepointBoundary(b);
    }
}
TextInfo TextInfo::operator+(const TextInfo& other) {
    TextInfo result = *this;
    result.text_bytes += other.text_bytes;
    result.utf8_codepoints += other.utf8_codepoints;
    result.line_breaks += other.line_breaks;
    return result;
}
TextInfo& TextInfo::operator+=(const TextInfo& other) {
    *this = *this + other;
    return *this;
}
TextInfo TextInfo::operator-(const TextInfo& other) {
    TextInfo result = *this;
    assert(result.text_bytes >= other.text_bytes);
    assert(result.utf8_codepoints >= other.utf8_codepoints);
    assert(result.line_breaks >= other.line_breaks);
    result.text_bytes -= other.text_bytes;
    result.utf8_codepoints -= other.utf8_codepoints;
    result.line_breaks -= other.line_breaks;
    return result;
}
TextInfo& TextInfo::operator-=(const TextInfo& other) {
    *this = *this - other;
    return *this;
}

static constexpr size_t LeafCapacity(size_t page_size) { return page_size - 2 * sizeof(void*) - 2 * sizeof(uint32_t); }
/// Constructor
LeafNode::LeafNode(uint32_t page_size) : buffer_capacity(LeafCapacity(page_size)) {}
/// Link a neighbor
void LeafNode::LinkNeighbors(LeafNode& other) {
    if (next_node) {
        other.next_node = next_node;
        next_node->previous_node = &other;
    }
    next_node = &other;
    other.previous_node = this;
}
/// Insert raw bytes at an offset
void LeafNode::InsertBytes(size_t ofs, std::span<const std::byte> data) noexcept {
    assert(ofs <= GetSize());
    assert((GetCapacity() - ofs) >= data.size());
    assert(utf8::isCodepointBoundary(GetData(), ofs));

    auto buffer = GetDataBuffer();
    std::memmove(&buffer[ofs + data.size()], &buffer[ofs], buffer_size - ofs);
    std::memcpy(&buffer[ofs], data.data(), data.size());
    buffer_size += data.size();
}
/// Appends a string to the end of the buffer
void LeafNode::PushBytes(std::span<const std::byte> str) noexcept { InsertBytes(GetSize(), str); }
/// Remove text in range
void LeafNode::RemoveByteRange(size_t start_byte_idx, size_t byte_count) noexcept {
    size_t upper_byte_idx = start_byte_idx + byte_count;
    assert(upper_byte_idx <= GetSize());
    assert(utf8::isCodepointBoundary(GetData(), start_byte_idx));
    assert(utf8::isCodepointBoundary(GetData(), upper_byte_idx));

    auto buffer = GetDataBuffer();
    std::memmove(&buffer[start_byte_idx], &buffer[upper_byte_idx], GetSize() - upper_byte_idx);
    buffer_size -= byte_count;
}
/// Remove text in range
TextInfo LeafNode::RemoveCharRange(size_t start_idx, size_t count) noexcept {
    auto byte_start = utf8::codepointToByteIdx(GetData(), start_idx);
    auto byte_end = byte_start + utf8::codepointToByteIdx(GetData().subspan(byte_start), count);
    auto byte_count = byte_end - byte_start;
    TextInfo stats{GetData().subspan(byte_start, byte_count)};
    RemoveByteRange(byte_start, byte_count);
    return stats;
}
/// Removes text after byte_idx
std::span<std::byte> LeafNode::TruncateBytes(size_t byte_idx) noexcept {
    assert(byte_idx <= GetSize());
    assert(utf8::isCodepointBoundary(GetData(), byte_idx));

    auto buffer = GetDataBuffer();
    std::span<std::byte> tail{&buffer[byte_idx], GetSize() - byte_idx};
    buffer_size = byte_idx;
    return tail;
}
/// Removes text after byte_idx
std::span<std::byte> LeafNode::TruncateChars(size_t char_idx) noexcept {
    auto byte_start = utf8::codepointToByteIdx(GetData(), char_idx);
    return TruncateBytes(byte_start);
}
/// Splits bytes at index
void LeafNode::SplitBytesOff(size_t byte_idx, LeafNode& right) noexcept {
    assert(right.IsEmpty());
    assert(byte_idx <= GetSize());
    assert(utf8::isCodepointBoundary(GetData(), byte_idx));

    right.InsertBytes(0, TruncateBytes(byte_idx));
    LinkNeighbors(right);
}
/// Split chars at index
void LeafNode::SplitCharsOff(size_t char_idx, LeafNode& right) noexcept {
    auto byte_idx = utf8::codepointToByteIdx(GetData(), char_idx);
    SplitBytesOff(byte_idx, right);
}
/// Inserts `string` at `byte_idx` and splits the resulting string in half.
/// Only splits on code point boundaries, so if the whole string is a single code point the right node will be
/// empty.
void LeafNode::InsertBytesAndSplit(size_t byte_idx, std::span<const std::byte> str, LeafNode& right) {
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
void LeafNode::PushBytesAndSplit(std::span<const std::byte> str, LeafNode& right) {
    InsertBytesAndSplit(GetSize(), str, right);
}
/// Distribute children equally between nodes
void LeafNode::BalanceBytes(LeafNode& right) {
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
LeafNode* LeafNode::FromString(NodePage& page, std::string_view& text) {
    auto leaf = new (page.Get()) LeafNode(page.GetPageSize());
    std::span<const std::byte> bytes{reinterpret_cast<const std::byte*>(text.data()), text.size()};
    if (text.size() <= leaf->GetCapacity()) {
        leaf->PushBytes(bytes);
        text = {};
        return leaf;
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
    return leaf;
}

static constexpr size_t InnerCapacity(size_t page_size) {
    return (page_size - 2 * sizeof(void*) - 2 * sizeof(uint32_t) - 8) / (sizeof(TextInfo) + sizeof(NodePtr));
}
/// Constructor
InnerNode::InnerNode(size_t page_size) : child_capacity(InnerCapacity(page_size)) {}

/// Link a neighbor
void InnerNode::LinkNeighbors(InnerNode& other) {
    if (next_node) {
        assert(other.next_node == nullptr);
        other.next_node = next_node;
        next_node->previous_node = &other;
    }
    next_node = &other;
    other.previous_node = this;
}
/// Combine the text statistics
TextInfo InnerNode::AggregateTextInfo() noexcept {
    TextInfo acc;
    for (auto stats : GetChildStats()) {
        acc += stats;
    }
    return acc;
}
/// Combine the text statistics
TextInfo InnerNode::AggregateTextInfoInRange(size_t child_id, size_t count) noexcept {
    TextInfo acc;
    for (auto stats : GetChildStats().subspan(child_id, count)) {
        acc += stats;
    }
    return acc;
}
/// Pushes an item into the array
void InnerNode::Push(NodePtr child, TextInfo stats) {
    assert(!IsFull());
    GetChildStatsBuffer()[child_count] = stats;
    GetChildNodesBuffer()[child_count] = child;
    ++child_count;
}
/// Pushes items into the array
void InnerNode::Push(std::span<const NodePtr> nodes, std::span<const TextInfo> stats) {
    assert(nodes.size() == stats.size());
    assert(nodes.size() <= GetFreeSpace());
    std::memcpy(GetChildNodesBuffer().data() + GetSize(), nodes.data(), nodes.size() * sizeof(NodePtr));
    std::memcpy(GetChildStatsBuffer().data() + GetSize(), stats.data(), stats.size() * sizeof(TextInfo));
    child_count += nodes.size();
}
/// Pops an item from the end of the array
std::pair<NodePtr, TextInfo> InnerNode::Pop() {
    assert(!IsEmpty());
    --child_count;
    return {GetChildNodesBuffer()[child_count], GetChildStatsBuffer()[child_count]};
}
/// Inserts an item at a position
void InnerNode::Insert(size_t idx, NodePtr child, TextInfo stats) {
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
/// Inserts items at a position
void InnerNode::Insert(size_t idx, std::span<const NodePtr> nodes, std::span<const TextInfo> stats) {
    assert(idx <= GetSize());
    assert(nodes.size() == stats.size());
    assert((GetSize() + nodes.size()) <= GetCapacity());
    auto n = nodes.size();
    auto tail = GetSize() - idx;
    auto child_nodes = GetChildNodesBuffer();
    auto child_stats = GetChildStatsBuffer();
    std::memmove(&child_nodes[idx + n], &child_nodes[idx], tail * sizeof(NodePtr));
    std::memmove(&child_stats[idx + n], &child_stats[idx], tail * sizeof(TextInfo));
    std::memcpy(&child_nodes[idx], nodes.data(), n * sizeof(NodePtr));
    std::memcpy(&child_stats[idx], stats.data(), n * sizeof(TextInfo));
    child_count += n;
}
/// Remove an element at a position
std::pair<NodePtr, TextInfo> InnerNode::Remove(size_t idx) {
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
/// Remove elements in a range
void InnerNode::RemoveRange(size_t idx, size_t count) {
    assert(idx < GetSize());
    assert((idx + count) <= GetSize());
    auto child_nodes = GetChildNodesBuffer();
    auto child_stats = GetChildStatsBuffer();
    auto tail = GetSize() - (idx + count);
    std::memmove(&child_nodes[idx], &child_nodes[idx + count], tail * sizeof(NodePtr));
    std::memmove(&child_stats[idx], &child_stats[idx + count], tail * sizeof(TextInfo));
    child_count -= count;
}
/// Truncate children from a position
std::pair<std::span<const NodePtr>, std::span<const TextInfo>> InnerNode::Truncate(size_t idx) noexcept {
    assert(idx <= GetSize());
    std::span<const NodePtr> tail_nodes{&GetChildNodesBuffer()[idx], GetSize() - idx};
    std::span<const TextInfo> tail_stats{&GetChildStatsBuffer()[idx], GetSize() - idx};
    child_count = idx;
    return {tail_nodes, tail_stats};
}
/// Splits node at index and moves elements into a right child
void InnerNode::SplitOffRight(size_t child_idx, InnerNode& right) {
    assert(right.IsEmpty());
    assert(child_idx <= GetSize());
    auto left_child_nodes = GetChildNodesBuffer();
    auto left_child_stats = GetChildStatsBuffer();
    auto right_child_nodes = right.GetChildNodesBuffer();
    auto right_child_stats = right.GetChildStatsBuffer();

    right.child_count = GetSize() - child_idx;
    std::memcpy(right_child_nodes.data(), &left_child_nodes[child_idx], right.child_count * sizeof(NodePtr));
    std::memcpy(right_child_stats.data(), &left_child_stats[child_idx], right.child_count * sizeof(TextInfo));
    child_count = child_idx;

    LinkNeighbors(right);
}
/// Splits node at index and moves elements into a left child
void InnerNode::SplitOffLeft(size_t child_idx, InnerNode& left) {
    assert(left.IsEmpty());
    assert(child_idx <= GetSize());
    auto left_child_nodes = left.GetChildNodesBuffer();
    auto left_child_stats = left.GetChildStatsBuffer();
    auto right_child_nodes = GetChildNodesBuffer();
    auto right_child_stats = GetChildStatsBuffer();

    left.child_count = child_idx;
    std::memcpy(left_child_nodes.data(), right_child_nodes.data(), child_idx * sizeof(NodePtr));
    std::memcpy(left_child_stats.data(), right_child_stats.data(), child_idx * sizeof(TextInfo));
    std::memmove(&right_child_nodes[child_idx], &right_child_nodes[0], (child_count - child_idx) * sizeof(NodePtr));
    std::memmove(&right_child_stats[child_idx], &right_child_stats[0], (child_count - child_idx) * sizeof(NodePtr));
    child_count -= child_idx;

    left.LinkNeighbors(*this);
}
/// Pushes an element onto the end of the array, and then splits it in half
void InnerNode::PushAndSplit(NodePtr child, TextInfo stats, InnerNode& dst) {
    auto r_count = (GetSize() + 1) / 2;
    auto l_count = (GetSize() + 1) - r_count;
    SplitOffRight(l_count, dst);
    dst.Push(child, stats);
}
/// Inserts an element into a the array, and then splits it in half
void InnerNode::InsertAndSplit(size_t idx, NodePtr child, TextInfo stats, InnerNode& other) {
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
void InnerNode::Balance(InnerNode& right) {
    auto left_nodes = GetChildNodesBuffer();
    auto left_stats = GetChildStatsBuffer();
    auto right_nodes = GetChildNodesBuffer();
    auto right_stats = GetChildStatsBuffer();

    if (child_count < right.child_count) {
        // Right got more children than left, append surplus to left
        auto move = (right.child_count - child_count) / 2;
        std::memcpy(left_nodes.data() + GetSize(), right_nodes.data(), move * sizeof(NodePtr));
        std::memcpy(left_stats.data() + GetSize(), right_stats.data(), move * sizeof(TextInfo));
        std::memmove(right_nodes.data(), right_nodes.data() + move, (right.GetSize() - move) * sizeof(NodePtr));
        std::memmove(right_stats.data(), right_stats.data() + move, (right.GetSize() - move) * sizeof(TextInfo));
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

/// Find the first child where a predicate returns true or the last child if none qualify
template <typename Predicate> static InnerNode::Boundary Find(InnerNode& node, size_t arg, Predicate predicate) {
    auto child_stats = node.GetChildStats();
    TextInfo next;
    for (size_t child_idx = 0; (child_idx + 1) < child_stats.size(); ++child_idx) {
        TextInfo prev = next;
        next += child_stats[child_idx];
        if (predicate(arg, prev, next)) {
            return {child_idx, prev};
        }
    }
    assert(!child_stats.empty());
    return {child_stats.size() - 1, next};
}

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
/// Find the child that contains a byte index
InnerNode::Boundary InnerNode::FindByte(size_t byte_idx) {
    auto [child, stats] = Find(*this, byte_idx, ChildContainsByte);
    return {child, stats};
}
/// Find the child that contains a character
InnerNode::Boundary InnerNode::FindCodepoint(size_t char_idx) {
    auto [child, stats] = Find(*this, char_idx, ChildContainsCodepoint);
    return {child, stats};
}
/// Find the child that contains a line break
InnerNode::Boundary InnerNode::FindLineBreak(size_t line_break_idx) {
    auto [child, stats] = Find(*this, line_break_idx, ChildContainsLineBreak);
    return {child, stats};
}

/// Find a range where two predicate return true
template <typename Predicate>
static std::pair<InnerNode::Boundary, InnerNode::Boundary> FindRange(InnerNode& node, size_t arg0, size_t arg1,
                                                                     Predicate predicate) {
    auto child_stats = node.GetChildStats();
    std::pair<size_t, TextInfo> begin, end;
    TextInfo next;
    size_t child_idx = 0;
    TextInfo prev;
    for (; child_idx < child_stats.size(); ++child_idx) {
        prev = next;
        next += child_stats[child_idx];
        if (predicate(arg0, prev, next)) {
            begin = {child_idx, prev};
            end = begin;
            if (predicate(arg1, prev, next)) {
                return {begin, end};
            }
            ++child_idx;
            break;
        }
    }
    for (; child_idx < child_stats.size(); ++child_idx) {
        prev = next;
        next += child_stats[child_idx];
        if (predicate(arg1, prev, next)) {
            end = {child_idx, prev};
            return {begin, end};
        }
    }
    end = {std::max<size_t>(1, child_stats.size()) - 1, prev};
    return {begin, end};
}

/// Find the children that contain a codepoint range
std::pair<InnerNode::Boundary, InnerNode::Boundary> InnerNode::FindCodepointRange(size_t char_idx, size_t count) {
    return FindRange(*this, char_idx, char_idx + count, ChildContainsCodepoint);
}

/// Constructor
Rope::Rope(size_t page_size, NodePtr root_node, TextInfo root_info, LeafNode* first_leaf, size_t tree_height)
    : page_size(page_size),
      tree_height(tree_height),
      root_node(root_node),
      root_info(root_info),
      first_leaf(first_leaf) {}

/// Constructor
Rope::Rope(size_t page_size) : page_size(page_size), tree_height(1) {
    NodePage first_page{page_size};
    first_leaf = new (first_page.Get()) LeafNode(page_size);
    root_node = {first_leaf};
    root_info = {};
    first_page.Release();
}
/// Destructor
Rope::~Rope() {
    NodePtr level = root_node;
    while (!level.IsNull()) {
        if (level.Is<LeafNode>()) {
            LeafNode* iter = level.Get<LeafNode>();
            while (iter) {
                auto next = iter->next_node;
                delete[] reinterpret_cast<std::byte*>(iter);
                iter = next;
            }
            break;
        }
        InnerNode* iter = level.Get<InnerNode>();
        level = (iter && iter->GetSize() > 0) ? iter->GetChildNodes().front() : NodePtr{};
        while (iter) {
            auto next = iter->next_node;
            delete[] reinterpret_cast<std::byte*>(iter);
            iter = next;
        }
    }
    root_node = {};
}
/// Move constructor
Rope::Rope(Rope&& other)
    : page_size(other.page_size),
      tree_height(other.tree_height),
      root_node(other.root_node),
      root_info(other.root_info),
      first_leaf(other.first_leaf) {
    other.root_node = {};
    other.root_info = TextInfo{};
    other.first_leaf = nullptr;
    other.tree_height = 0;
};

/// Copy the rope to a std::string
std::string Rope::ToString() {
    std::string buffer;
    buffer.reserve(root_info.text_bytes);
    for (auto iter = first_leaf; iter; iter = iter->next_node) {
        buffer += iter->GetStringView();
    }
    return buffer;
}

/// Split off a rope
Rope Rope::SplitOff(size_t char_idx) {
    // Special case, split of end
    if (char_idx >= root_info.utf8_codepoints) {
        return Rope{page_size};
    }

    // Collect nodes of right seam
    std::vector<NodePage> right_seam;
    right_seam.reserve(tree_height);

    // Locate leaf node and remember traversed inner nodes
    auto left_iter = root_node;
    auto left_char_idx = char_idx;
    while (left_iter.Is<InnerNode>()) {
        // Find child with codepoint
        InnerNode* left_inner = left_iter.Get<InnerNode>();
        auto [child_idx, child_prefix_stats] = left_inner->FindCodepoint(left_char_idx);

        // Create right inner page.
        // We increment the left child count immediately afterwards to keep child_idx referenced.
        // We will traverse to that page next and split that as well.
        // That way, we don't need to update pointers on the left side and can write new pages to right[0].
        right_seam.emplace_back(page_size);
        auto* right_inner = new (right_seam.back().Get()) InnerNode(page_size);
        left_inner->SplitOffRight(child_idx, *right_inner);
        ++left_inner->child_count;

        // We will update the parent & statistics later

        // Traverse to child
        assert(left_char_idx >= child_prefix_stats.utf8_codepoints);
        assert(left_inner->GetSize() == (child_idx + 1));
        left_char_idx -= child_prefix_stats.utf8_codepoints;
        left_iter = left_inner->GetChildNodes()[child_idx];
    }

    // Reached a leaf
    assert(left_iter.Is<LeafNode>());
    NodePage right_leaf_page{page_size};
    auto* left_leaf = left_iter.Get<LeafNode>();
    auto* right_leaf = new (right_leaf_page.Get()) LeafNode(page_size);
    left_leaf->SplitCharsOff(left_char_idx, *right_leaf);

    // Disconnect the leafs
    left_leaf->next_node = nullptr;
    right_leaf->previous_node = nullptr;

    // Now propagate the text change up the seam nodes
    NodePtr right_child_node{right_leaf};
    TextInfo right_child_info{right_leaf->GetData()};
    for (auto seam_iter = right_seam.rbegin(); seam_iter != right_seam.rend(); ++seam_iter) {
        auto right_parent = seam_iter->Get<InnerNode>();
        auto left_parent = right_parent->previous_node;
        // Store child in right parent
        right_parent->GetChildNodes().front() = right_child_node;
        right_parent->GetChildStats().front() = right_child_info;
        // Update left parent
        assert(!left_parent->GetChildNodes().empty());
        left_parent->GetChildStats().back() -= right_child_info;
        // Disconnect nodes
        left_parent->next_node = nullptr;
        right_parent->previous_node = nullptr;
        // Go 1 level up
        right_child_node = right_parent;
        right_child_info = right_parent->AggregateTextInfo();
    }
    root_info -= right_child_info;

    // Pass ownership over right pages to the new rope
    right_leaf_page.Release();
    for (auto& right_page : right_seam) {
        right_page.Release();
    }
    // Create the right rope
    return Rope{page_size, right_child_node, right_child_info, right_leaf, tree_height};
}

/// Append a rope with the same height
void Rope::LinkEquiHeight(size_t page_size, NodePtr left_root, NodePtr right_root) {
    // Connect inner seam nodes
    auto left_iter = left_root;
    auto right_iter = right_root;
    while (left_iter.Is<InnerNode>()) {
        assert(right_iter.Is<InnerNode>());
        auto left_inner = left_iter.Get<InnerNode>();
        auto right_inner = right_iter.Get<InnerNode>();
        assert(!left_inner->IsEmpty());
        assert(!right_inner->IsEmpty());
        left_inner->next_node = right_inner;
        right_inner->previous_node = left_inner;
        left_iter = left_inner->GetChildNodes().back();
        right_iter = right_inner->GetChildNodes().front();
    }

    // Connect leaf nodes
    auto left_leaf = left_iter.Get<LeafNode>();
    auto right_leaf = right_iter.Get<LeafNode>();
    left_leaf->next_node = right_leaf;
    right_leaf->previous_node = left_leaf;
}

/// Append a rope with the same height
void Rope::AppendEquiHeight(Rope&& right_rope) {
    assert(tree_height == right_rope.tree_height);

    // Root is a leaf node?
    if (root_node.Is<LeafNode>()) {
        assert(right_rope.root_node.Is<LeafNode>());
        auto left_leaf = root_node.Get<LeafNode>();
        auto right_leaf = right_rope.root_node.Get<LeafNode>();

        // Can merge the leafs?
        if (left_leaf->GetFreeSpace() >= right_leaf->GetSize()) {
            left_leaf->PushBytes(right_leaf->TruncateBytes());
            root_info += right_rope.root_info;
        } else {
            // Create new root
            NodePage new_root_page{page_size};
            auto* new_root_node = new (new_root_page.Get()) InnerNode(page_size);
            new_root_node->Push(root_node, root_info);
            new_root_node->Push(right_rope.root_node, right_rope.root_info);
            root_node = new_root_page.Release<InnerNode>();
            root_info = new_root_node->AggregateTextInfo();
            left_leaf->LinkNeighbors(*right_leaf);
            ++tree_height;
            right_rope.root_node = {};
        }
        return;
    }

    // Connect seam nodes
    LinkEquiHeight(page_size, root_node, right_rope.root_node);
    auto left_inner = root_node.Get<InnerNode>();
    auto right_inner = right_rope.root_node.Get<InnerNode>();

    // Can merge the inner nodes?
    if (left_inner->GetFreeSpace() >= right_inner->GetSize()) {
        auto [nodes, stats] = left_inner->Truncate();
        left_inner->Push(nodes, stats);
        root_info += right_rope.root_info;
    } else {
        // Create new root
        NodePage new_root_page{page_size};
        auto* new_root_node = new (new_root_page.Get()) InnerNode(page_size);
        new_root_node->Push(root_node, root_info);
        new_root_node->Push(right_rope.root_node, right_rope.root_info);
        root_node = new_root_page.Release<InnerNode>();
        root_info = new_root_node->AggregateTextInfo();
        ++tree_height;
    }
    right_rope.root_node = {};
}

/// Append a rope that is smaller
void Rope::AppendSmaller(Rope&& right_rope) {
    assert(tree_height > right_rope.tree_height);

    // Preemptively split root?
    assert(root_node.Is<InnerNode>());
    if (root_node.Get<InnerNode>()->IsFull()) {
        PreemptiveSplitRoot();
    }

    // Preemptively split head
    InnerNode* parent = nullptr;
    auto iter_node = root_node;
    auto iter_info = &root_info;
    for (size_t i = 0; i < tree_height - right_rope.tree_height; ++i) {
        auto inner = iter_node.Get<InnerNode>();

        // Fast-track if not full
        if (!inner->IsFull()) {
            (*iter_info) += right_rope.root_info;
            parent = inner;
            iter_node = inner->GetChildNodes().back();
            iter_info = &inner->GetChildStats().back();
            continue;
        }
        assert(parent != nullptr);

        // Split off a page
        NodePage split_page{page_size};
        auto* split = new (split_page.Get()) InnerNode(page_size);
        inner->SplitOffRight((inner->GetSize() + 1) / 2, *split);
        auto split_info = split->AggregateTextInfo();
        (*iter_info) -= split_info;
        split_info += right_rope.root_info;
        parent->Push(split_page.Release<InnerNode>(), split_info);

        // Update iterator
        parent = split;
        iter_node = split->GetChildNodes().back();
        iter_info = &split->GetChildStats().back();
    }

    // Did we hit a leaf?
    if (iter_node.Is<LeafNode>()) {
        assert(right_rope.root_node.Is<LeafNode>());
        assert(parent != nullptr);
        parent->Push(right_rope.root_node, right_rope.root_info);
        auto left = iter_node.Get<LeafNode>();
        auto right = right_rope.root_node.Get<LeafNode>();
        left->LinkNeighbors(*right);
    } else {
        // Merge inners
        assert(right_rope.root_node.Is<InnerNode>());
        assert(parent != nullptr);
        auto left = iter_node.Get<InnerNode>();
        parent->Push(right_rope.root_node, right_rope.root_info);
        LinkEquiHeight(page_size, left, right_rope.root_node);
    }

    // Update root
    right_rope.root_node = {};
}

/// Append a rope that is taller
void Rope::AppendTaller(Rope&& right_rope) {
    assert(right_rope.tree_height > tree_height);

    // Preemptively split root?
    assert(right_rope.root_node.Is<InnerNode>());
    if (right_rope.root_node.Get<InnerNode>()->IsFull()) {
        right_rope.PreemptiveSplitRoot();
    }

    // Preemptively split head
    InnerNode* parent = nullptr;
    auto iter_node = right_rope.root_node;
    auto iter_info = &right_rope.root_info;
    for (size_t i = 0; i < right_rope.tree_height - tree_height; ++i) {
        // Fast-track if not full
        auto inner = iter_node.Get<InnerNode>();
        if (!inner->IsFull()) {
            (*iter_info) += root_info;
            parent = inner;
            iter_node = inner->GetChildNodes().front();
            iter_info = &inner->GetChildStats().front();
            continue;
        }
        assert(parent != nullptr);

        // Split off a page
        NodePage split_page{page_size};
        auto* split = new (split_page.Get()) InnerNode(page_size);
        inner->SplitOffLeft((inner->GetSize() + 1) / 2, *split);
        auto split_info = split->AggregateTextInfo();
        (*iter_info) -= split_info;
        split_info += root_info;
        parent->Insert(0, split_page.Release<InnerNode>(), split_info);

        // Update iterator
        parent = split;
        iter_node = split->GetChildNodes().front();
        iter_info = &split->GetChildStats().front();
    }

    // Did we hit a leaf?
    if (iter_node.Is<LeafNode>()) {
        assert(root_node.Is<LeafNode>());
        assert(parent != nullptr);
        parent->Insert(0, root_node, root_info);
        auto left = root_node.Get<LeafNode>();
        auto right = iter_node.Get<LeafNode>();
        left->LinkNeighbors(*right);
    } else {
        // Merge inners
        assert(root_node.Is<InnerNode>());
        assert(parent != nullptr);
        auto right = iter_node.Get<InnerNode>();
        parent->Insert(0, root_node, root_info);
        LinkEquiHeight(page_size, root_node, right);
    }

    // Update root
    root_node = right_rope.root_node;
    root_info = right_rope.root_info;
    tree_height = right_rope.tree_height;
    right_rope.root_node = {};
}

/// Append a rope to this rope
void Rope::Append(Rope&& right_rope) {
    if (tree_height == right_rope.tree_height) {
        AppendEquiHeight(std::move(right_rope));
    } else if (tree_height > right_rope.tree_height) {
        AppendSmaller(std::move(right_rope));
    } else {
        AppendTaller(std::move(right_rope));
    }
}

/// Balance children to make space for preemptive split
void Rope::PreemptiveBalanceOrSplit(InnerNode& parent, size_t& child_idx, TextInfo& child_prefix, size_t char_idx) {
    assert(!parent.IsFull());
    auto child_ptr = parent.GetChildNodes()[child_idx];
    auto& child = *child_ptr.Get<InnerNode>();
    assert(child_ptr.Is<InnerNode>());
    assert(child.IsFull());
    auto& child_stats = parent.GetChildStats()[child_idx];

    // Try to balance with left neighbor
    if (child_idx > 0) {
        auto left_idx = child_idx - 1;
        assert(child.previous_node == parent.GetChildNodes()[left_idx].Get<InnerNode>());

        // Left neighbor has space?
        auto& left_node = *child.previous_node;
        auto& left_stats = parent.GetChildStats()[left_idx];
        if (left_node.GetFreeSpace() >= 2) {
            // Determine number of elements to move left
            auto move_left = std::max<size_t>(1, (child.GetSize() - left_node.GetSize()) / 2);
            assert((left_node.GetSize() + move_left) < left_node.GetCapacity());
            auto move_left_stats = child.AggregateTextInfoInRange(0, move_left);

            // Move children
            left_node.Push(child.GetChildNodes().subspan(0, move_left), child.GetChildStats().subspan(0, move_left));
            left_stats += move_left_stats;
            child.RemoveRange(0, move_left);
            child_stats -= move_left_stats;
            child_prefix += move_left_stats;

            // Check if we should continue with left neighbor
            if (char_idx < child_prefix.utf8_codepoints) {
                child_prefix -= left_stats;
                --child_idx;
            }
            return;
        }
    }
    // Try to balance with right neighbor
    if ((child_idx + 1) < parent.child_count) {
        auto right_idx = child_idx + 1;
        assert(child.next_node == parent.GetChildNodes()[right_idx].Get<InnerNode>());

        // Left neighbor has space?
        auto& right_node = *child.next_node;
        auto& right_stats = parent.GetChildStats()[right_idx];
        if (right_node.GetFreeSpace() >= 2) {
            // Determine number of elements to move right
            auto move_right = std::max<size_t>(1, (child.GetSize() - right_node.GetSize()) / 2);
            assert((right_node.GetSize() + move_right) < right_node.GetCapacity());
            auto move_right_from = child.GetSize() - move_right;
            auto move_right_stats = child.AggregateTextInfoInRange(move_right_from, move_right);

            // Move children
            auto [orphan_nodes, orphan_stats] = child.Truncate(move_right_from);
            child_stats -= move_right_stats;
            right_node.Insert(0, orphan_nodes, orphan_stats);
            right_stats += move_right_stats;

            // Check if we should continue with right neighbor
            if (char_idx >= (child_prefix.utf8_codepoints + child_stats.utf8_codepoints)) {
                child_prefix += child_stats;
                ++child_idx;
            }
            return;
        }
    }
    
    // Balancing failed, create a split page
    NodePage split_page{page_size};
    auto split_node = new (split_page.Get()) InnerNode(page_size);
    child.SplitOffRight(child.GetSize() / 2, *split_node);
    auto split_info = split_node->AggregateTextInfo();
    parent.Insert(child_idx + 1, split_page.Release<InnerNode>(), split_info);
    child_stats -= split_info;

    // Check if we have to continue with the split node
    if (char_idx >= (child_prefix.utf8_codepoints + child_stats.utf8_codepoints)) {
        child_prefix += child_stats;
        ++child_idx;
    }
}

/// Split the root inner page
void Rope::PreemptiveSplitRoot() {
    assert(root_node.Is<InnerNode>());
    NodePage right_page{page_size};
    NodePage root_page{page_size};
    auto* left = root_node.Get<InnerNode>();
    auto* right = new (right_page.Get()) InnerNode(page_size);
    auto* root = new (root_page.Get()) InnerNode(page_size);
    left->SplitOffRight((left->GetSize() + 1) / 2, *right);
    auto right_info = right->AggregateTextInfo();
    root->Push(left, root_info - right_info);
    root->Push(right_page.Release<InnerNode>(), right_info);
    root_node = root_page.Release<InnerNode>();
    ++tree_height;
}

/// Insert a small text at index.
/// The text to be inserted must not exceed the size of leaf page.
/// That guarantees that we need at most one split.
void Rope::InsertBounded(size_t char_idx, std::span<const std::byte> text_bytes) {
    assert(text_bytes.size() <= LeafCapacity(page_size));
    TextInfo insert_info{text_bytes};

    // Traversal state
    InnerNode* parent_node = nullptr;
    LeafNode* leaf_node = nullptr;
    TextInfo* leaf_stats = nullptr;
    size_t child_idx = 0;

    // Root is a leaf node?
    if (root_node.Is<LeafNode>()) {
        leaf_node = root_node.Get<LeafNode>();
        leaf_stats = &root_info;
    } else {
        // Root is a full inner node? Pre-emptively split
        if (root_node.Get<InnerNode>()->IsFull()) {
            PreemptiveSplitRoot();
        }
        root_info += insert_info;

        // Traverse down the tree with pre-emptive splits
        parent_node = root_node.Get<InnerNode>();
        TextInfo child_prefix;
        while (true) {
            char_idx -= child_prefix.utf8_codepoints;
            std::tie(child_idx, child_prefix) = parent_node->FindCodepoint(char_idx);

            // Did we reach leaf nodes?
            auto child_node = parent_node->GetChildNodes()[child_idx];
            if (child_node.Is<LeafNode>()) {
                char_idx -= child_prefix.utf8_codepoints;
                leaf_node = child_node.Get<LeafNode>();
                leaf_stats = &parent_node->GetChildStats()[child_idx];
                break;
            }

            // Child is a full inner node?
            auto child_inner = child_node.Get<InnerNode>();
            if (child_inner->IsFull()) {
                PreemptiveBalanceOrSplit(*parent_node, child_idx, child_prefix, char_idx);
                child_node = parent_node->GetChildNodes()[child_idx];
                child_inner = child_node.Get<InnerNode>();
            }

            // Preemptive splitting ensures that the inserted data is guaranteed to be below us.
            // We can therefore already bump the node info.
            // (Our child is an inner node and we ensured that it has at least 1 element free)
            parent_node->GetChildStats()[child_idx] += insert_info;
            // Traverse to next child
            parent_node = child_inner;
        }
    }

    // Determine insert point
    auto insert_at = utf8::codepointToByteIdx(leaf_node->GetData(), char_idx);
    assert(char_idx <= leaf_stats->utf8_codepoints);

    // Fits in leaf?
    if ((leaf_node->GetSize() + text_bytes.size()) <= leaf_node->GetCapacity()) {
        assert(insert_at <= leaf_node->GetSize());
        leaf_node->InsertBytes(insert_at, text_bytes);
        *leaf_stats += insert_info;
        return;
    }

    // Text does not fit on leaf, split the leaf
    NodePage split_page{page_size};
    auto split = new (split_page.Get()) LeafNode(page_size);
    leaf_node->InsertBytesAndSplit(insert_at, text_bytes, *split);

    // Collect split node
    TextInfo split_info{split->GetData()};
    *leaf_stats = *leaf_stats + insert_info - split_info;

    // Is there a parent node?
    if (parent_node) {
        parent_node->Insert(child_idx + 1, split_page.Release<LeafNode>(), split_info);
        return;
    }

    // Otherwise create a new root
    NodePage new_root_page{page_size};
    auto new_root = new (new_root_page.Get()) InnerNode(page_size);
    new_root->Push(leaf_node, *leaf_stats);
    new_root->Push(split_page.Release<LeafNode>(), split_info);
    root_info = new_root->AggregateTextInfo();
    root_node = new_root_page.Release<InnerNode>();
    ++tree_height;
}

static constexpr size_t BulkloadThreshold(size_t page_size) { return 6 * page_size; }

/// Insert at index
void Rope::Insert(size_t char_idx, std::string_view text) {
    // Make sure the char idx is not out of bounds
    char_idx = std::min(char_idx, root_info.utf8_codepoints);
    std::span<const std::byte> text_buffer{reinterpret_cast<const std::byte*>(text.data()), text.size()};

    // Bulk-load the text into a new rope and merge it?
    if (text.size() >= BulkloadThreshold(page_size)) {
        auto right = SplitOff(char_idx);
        Append(Rope::FromString(page_size, text));
        Append(std::move(right));
        return;
    }

    // Split the input text in chunks and insert it into the rope
    while (!text.empty()) {
        auto split_idx = utf8::findCodepoint(text_buffer, std::min(LeafCapacity(page_size) - 4, text.size()), false);
        auto tail = text_buffer.subspan(split_idx);
        text = text.substr(0, split_idx);
        InsertBounded(char_idx, tail);
    }
}

/// Create a rope from a string
Rope Rope::FromString(size_t page_size, std::string_view text) {
    // Short-circuit case where the input text is empty
    if (text.empty()) {
        return Rope{page_size};
    }

    // Create leaf nodes
    std::vector<NodePage> leafs;
    auto leaf_capacity = LeafCapacity(page_size);
    leafs.reserve((text.size() + leaf_capacity - 1) / leaf_capacity);
    LeafNode* prev_leaf = nullptr;
    while (!text.empty()) {
        leafs.emplace_back(page_size);
        auto new_leaf = LeafNode::FromString(leafs.back(), text);

        // Link leaf node
        if (prev_leaf != nullptr) {
            prev_leaf->next_node = new_leaf;
            new_leaf->previous_node = prev_leaf;
        }
        prev_leaf = new_leaf;
    }

    // Is a leaf single leaf?
    if (leafs.size() == 1) {
        auto leaf_node = leafs.back().Get<LeafNode>();
        auto root_info = TextInfo{leaf_node->GetData()};
        Rope rope{page_size, NodePtr{leaf_node}, root_info, leaf_node, 1};
        leafs.back().Release();
        return rope;
    }

    // Create inner nodes from leafs
    std::vector<NodePage> inners;
    InnerNode* prev_inner = nullptr;
    for (size_t begin = 0; begin < leafs.size();) {
        inners.emplace_back(page_size);
        auto next = new (inners.back().Get()) InnerNode(page_size);

        // Store child nodes
        auto n = std::min(leafs.size() - begin, InnerCapacity(page_size));
        for (auto i = 0; i < n; ++i) {
            auto leaf = leafs[begin + i].Get<LeafNode>();
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
    size_t tree_height = 2;

    // Create inner nodes from inner nodes
    auto level_begin = 0;
    auto level_end = inners.size();
    while ((level_end - level_begin) > 1) {
        prev_inner = nullptr;
        ++tree_height;

        // Iterate of inner nodes of previous level
        for (size_t begin = level_begin; begin < level_end;) {
            inners.emplace_back(page_size);
            auto next = new (inners.back().Get()) InnerNode(page_size);

            // Store children
            auto n = std::min(level_end - begin, InnerCapacity(page_size));
            for (auto i = 0; i < n; ++i) {
                auto inner = inners[begin + i].Get<InnerNode>();
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
    auto root_inner_node = inners[level_begin].Get<InnerNode>();
    auto root_info = root_inner_node->AggregateTextInfo();
    auto first_leaf = leafs.front().Get<LeafNode>();
    Rope rope{page_size, NodePtr{root_inner_node}, root_info, first_leaf, tree_height};

    for (auto& leaf : leafs) {
        leaf.Release();
    }
    for (auto& inner : inners) {
        inner.Release();
    }
    return rope;
}

// Remove a range of characters
void Rope::Remove(size_t char_idx, size_t char_count) {
    char_idx = std::min<size_t>(char_idx, root_info.utf8_codepoints);
    char_count = std::min<size_t>(char_count, root_info.utf8_codepoints - char_idx);

    // Remember the inner boundaries since we have to propagate the deleted text statistics upwards.
    // This is inevitable since we cannot know beforehand how many text_bytes and lines are falling into the char range.
    // Our only option is to traverse down to the leaf, perform the deletion and then propagate the deleted text
    // stats to parents.
    //
    // NOTE that we don't have to propagate the statistics of nodes between the boundaries since they can be
    //      accounted for when removing the range from the the shared parent!!
    struct InnerBounds {
        InnerNode *lower_node, *upper_node;
        TextInfo *lower_info, *upper_info;
        TextInfo lower_deleted, upper_deleted;
    };
    std::vector<InnerBounds> inner_bounds;
    inner_bounds.reserve(tree_height);

    // During removal, we track the lower and upper boundary nodes.
    // Initially, both a are pointing to the root.
    auto lower_node = root_node, upper_node = root_node;
    auto lower_info = &root_info, upper_info = &root_info;
    auto lower_char_idx = char_idx, upper_char_idx = char_idx + char_count;

    // Remove nodes level-by-level
    while (lower_node.Is<InnerNode>()) {
        assert(lower_node.Is<InnerNode>());
        assert(upper_node.Is<InnerNode>());
        auto lower_inner = lower_node.Get<InnerNode>();
        auto upper_inner = upper_node.Get<InnerNode>();

        // Remember inner boundaries to propagate leaf deletions upwards
        inner_bounds.push_back(InnerBounds{
            .lower_node = lower_inner,
            .upper_node = upper_inner,
            .lower_info = lower_info,
            .upper_info = upper_info,
            .lower_deleted = {},
            .upper_deleted = {},
        });

        // Deletion in same node?
        if (lower_inner == upper_inner) {
            auto range = lower_inner->FindCodepointRange(lower_char_idx, upper_char_idx - lower_char_idx);
            auto [next_lower_idx, next_lower_prefix] = std::get<0>(range);
            auto [next_upper_idx, next_upper_prefix] = std::get<1>(range);

            // Delete children in between (if there are any)
            auto deleted_end = next_upper_idx;
            auto deleted_begin = std::min<size_t>(next_lower_idx + 1, deleted_end);
            auto deleted_count = deleted_end - deleted_begin;
            auto deleted_info = lower_inner->AggregateTextInfoInRange(deleted_begin, deleted_count);
            lower_inner->RemoveRange(deleted_begin, deleted_count);
            inner_bounds.back().lower_deleted += deleted_info;

            // Traverse down to next
            lower_char_idx -= next_lower_prefix.utf8_codepoints;
            lower_node = lower_inner->GetChildNodes()[next_lower_idx];
            lower_info = &lower_inner->GetChildStats()[next_lower_idx];
            upper_char_idx -= next_upper_prefix.utf8_codepoints;
            upper_node = upper_inner->GetChildNodes()[next_upper_idx - deleted_count];
            upper_info = &upper_inner->GetChildStats()[next_upper_idx - deleted_count];
        } else {
            // First, find the next left and right boundaries
            auto [next_lower_idx, next_lower_prefix] = lower_inner->FindCodepoint(lower_char_idx);
            auto [next_upper_idx, next_upper_prefix] = upper_inner->FindCodepoint(upper_char_idx);

            // Delete suffix of lower bound
            auto lower_suffix_length = lower_inner->GetSize() - (next_lower_idx + 1);
            auto lower_deleted = lower_inner->AggregateTextInfoInRange(next_lower_idx + 1, lower_suffix_length);
            lower_inner->Truncate(next_lower_idx + 1);
            inner_bounds.back().lower_deleted += lower_deleted;

            // Delete prefix of upper bound
            auto upper_deleted = upper_inner->AggregateTextInfoInRange(0, next_upper_idx);
            upper_inner->RemoveRange(0, next_upper_idx);
            inner_bounds.back().upper_deleted += upper_deleted;

            // Blindly delete all nodes in between.
            // Note that we account for their deleted text statistics in the first shared ancestor node.
            for (auto neighbor = lower_inner->next_node; neighbor != upper_inner;) {
                auto next = neighbor->next_node;
                delete[] reinterpret_cast<std::byte*>(neighbor);
                neighbor = next;
            }
            lower_inner->next_node = upper_inner;
            upper_inner->previous_node = lower_inner;

            // Traverse down to next
            lower_char_idx -= next_lower_prefix.utf8_codepoints;
            lower_node = lower_inner->GetChildNodes().back();
            lower_info = &lower_inner->GetChildStats().back();
            upper_char_idx -= next_upper_prefix.utf8_codepoints;
            upper_node = upper_inner->GetChildNodes().front();
            upper_info = &upper_inner->GetChildStats().front();
        }
    }

    // Reached leafs
    assert(lower_node.Is<LeafNode>());
    assert(upper_node.Is<LeafNode>());
    auto lower_leaf = lower_node.Get<LeafNode>();
    auto upper_leaf = upper_node.Get<LeafNode>();

    // Deletion in same leaf?
    if (lower_leaf == upper_leaf) {
        assert(lower_char_idx <= lower_leaf->GetSize());
        assert(upper_char_idx <= lower_leaf->GetSize());
        auto deleted = lower_leaf->RemoveCharRange(lower_char_idx, upper_char_idx - lower_char_idx);
        (*lower_info) -= deleted;
        for (auto iter = inner_bounds.rbegin(); iter != inner_bounds.rend(); ++iter) {
            deleted += iter->lower_deleted;
            (*iter->lower_info) -= deleted;
        }
    } else {
        // Adjust boundaries
        TextInfo lower_deleted = lower_leaf->TruncateChars(lower_char_idx);
        TextInfo upper_deleted = upper_leaf->RemoveCharRange(0, upper_char_idx);

        // Blindly delete all nodes in between
        for (auto neighbor = lower_leaf->next_node; neighbor != upper_leaf;) {
            auto next = neighbor->next_node;
            delete[] reinterpret_cast<std::byte*>(neighbor);
            neighbor = next;
        }
        lower_leaf->next_node = upper_leaf;
        upper_leaf->previous_node = lower_leaf;

        // Propagate statistics upwards
        (*lower_info) -= lower_deleted;
        (*upper_info) -= upper_deleted;
        for (auto iter = inner_bounds.rbegin(); iter != inner_bounds.rend(); ++iter) {
            lower_deleted += iter->lower_deleted;
            upper_deleted += iter->upper_deleted;
            (*iter->lower_info) -= lower_deleted;
            (*iter->upper_info) -= upper_deleted;
        }
    }
}

/// Validate a rope
void Rope::CheckIntegrity() {
    auto validate = [](bool value, std::string_view msg) {
#ifdef WASM
        assert(!value);
#else
        if (!value) {
            throw std::logic_error{std::string{msg}};
        }
#endif
    };
    if (root_node.IsNull()) return;

    // A pending validation
    struct Validation {
        NodePtr node;
        TextInfo expected;
        size_t level;
    };
    std::vector<Validation> pending;
    pending.reserve(10 * tree_height);
    pending.push_back(Validation{
        .node = root_node,
        .expected = root_info,
        .level = 0
    });
    size_t max_level = 0;
    while (!pending.empty()) {
        auto top = pending.back();
        pending.pop_back();
        max_level = std::max(top.level, max_level);

        // Is a leaf node?
        if (top.node.Is<LeafNode>()) {
            auto leaf = top.node.Get<LeafNode>();
            TextInfo have{leaf->GetData()};
            validate(top.expected.text_bytes == have.text_bytes, "leaf text bytes mismatch");
            validate(top.expected.line_breaks == have.line_breaks, "leaf line breaks mismatch");
            validate(top.expected.utf8_codepoints == have.utf8_codepoints, "leaf utf8 codepoint mismatch");
        } else {
            // Is an inner node
            auto inner = top.node.Get<InnerNode>();
            TextInfo have;
            for (size_t i = 0; i < inner->child_count; ++i) {
                auto nodes = inner->GetChildNodes();
                auto stats = inner->GetChildStats();
                have += stats[i];
                pending.push_back(Validation {
                    .node = nodes[i],
                    .expected = stats[i],
                    .level = top.level + 1,
                });
            }
            validate(top.expected.text_bytes == have.text_bytes, "inner text bytes mismatch");
            validate(top.expected.line_breaks == have.line_breaks, "inner line breaks mismatch");
            validate(top.expected.utf8_codepoints == have.utf8_codepoints, "inner utf8 codepoint mismatch");
        }
    }
    validate(tree_height == (max_level + 1), "tree height mismatch");
}

}  // namespace flatsql::rope
