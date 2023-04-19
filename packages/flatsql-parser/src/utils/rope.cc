#include "flatsql/text/rope.h"

#include <vector>

namespace flatsql::rope {

/// Constructor
TextStats::TextStats() {}
/// Constructor
TextStats::TextStats(std::span<std::byte> data) : TextStats(std::span<const std::byte>(data)) {}
/// Constructor
TextStats::TextStats(std::span<const std::byte> data) : text_bytes(data.size()) {
    for (auto b : data) {
        line_breaks += (b == std::byte{0x0A});
        utf8_codepoints += utf8::isCodepointBoundary(b);
    }
}
TextStats TextStats::operator+(const TextStats& other) {
    TextStats result = *this;
    result.text_bytes += other.text_bytes;
    result.utf8_codepoints += other.utf8_codepoints;
    result.line_breaks += other.line_breaks;
    return result;
}
TextStats& TextStats::operator+=(const TextStats& other) {
    *this = *this + other;
    return *this;
}
TextStats TextStats::operator-(const TextStats& other) {
    TextStats result = *this;
    assert(result.text_bytes >= other.text_bytes);
    assert(result.utf8_codepoints >= other.utf8_codepoints);
    assert(result.line_breaks >= other.line_breaks);
    result.text_bytes -= other.text_bytes;
    result.utf8_codepoints -= other.utf8_codepoints;
    result.line_breaks -= other.line_breaks;
    return result;
}
TextStats& TextStats::operator-=(const TextStats& other) {
    *this = *this - other;
    return *this;
}

/// Constructor
LeafNode::LeafNode(uint32_t page_size) : buffer_capacity(LeafNode::Capacity(page_size)) {}
/// Link a neighbor
void LeafNode::LinkNodeRight(LeafNode& other) {
    if (next_node) {
        other.next_node = next_node;
        next_node->previous_node = &other;
    }
    next_node = &other;
    other.previous_node = this;
}
/// Unlink a node
void LeafNode::UnlinkNode() {
    if (next_node) {
        next_node->previous_node = previous_node;
    }
    if (previous_node) {
        previous_node->next_node = next_node;
    }
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
TextStats LeafNode::RemoveCharRange(size_t start_idx, size_t count) noexcept {
    auto byte_start = utf8::codepointToByteIdx(GetData(), start_idx);
    auto byte_end = byte_start + utf8::codepointToByteIdx(GetData().subspan(byte_start), count);
    auto byte_count = byte_end - byte_start;
    TextStats stats{GetData().subspan(byte_start, byte_count)};
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
    LinkNodeRight(right);
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
    LinkNodeRight(right);
}
/// Appends a string and splits the resulting string in half.
///
/// Only splits on code point boundaries, so if the whole string is a single code point,
/// the split will fail and the returned string will be empty.
void LeafNode::PushBytesAndSplit(std::span<const std::byte> str, LeafNode& right) {
    InsertBytesAndSplit(GetSize(), str, right);
}

/// Only balance if left and right nodes diff by more than 1/4th of the page capacity
static inline bool shouldBalanceLeaf(size_t capacity, size_t left, size_t right) {
    size_t diff = std::abs(static_cast<ssize_t>(left) - static_cast<ssize_t>(right));
    return (diff * 4) >= capacity;
}

/// Distribute children equally between nodes
void LeafNode::BalanceCharsRight(TextStats& own_info, LeafNode& right_node, TextStats& right_info, bool force) {
    if (!shouldBalanceLeaf(buffer_capacity, GetSize(), right_node.GetSize()) && !force) {
        return;
    }

    // Move children from right to left?
    if (GetSize() < right_node.GetSize()) {
        size_t move_left = (right_node.GetSize() - GetSize()) / 2;
        move_left = utf8::prevCodepoint(right_node.GetData(), move_left);
        auto diff = TextStats{right_node.GetData().subspan(0, move_left)};
        PushBytes(right_node.GetData().subspan(0, move_left));
        right_node.RemoveByteRange(0, move_left);
        own_info += diff;
        right_info -= diff;
        return;
    }

    // Move children from left to right?
    if (GetSize() > right_node.GetSize()) {
        auto move_right = (GetSize() - right_node.GetSize()) / 2;
        auto move_right_from = utf8::nextCodepoint(GetData(), GetSize() - move_right);
        move_right = GetSize() - move_right_from;
        auto diff = TextStats{GetData().subspan(move_right_from, move_right)};
        auto move_right_data = TruncateBytes(move_right_from);
        right_node.InsertBytes(0, move_right_data);
        own_info -= diff;
        right_info += diff;
    }
}

/// Create a leaf node from a string
LeafNode* LeafNode::FromString(NodePage& page, std::string_view& text, size_t leaf_capacity) {
    auto leaf = new (page.Get()) LeafNode(page.GetPageSize());
    leaf_capacity = std::min<size_t>(leaf_capacity, leaf->GetCapacity());
    std::span<const std::byte> bytes{reinterpret_cast<const std::byte*>(text.data()), text.size()};
    if (text.size() <= leaf->GetCapacity()) {
        leaf->PushBytes(bytes);
        text = {};
        return leaf;
    }
    bytes = bytes.subspan(0, std::min<size_t>(leaf_capacity, text.size()));
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

/// Constructor
InnerNode::InnerNode(size_t page_size) : child_capacity(InnerNode::Capacity(page_size)) {}

/// Link a neighbor
void InnerNode::LinkNodeRight(InnerNode& other) {
    if (next_node) {
        assert(other.next_node == nullptr);
        other.next_node = next_node;
        next_node->previous_node = &other;
    }
    next_node = &other;
    other.previous_node = this;
}
/// Unlink a node
void InnerNode::UnlinkNode() {
    if (next_node) {
        next_node->previous_node = previous_node;
    }
    if (previous_node) {
        previous_node->next_node = next_node;
    }
}
/// Combine the text statistics
TextStats InnerNode::AggregateTextInfo() noexcept {
    TextStats acc;
    for (auto stats : GetChildStats()) {
        acc += stats;
    }
    return acc;
}
/// Combine the text statistics
TextStats InnerNode::AggregateTextInfoInRange(size_t child_id, size_t count) noexcept {
    TextStats acc;
    for (auto stats : GetChildStats().subspan(child_id, count)) {
        acc += stats;
    }
    return acc;
}
/// Pushes an item into the array
void InnerNode::Push(NodePtr child, TextStats stats) {
    assert(!IsFull());
    GetChildStatsBuffer()[child_count] = stats;
    GetChildNodesBuffer()[child_count] = child;
    ++child_count;
}
/// Pushes items into the array
void InnerNode::Push(std::span<const NodePtr> nodes, std::span<const TextStats> stats) {
    assert(nodes.size() == stats.size());
    assert(nodes.size() <= GetFreeSpace());
    std::memcpy(GetChildNodesBuffer().data() + GetSize(), nodes.data(), nodes.size() * sizeof(NodePtr));
    std::memcpy(GetChildStatsBuffer().data() + GetSize(), stats.data(), stats.size() * sizeof(TextStats));
    child_count += nodes.size();
}
/// Pops an item from the end of the array
std::pair<NodePtr, TextStats> InnerNode::Pop() {
    assert(!IsEmpty());
    --child_count;
    return {GetChildNodesBuffer()[child_count], GetChildStatsBuffer()[child_count]};
}
/// Inserts an item at a position
void InnerNode::Insert(size_t idx, NodePtr child, TextStats stats) {
    assert(idx <= GetSize());
    assert(GetSize() < GetCapacity());
    auto tail = GetSize() - idx;
    auto child_nodes = GetChildNodesBuffer();
    auto child_stats = GetChildStatsBuffer();
    std::memmove(&child_nodes[idx + 1], &child_nodes[idx], tail * sizeof(NodePtr));
    std::memmove(&child_stats[idx + 1], &child_stats[idx], tail * sizeof(TextStats));
    child_nodes[idx] = child;
    child_stats[idx] = stats;
    ++child_count;
}
/// Inserts items at a position
void InnerNode::Insert(size_t idx, std::span<const NodePtr> nodes, std::span<const TextStats> stats) {
    assert(idx <= GetSize());
    assert(nodes.size() == stats.size());
    assert((GetSize() + nodes.size()) <= GetCapacity());
    auto n = nodes.size();
    auto tail = GetSize() - idx;
    auto child_nodes = GetChildNodesBuffer();
    auto child_stats = GetChildStatsBuffer();
    std::memmove(&child_nodes[idx + n], &child_nodes[idx], tail * sizeof(NodePtr));
    std::memmove(&child_stats[idx + n], &child_stats[idx], tail * sizeof(TextStats));
    std::memcpy(&child_nodes[idx], nodes.data(), n * sizeof(NodePtr));
    std::memcpy(&child_stats[idx], stats.data(), n * sizeof(TextStats));
    child_count += n;
}
/// Remove an element at a position
std::pair<NodePtr, TextStats> InnerNode::Remove(size_t idx) {
    assert(GetSize() > 0);
    assert(idx < GetSize());
    auto child_nodes = GetChildNodesBuffer();
    auto child_stats = GetChildStatsBuffer();
    auto n = child_nodes[idx];
    auto s = child_stats[idx];
    if ((idx + 1) < GetSize()) {
        auto tail = GetSize() - (idx + 1);
        std::memmove(&child_nodes[idx], &child_nodes[idx + 1], tail * sizeof(NodePtr));
        std::memmove(&child_stats[idx], &child_stats[idx + 1], tail * sizeof(TextStats));
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
    std::memmove(&child_stats[idx], &child_stats[idx + count], tail * sizeof(TextStats));
    child_count -= count;
}
/// Truncate children from a position
std::pair<std::span<const NodePtr>, std::span<const TextStats>> InnerNode::Truncate(size_t idx) noexcept {
    assert(idx <= GetSize());
    std::span<const NodePtr> tail_nodes{&GetChildNodesBuffer()[idx], GetSize() - idx};
    std::span<const TextStats> tail_stats{&GetChildStatsBuffer()[idx], GetSize() - idx};
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
    std::memcpy(right_child_stats.data(), &left_child_stats[child_idx], right.child_count * sizeof(TextStats));
    child_count = child_idx;

    LinkNodeRight(right);
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
    std::memcpy(left_child_stats.data(), right_child_stats.data(), child_idx * sizeof(TextStats));
    std::memmove(&right_child_nodes[child_idx], &right_child_nodes[0], (child_count - child_idx) * sizeof(NodePtr));
    std::memmove(&right_child_stats[child_idx], &right_child_stats[0], (child_count - child_idx) * sizeof(NodePtr));
    child_count -= child_idx;

    left.LinkNodeRight(*this);
}
/// Pushes an element onto the end of the array, and then splits it in half
void InnerNode::PushAndSplit(NodePtr child, TextStats stats, InnerNode& dst) {
    auto r_count = (GetSize() + 1) / 2;
    auto l_count = (GetSize() + 1) - r_count;
    SplitOffRight(l_count, dst);
    dst.Push(child, stats);
}
/// Inserts an element into a the array, and then splits it in half
void InnerNode::InsertAndSplit(size_t idx, NodePtr child, TextStats stats, InnerNode& other) {
    assert(GetSize() > 0);
    assert(idx <= GetSize());
    std::pair<NodePtr, TextStats> extra{child, stats};
    if (idx < GetSize()) {
        extra = Pop();
        Insert(idx, child, stats);
    }
    PushAndSplit(std::get<0>(extra), std::get<1>(extra), other);
}

/// Only balance if left and right nodes diff by more than 1/4th of the page capacity
static inline bool shouldBalanceInner(size_t capacity, size_t left, size_t right) {
    size_t diff = std::abs(static_cast<ssize_t>(left) - static_cast<ssize_t>(right));
    return (diff * 4) >= capacity;
}
/// Balance between two nodes
void InnerNode::BalanceRight(TextStats& own_info, InnerNode& right_node, TextStats& right_info) {
    if (!shouldBalanceInner(child_capacity, GetSize(), right_node.GetSize())) {
        return;
    }

    // Move children from right to left?
    if (GetSize() < right_node.GetSize()) {
        size_t move_left = (right_node.GetSize() - GetSize()) / 2;
        auto diff = right_node.AggregateTextInfoInRange(0, move_left);
        Push(right_node.GetChildNodes().subspan(0, move_left), right_node.GetChildStats().subspan(0, move_left));
        right_node.RemoveRange(0, move_left);
        own_info += diff;
        right_info -= diff;
        return;
    }

    // Move children from left to right?
    if (GetSize() > right_node.GetSize()) {
        auto move_right = (GetSize() - right_node.GetSize()) / 2;
        auto move_right_from = GetSize() - move_right;
        auto diff = AggregateTextInfoInRange(move_right_from, move_right);
        auto [move_right_nodes, move_right_stats] = Truncate(move_right_from);
        right_node.Insert(0, move_right_nodes, move_right_stats);
        own_info -= diff;
        right_info += diff;
    }
}

/// Find the first child where a predicate returns true or the last child if none qualify
template <typename Predicate> static InnerNode::Boundary Find(InnerNode& node, size_t arg, Predicate predicate) {
    auto child_stats = node.GetChildStats();
    TextStats next;
    for (size_t child_idx = 0; (child_idx + 1) < child_stats.size(); ++child_idx) {
        TextStats prev = next;
        next += child_stats[child_idx];
        if (predicate(arg, prev, next)) {
            return {child_idx, prev};
        }
    }
    assert(!child_stats.empty());
    return {child_stats.size() - 1, next};
}

/// Helper to find a child that contains a byte index
static bool ChildContainsByte(size_t byte_idx, TextStats prev, TextStats next) { return next.text_bytes > byte_idx; }
/// Helper to find a child that contains a character index
static bool ChildContainsCodepoint(size_t char_idx, TextStats prev, TextStats next) {
    return next.utf8_codepoints > char_idx;
}
/// Helper to find a child that contains a line break index
static bool ChildContainsLineBreak(size_t line_break_idx, TextStats prev, TextStats next) {
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
    std::pair<size_t, TextStats> begin, end;
    TextStats next;
    size_t child_idx = 0;
    TextStats prev;
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
Rope::Rope(size_t page_size, NodePtr root_node, TextStats root_info, LeafNode* first_leaf, size_t tree_height)
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
    other.root_info = TextStats{};
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

    // Special case, root is leaf
    if (root_node.Is<LeafNode>()) {
        NodePage right_leaf_page{page_size};
        auto* right_leaf = new (right_leaf_page.Get()) LeafNode(page_size);
        auto* left_leaf = root_node.Get<LeafNode>();
        left_leaf->SplitCharsOff(char_idx, *right_leaf);
        TextStats right_info{right_leaf->GetData()};
        root_info -= right_info;
        left_leaf->next_node = nullptr;
        right_leaf->previous_node = nullptr;
        return Rope{page_size, right_leaf_page.Release<LeafNode>(), right_info, right_leaf, 1};
    }

    // Collect nodes of right seam
    std::vector<NodePage> right_seam_pages;
    std::vector<InnerNode*> right_seam_nodes;
    right_seam_pages.reserve(tree_height);
    right_seam_nodes.reserve(tree_height);

    // We always create a new root page for the right rope.
    // Note that we *could* special-case right roots with only a single child.
    InnerNode* left_root = root_node.Get<InnerNode>();
    auto [split_idx, split_prefix] = left_root->FindCodepoint(char_idx);
    right_seam_pages.emplace_back(page_size);
    auto* right_root = new (right_seam_pages.back().Get()) InnerNode(page_size);
    left_root->SplitOffRight(split_idx, *right_root);
    ++left_root->child_count;
    right_seam_nodes.push_back(right_root);

    // Prepare the traversal
    auto* left_parent = left_root;
    auto* right_parent = right_root;
    size_t left_child_idx = split_idx;
    char_idx -= split_prefix.utf8_codepoints;
    // Make sure new left and right parents point to the same child
    assert(left_parent->GetChildNodes().back() == right_parent->GetChildNodes().front());

    // Locate leaf node and remember traversed inner nodes
    for (auto child_node = left_parent->GetChildNodes()[left_child_idx]; child_node.Is<InnerNode>();
         child_node = left_parent->GetChildNodes()[left_child_idx]) {
        // Find split point in client
        auto* child = child_node.Get<InnerNode>();
        std::tie(split_idx, split_prefix) = child->FindCodepoint(char_idx);
        char_idx -= split_prefix.utf8_codepoints;

        // Check if we can merge the left prefix with the immediate left neighbor.
        // We only merge with the left neighbor if the nodes have the same parent (to simplify updating stats).
        if (left_child_idx >= 2) {
            // Get immediate left neighbor
            auto neighbor = child->previous_node;
            assert(child->previous_node == left_parent->GetChildNodes()[left_child_idx - 1].Get<InnerNode>());
            // Left neighbor has enough space to hold (split + 1) elements?
            // (split + 1) because we have to keep the yet-to-split child node.
            if (neighbor->GetFreeSpace() >= (split_idx + 1)) {
                // Move children in [0, split_idx] to left neighbor.
                // We also move split_idx here as we want to preserve the reference on the left side (in case we need to
                // split).
                neighbor->Push(child->GetChildNodes().subspan(0, split_idx + 1),
                               child->GetChildStats().subspan(0, split_idx + 1));
                child->RemoveRange(0, split_idx);
                // Our parent level made sure to point the left parent to the shared left child.
                // We could split by just moving elements left, and therefore just have to remove the last child from
                // the left parent.
                assert(left_child_idx == (left_parent->GetSize() - 1));
                left_parent->Pop();
                // Make sure parents point to the correct nodes
                assert(left_parent->GetChildNodes().back() == NodePtr{neighbor});
                assert(right_parent->GetChildNodes().front() == NodePtr{child});
                // Update parents
                right_seam_nodes.push_back(child);
                // Continue with last node of the just moved elements
                right_parent = child;
                left_parent = neighbor;
                left_child_idx = neighbor->GetSize() - 1;
                // Make sure new left and right parents point to the same child
                assert(left_parent->GetChildNodes().back() == right_parent->GetChildNodes().front());
                continue;
            }
        }

        // Check if we can merge the left suffix with the immediate right neighbor.
        if (right_parent->GetSize() >= 2) {
            // Get immediate right neighbor
            auto neighbor = child->next_node;
            assert(right_parent->GetChildNodes()[0] == NodePtr{child});
            assert(right_parent->GetChildNodes()[1] == NodePtr{neighbor});
            // Right neighbor has enough space to hold (child_count - split_idx) elements?
            if (neighbor->GetFreeSpace() >= (child->GetSize() - split_idx)) {
                // Move children in [split_idx, end[ to right neighbor.
                auto [split_nodes, split_stats] = child->Truncate(split_idx);
                neighbor->Insert(0, split_nodes, split_stats);
                // Keep split_index alive on the left since that holds the next to-be-split node
                ++child->child_count;
                // Our parent level made sure to point the right parent to the shared left child.
                // We could split by just moving elements over, and therefore just have to remove child [0] from the
                // right parent.
                assert(right_parent->GetSize() >= 2);
                assert(right_parent->GetChildNodes()[0].Get<InnerNode>() == child);
                assert(right_parent->GetChildNodes()[1].Get<InnerNode>() == neighbor);
                right_parent->Remove(0);
                right_seam_nodes.push_back(neighbor);
                // Make sure parents point to the correct nodes
                assert(left_parent->GetChildNodes().back() == NodePtr{child});
                assert(right_parent->GetChildNodes().front() == NodePtr{neighbor});
                // Continue with last child node of current child
                right_parent = neighbor;
                left_parent = child;
                left_child_idx = split_idx;
                // Make sure new left and right parents point to the same child
                assert(left_parent->GetChildNodes().back() == right_parent->GetChildNodes().front());
                continue;
            }
        }

        // Otherwise we have to create a new inner page
        // We again increment the left child count immediately afterwards to keep split_idx referenced.
        right_seam_pages.emplace_back(page_size);
        auto* right = new (right_seam_pages.back().Get()) InnerNode(page_size);
        right_seam_nodes.push_back(right);
        right_parent->GetChildNodes().front() = right;
        right_parent->GetChildStats().front() = {};
        child->SplitOffRight(split_idx, *right);
        ++child->child_count;

        // We will update the parent & statistics later

        // Make sure parents point to the correct nodes
        assert(left_parent->GetChildNodes().back() == NodePtr{child});
        assert(right_parent->GetChildNodes().front() == NodePtr{right});

        // Traverse to child
        assert(child->GetSize() == (split_idx + 1));
        right_parent = right;
        left_parent = child;
        left_child_idx = child->GetSize() - 1;
        // Make sure new left and right parents point to the same child
        assert(left_parent->GetChildNodes().back() == right_parent->GetChildNodes().front());
    }

    /// Helper to fixup the seam nodes
    auto finish = [this](TextStats left_child_info, LeafNode* right_leaf, TextStats right_child_info,
                         std::span<InnerNode*> right_seam, std::vector<NodePage>&& right_seam_pages) {
        // Now propagate the text change up the seam nodes
        NodePtr right_child_node{right_leaf};
        for (auto seam_iter = right_seam.rbegin(); seam_iter != right_seam.rend(); ++seam_iter) {
            auto* right_parent = *seam_iter;
            auto* left_parent = right_parent->previous_node;
            // Update child stats in parents
            assert(!left_parent->GetChildNodes().empty());
            left_parent->GetChildStats().back() = left_child_info;
            right_parent->GetChildStats().front() = right_child_info;
            // Disconnect seam nodes
            left_parent->next_node = nullptr;
            right_parent->previous_node = nullptr;
            // Balance seam nodes
            BalanceChild(*left_parent, left_parent->GetSize() - 1, first_leaf);
            BalanceChild(*right_parent, 0, right_leaf);
            // Go 1 level up
            left_child_info = left_parent->AggregateTextInfo();
            right_child_node = right_parent;
            right_child_info = right_parent->AggregateTextInfo();
        }
        // Release pages
        for (auto& page : right_seam_pages) {
            page.Release();
        }
        // Update root info
        root_info -= right_child_info;
        auto right = Rope{page_size, right_child_node, right_child_info, right_leaf, tree_height};
        // Flatten both ropes
        FlattenTree();
        right.FlattenTree();
        return right;
    };

    /// Helper to split a leaf page
    auto leaf_ptr = left_parent->GetChildNodes()[left_child_idx];
    auto leaf = leaf_ptr.Get<LeafNode>();
    auto leaf_prefix_bytes = utf8::codepointToByteIdx(leaf->GetData(), char_idx);
    auto leaf_suffix_bytes = leaf->GetSize() - leaf_prefix_bytes;

    // Do we have a left leaf neighbor?
    if (left_child_idx >= 2) {
        // Get immediate left neighbor
        auto neighbor = leaf->previous_node;
        assert(leaf->previous_node == left_parent->GetChildNodes()[left_child_idx - 1].Get<LeafNode>());
        // Does the neighbor have enough space for all bytes before the split?
        if (neighbor->GetFreeSpace() >= leaf_prefix_bytes) {
            // Move data in [0, leaf_prefix_bytes[ over to the left neighbor
            auto data = leaf->GetData().subspan(0, leaf_prefix_bytes);
            TextStats diff{data};
            neighbor->PushBytes(data);
            leaf->RemoveByteRange(0, leaf_prefix_bytes);
            // Update parents
            assert(left_child_idx == (left_parent->GetSize() - 1));
            left_parent->Pop();
            right_parent->GetChildNodes()[0] = leaf;
            // Make sure parents point to the correct nodes
            assert(left_parent->GetChildNodes().back() == NodePtr{neighbor});
            assert(right_parent->GetChildNodes().front() == NodePtr{leaf});
            // Unlink nodes
            auto right_node = leaf;
            neighbor->next_node = nullptr;
            right_node->previous_node = nullptr;
            // Update text statistics
            TextStats left_info = left_parent->GetChildStats()[left_child_idx - 1] + diff;
            TextStats right_info = left_parent->GetChildStats()[left_child_idx] - diff;
            return finish(left_info, right_node, right_info, right_seam_nodes, std::move(right_seam_pages));
        }
    }

    // Do we have a right leaf neighbor?
    if (right_parent->GetSize() >= 2) {
        // Get immediate right neighbor
        auto neighbor = leaf->next_node;
        assert(right_parent->GetChildNodes()[0] == NodePtr{leaf});
        assert(right_parent->GetChildNodes()[1] == NodePtr{neighbor});
        // Does the neighbor have enough space for all bytes after the split?
        if (neighbor->GetFreeSpace() >= leaf_suffix_bytes) {
            // Move data in [leaf_suffix_bytes, end[ over to the right neighbor
            auto data = leaf->TruncateBytes(leaf_prefix_bytes);
            assert(data.size() == leaf_suffix_bytes);
            TextStats diff{data};
            neighbor->InsertBytes(0, data);
            // Remove nodes[0] of the right parent since that slot is pointing to the current child page
            assert(right_parent->GetSize() >= 2);
            assert(right_parent->GetChildNodes()[0].Get<LeafNode>() == leaf);
            assert(right_parent->GetChildNodes()[1].Get<LeafNode>() == neighbor);
            right_parent->Remove(0);
            // Make sure parents point to the correct nodes
            assert(left_parent->GetChildNodes().back() == NodePtr{leaf});
            assert(right_parent->GetChildNodes().front() == NodePtr{neighbor});
            // Unlink nodes
            auto right_node = neighbor;
            right_node->previous_node = nullptr;
            leaf->next_node = nullptr;
            // Update text statistics
            TextStats left_info = left_parent->GetChildStats()[left_child_idx] - diff;
            TextStats right_info{right_node->GetData()};
            return finish(left_info, right_node, right_info, right_seam_nodes, std::move(right_seam_pages));
        }
    }

    // Failed to move bytes to neighbors, split off a new leaf page
    NodePage right_leaf_page{page_size};
    auto* right_leaf = new (right_leaf_page.Get()) LeafNode(page_size);
    right_parent->GetChildNodes()[0] = right_leaf;
    leaf->SplitBytesOff(leaf_prefix_bytes, *right_leaf);
    // Update nodes
    leaf->next_node = nullptr;
    right_leaf->previous_node = nullptr;
    // Fix nodes of the right seam
    TextStats right_info{right_leaf->GetData()};
    TextStats left_info = left_parent->GetChildStats()[left_child_idx] - right_info;
    return finish(left_info, right_leaf_page.Release<LeafNode>(), right_info, right_seam_nodes,
                  std::move(right_seam_pages));
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
            left_leaf->LinkNodeRight(*right_leaf);
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
        left->LinkNodeRight(*right);
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
        left->LinkNodeRight(*right);
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
void Rope::PreemptiveBalanceOrSplit(InnerNode& parent, size_t& child_idx, TextStats& child_prefix, size_t char_idx) {
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
    assert(text_bytes.size() <= LeafNode::Capacity(page_size));
    TextStats insert_info{text_bytes};

    // Traversal state
    InnerNode* parent_node = nullptr;
    LeafNode* leaf_node = nullptr;
    TextStats* leaf_stats = nullptr;
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
        TextStats child_prefix;
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
    TextStats split_info{split->GetData()};
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

static constexpr size_t useBulkloadingInsert(size_t page_size, size_t text_size) { return text_size >= 6 * page_size; }

/// Insert at index
void Rope::Insert(size_t char_idx, std::string_view text) {
    // Make sure the char idx is not out of bounds
    char_idx = std::min(char_idx, root_info.utf8_codepoints);
    std::span<const std::byte> text_buffer{reinterpret_cast<const std::byte*>(text.data()), text.size()};

    // Bulk-load the text into a new rope and merge it?
    if (useBulkloadingInsert(page_size, text.size())) {
        auto right = SplitOff(char_idx);
        Append(Rope::FromString(page_size, text));
        Append(std::move(right));
        return;
    }

    // Split the input text in chunks and insert it into the rope
    while (!text_buffer.empty()) {
        auto chunk_size = std::min(LeafNode::Capacity(page_size) - 4, text_buffer.size());
        auto split_approx = text_buffer.size() - chunk_size;
        auto split_bound = utf8::findCodepoint(text_buffer, split_approx, false);
    
        auto tail = text_buffer.subspan(split_bound);
        InsertBounded(char_idx, tail);
        text_buffer = text_buffer.subspan(0, split_bound);
    }
}

/// Create a rope from a string
Rope Rope::FromString(size_t page_size, std::string_view text, size_t leaf_capacity, size_t inner_capacity) {
    // Short-circuit case where the input text is empty
    if (text.empty()) {
        return Rope{page_size};
    }
    leaf_capacity = std::min(LeafNode::Capacity(page_size), leaf_capacity);
    inner_capacity = std::min(InnerNode::Capacity(page_size), inner_capacity);

    // Create leaf nodes
    std::vector<NodePage> leafs;
    leafs.reserve((text.size() + leaf_capacity - 1) / leaf_capacity);
    LeafNode* prev_leaf = nullptr;
    while (!text.empty()) {
        leafs.emplace_back(page_size);
        auto new_leaf = LeafNode::FromString(leafs.back(), text, leaf_capacity);

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
        auto root_info = TextStats{leaf_node->GetData()};
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
        auto n = std::min(leafs.size() - begin, inner_capacity);
        for (auto i = 0; i < n; ++i) {
            auto leaf = leafs[begin + i].Get<LeafNode>();
            next->GetChildNodesBuffer()[i] = NodePtr{leaf};
            next->GetChildStatsBuffer()[i] = TextStats{leaf->GetData()};
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
            auto n = std::min(level_end - begin, inner_capacity);
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

/// Balance a child
void Rope::BalanceChild(InnerNode& parent, size_t child_idx, LeafNode*& first_leaf) {
    assert(child_idx < parent.GetSize());
    auto child_infos = parent.GetChildStats();
    auto child_nodes = parent.GetChildNodes();

    // Is a leaf node?
    if (child_nodes[child_idx].Is<LeafNode>()) {
        // Easy case, leaf is empty, just remove it
        auto* child_node = child_nodes[child_idx].Get<LeafNode>();
        auto& child_info = child_infos[child_idx];
        if (child_node->IsEmpty()) {
            if (child_node == first_leaf) {
                first_leaf = child_node->next_node;
            }
            parent.Remove(child_idx);
            child_node->UnlinkNode();
            delete[] reinterpret_cast<std::byte*>(child_node);
            return;
        }

        // Neighbor capacity
        size_t neighbor_count = 0, neighbor_free = 0;
        LeafNode *left_node = nullptr, *right_node = nullptr;
        TextStats *left_info = nullptr, *right_info = nullptr;
        if (child_idx >= 2) {
            left_node = child_nodes[child_idx - 1].Get<LeafNode>();
            left_info = &child_infos[child_idx - 1];
            ++neighbor_count;
            neighbor_free += left_node->GetFreeSpace();
        }
        if ((child_idx + 1) < parent.GetSize()) {
            right_node = child_nodes[child_idx + 1].Get<LeafNode>();
            right_info = &child_infos[child_idx + 1];
            ++neighbor_count;
            neighbor_free += right_node->GetFreeSpace();
        }

        // Can get rid of child?
        if (neighbor_free >= child_node->GetSize() && child_node != first_leaf) {
            size_t move_left = 0, move_right = 0;
            if (left_node) {
                move_left = std::min<size_t>(
                    child_node->GetSize(),
                    std::min<size_t>((child_node->GetSize() + 1) / neighbor_count, left_node->GetFreeSpace()));
                auto move_left_data = child_node->GetData().subspan(0, move_left);
                left_node->PushBytes(move_left_data);
                *left_info += TextStats{move_left_data};
            }
            if (right_node) {
                move_right = child_node->GetSize() - move_left;
                assert(move_right <= right_node->GetFreeSpace());
                auto move_right_data = child_node->GetData().subspan(move_left, move_right);
                right_node->InsertBytes(0, move_right_data);
                *right_info += TextStats{move_right_data};
            }
            if (child_node == first_leaf) {
                first_leaf = child_node->next_node;
            }
            assert((move_left + move_right) == child_node->GetSize());
            parent.Remove(child_idx);
            child_node->UnlinkNode();
            delete[] reinterpret_cast<std::byte*>(child_node);
            return;
        }

        // Balance children
        if (left_node) {
            if (right_node) {
                left_node->BalanceCharsRight(*left_info, *child_node, child_info);
                left_node->BalanceCharsRight(*left_info, *right_node, *right_info);
                child_node->BalanceCharsRight(child_info, *right_node, *right_info);
            } else {
                left_node->BalanceCharsRight(*left_info, *child_node, child_info);
            }
        } else if (right_node) {
            child_node->BalanceCharsRight(child_info, *right_node, *right_info);
        }
    } else {
        // Easy case, inner is empty, just remove it
        auto* child_node = child_nodes[child_idx].Get<InnerNode>();
        auto& child_info = child_infos[child_idx];
        if (child_node->IsEmpty()) {
            parent.Remove(child_idx);
            child_node->UnlinkNode();
            delete[] reinterpret_cast<std::byte*>(child_node);
            return;
        }

        // Neighbor capacity
        size_t neighbor_count = 0, neighbor_free = 0;
        InnerNode *left_node = nullptr, *right_node = nullptr;
        TextStats *left_info = nullptr, *right_info = nullptr;
        if (child_idx >= 2) {
            left_node = child_nodes[child_idx - 1].Get<InnerNode>();
            left_info = &child_infos[child_idx - 1];
            ++neighbor_count;
            neighbor_free += left_node->GetFreeSpace();
        }
        if ((child_idx + 1) < parent.GetSize()) {
            right_node = child_nodes[child_idx + 1].Get<InnerNode>();
            right_info = &child_infos[child_idx + 1];
            ++neighbor_count;
            neighbor_free += right_node->GetFreeSpace();
        }

        // Can get rid of child?
        if (neighbor_free >= child_node->GetSize()) {
            size_t move_left = 0, move_right = 0;
            if (left_node) {
                move_left = std::min<size_t>(
                    child_node->GetSize(),
                    std::min<size_t>((child_node->GetSize() + 1) / neighbor_count, left_node->GetFreeSpace()));
                auto move_left_nodes = child_node->GetChildNodes().subspan(0, move_left);
                auto move_left_stats = child_node->GetChildStats().subspan(0, move_left);
                left_node->Push(move_left_nodes, move_left_stats);
                *left_info += child_node->AggregateTextInfoInRange(0, move_left);
            }
            if (right_node) {
                move_right = child_node->GetSize() - move_left;
                assert(move_right <= right_node->GetFreeSpace());
                auto move_right_nodes = child_node->GetChildNodes().subspan(move_left, move_right);
                auto move_right_stats = child_node->GetChildStats().subspan(move_left, move_right);
                right_node->Insert(0, move_right_nodes, move_right_stats);
                *right_info += child_node->AggregateTextInfoInRange(move_left, move_right);
            }
            assert((move_left + move_right) == child_node->GetSize());
            parent.Remove(child_idx);
            child_node->UnlinkNode();
            delete[] reinterpret_cast<std::byte*>(child_node);
            return;
        }

        // Balance children
        if (left_node) {
            if (right_node) {
                left_node->BalanceRight(*left_info, *child_node, child_info);
                left_node->BalanceRight(*left_info, *right_node, *right_info);
                child_node->BalanceRight(child_info, *right_node, *right_info);
            } else {
                left_node->BalanceRight(*left_info, *child_node, child_info);
            }
        } else if (right_node) {
            child_node->BalanceRight(child_info, *right_node, *right_info);
        }
    }
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
        TextStats *lower_info, *upper_info;
        TextStats lower_deleted, upper_deleted;
        size_t lower_child_idx, upper_child_idx;
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
            .lower_child_idx = 0,
            .upper_child_idx = 0,
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

            // Update registered bounds
            inner_bounds.back().lower_deleted += deleted_info;
            inner_bounds.back().lower_child_idx = next_lower_idx;
            inner_bounds.back().upper_child_idx = next_upper_idx - deleted_count;

            // Traverse down to next
            assert(next_lower_idx < lower_inner->GetSize());
            assert((next_upper_idx - deleted_count) < upper_inner->GetSize());
            lower_node = lower_inner->GetChildNodes()[next_lower_idx];
            lower_info = &lower_inner->GetChildStats()[next_lower_idx];
            lower_char_idx -= next_lower_prefix.utf8_codepoints;
            upper_node = upper_inner->GetChildNodes()[next_upper_idx - deleted_count];
            upper_info = &upper_inner->GetChildStats()[next_upper_idx - deleted_count];
            upper_char_idx -= next_upper_prefix.utf8_codepoints;
        } else {
            // First, find the next left and right boundaries
            auto [next_lower_idx, next_lower_prefix] = lower_inner->FindCodepoint(lower_char_idx);
            auto [next_upper_idx, next_upper_prefix] = upper_inner->FindCodepoint(upper_char_idx);

            // Delete suffix of lower bound
            auto lower_suffix_length = lower_inner->GetSize() - (next_lower_idx + 1);
            auto lower_deleted = lower_inner->AggregateTextInfoInRange(next_lower_idx + 1, lower_suffix_length);
            lower_inner->Truncate(next_lower_idx + 1);
            inner_bounds.back().lower_deleted += lower_deleted;
            inner_bounds.back().lower_child_idx = lower_inner->GetSize() - 1;

            // Delete prefix of upper bound
            auto upper_deleted = upper_inner->AggregateTextInfoInRange(0, next_upper_idx);
            upper_inner->RemoveRange(0, next_upper_idx);
            inner_bounds.back().upper_deleted += upper_deleted;
            inner_bounds.back().upper_child_idx = 0;

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
            assert(next_lower_idx == (lower_inner->GetChildNodes().size() - 1));
            assert((upper_inner->GetChildNodes().size() >= 1));
            lower_node = lower_inner->GetChildNodes().back();
            lower_info = &lower_inner->GetChildStats().back();
            lower_char_idx -= next_lower_prefix.utf8_codepoints;
            upper_node = upper_inner->GetChildNodes().front();
            upper_info = &upper_inner->GetChildStats().front();
            upper_char_idx -= next_upper_prefix.utf8_codepoints;
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
            // It's enough to just balance the lower node since we hit the same leaf
            assert(iter->lower_node == iter->upper_node);
            assert(iter->lower_child_idx == iter->upper_child_idx);
            BalanceChild(*iter->lower_node, iter->lower_child_idx, first_leaf);
        }
    } else {
        // Adjust boundaries
        TextStats lower_deleted = lower_leaf->TruncateChars(lower_char_idx);
        TextStats upper_deleted = upper_leaf->RemoveCharRange(0, upper_char_idx);

        // Blindly delete all nodes in between
        for (auto neighbor = lower_leaf->next_node; neighbor != upper_leaf;) {
            auto next = neighbor->next_node;
            delete[] reinterpret_cast<std::byte*>(neighbor);
            neighbor = next;
        }
        lower_leaf->next_node = upper_leaf;
        upper_leaf->previous_node = lower_leaf;
        (*lower_info) -= lower_deleted;
        (*upper_info) -= upper_deleted;

        // Propagate statistics upwards
        for (auto iter = inner_bounds.rbegin(); iter != inner_bounds.rend(); ++iter) {
            lower_deleted += iter->lower_deleted;
            upper_deleted += iter->upper_deleted;
            (*iter->lower_info) -= lower_deleted;
            (*iter->upper_info) -= upper_deleted;

            // Balance children
            if (iter->lower_node == iter->upper_node && iter->lower_child_idx == iter->upper_child_idx) {
                BalanceChild(*iter->lower_node, iter->lower_child_idx, first_leaf);
            } else {
                // Balance upper node first since we might interfere with lower
                BalanceChild(*iter->upper_node, iter->upper_child_idx, first_leaf);
                BalanceChild(*iter->lower_node, iter->lower_child_idx, first_leaf);
            }
        }
    }
    // Flatten the tree
    FlattenTree();
}

void Rope::FlattenTree() {
    while (root_node.Is<InnerNode>()) {
        auto inner = root_node.Get<InnerNode>();
        if (inner->GetSize() > 1) {
            return;
        }
        if (inner->IsEmpty()) {
            delete[] reinterpret_cast<std::byte*>(inner);
            NodePage first_page{page_size};
            first_leaf = new (first_page.Get()) LeafNode(page_size);
            root_node = {first_leaf};
            root_info = {};
            tree_height = 1;
            first_page.Release();
            return;
        }
        assert(inner->GetSize() == 1);
        assert(root_info.utf8_codepoints == inner->GetChildStats()[0].utf8_codepoints);
        root_node = inner->GetChildNodes()[0];
        --tree_height;
        delete[] reinterpret_cast<std::byte*>(inner);
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
        TextStats expected;
        size_t level;
    };
    std::vector<Validation> pending;
    pending.reserve(10 * tree_height);
    pending.push_back(Validation{.node = root_node, .expected = root_info, .level = 0});
    size_t max_level = 0;
    while (!pending.empty()) {
        auto top = pending.back();
        pending.pop_back();
        max_level = std::max(top.level, max_level);

        // Is a leaf node?
        if (top.node.Is<LeafNode>()) {
            auto leaf = top.node.Get<LeafNode>();
            validate(leaf == root_node || !leaf->IsEmpty(), "leaf node is empty");
            TextStats have{leaf->GetData()};
            validate(top.expected.text_bytes == have.text_bytes, "leaf text bytes mismatch");
            validate(top.expected.line_breaks == have.line_breaks, "leaf line breaks mismatch");
            validate(top.expected.utf8_codepoints == have.utf8_codepoints, "leaf utf8 codepoint mismatch");
        } else {
            // Is an inner node
            auto inner = top.node.Get<InnerNode>();
            validate(!inner->IsEmpty(), "inner node is empty");
            TextStats have = inner->AggregateTextInfo();
            validate(top.expected.text_bytes == have.text_bytes, "inner text bytes mismatch");
            validate(top.expected.line_breaks == have.line_breaks, "inner line breaks mismatch");
            validate(top.expected.utf8_codepoints == have.utf8_codepoints, "inner utf8 codepoint mismatch");
            for (size_t i = 0; i < inner->child_count; ++i) {
                auto nodes = inner->GetChildNodes();
                auto stats = inner->GetChildStats();
                pending.push_back(Validation{
                    .node = nodes[i],
                    .expected = stats[i],
                    .level = top.level + 1,
                });
            }
        }
    }
    validate(tree_height == (max_level + 1), "tree height mismatch");
}

}  // namespace flatsql::rope
