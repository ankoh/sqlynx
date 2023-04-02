#include "flatsql/text/rope.h"

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
void LeafNode::RemoveByteRange(size_t start_byte_idx, size_t end_byte_idx) noexcept {
    assert(start_byte_idx <= end_byte_idx);
    assert(end_byte_idx <= GetSize());
    assert(utf8::isCodepointBoundary(GetData(), start_byte_idx));
    assert(utf8::isCodepointBoundary(GetData(), end_byte_idx));

    auto buffer = GetDataBuffer();
    std::memmove(&buffer[start_byte_idx], &buffer[end_byte_idx], GetSize() - end_byte_idx);
    buffer_size -= end_byte_idx - start_byte_idx;
}
/// Remove text in range
TextInfo LeafNode::RemoveCharRange(size_t start_idx, size_t end_idx) noexcept {
    auto byte_start = utf8::codepointToByteIdx(GetData(), start_idx);
    auto byte_end = byte_start + utf8::codepointToByteIdx(GetData().subspan(byte_start), end_idx - start_idx);
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
    assert((GetCapacity() - GetSize()) <= nodes.size());
    std::memcpy(GetChildNodesBuffer().data() + GetSize(), nodes.data(), nodes.size() * sizeof(NodePtr));
    std::memcpy(GetChildNodesBuffer().data() + GetSize(), stats.data(), nodes.size() * sizeof(TextInfo));
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
//        if (child_node_1.Is<LeafNode>()) {
//            assert(child_node_2.Is<LeafNode>());
//            LeafNode* child_1 = child_node_1.Get<LeafNode>();
//            LeafNode* child_2 = child_node_2.Get<LeafNode>();
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
//            assert(child_node_1.Is<InnerNode>());
//            assert(child_node_2.Is<InnerNode>());
//            InnerNode* child_1 = child_node_1.Get<InnerNode>();
//            InnerNode* child_2 = child_node_2.Get<InnerNode>();
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
void InnerNode::Balance(size_t idx1, size_t idx2) {}
/// If the children are leaf nodes, compacts them to take up the fewest nodes
void InnerNode::CompactLeafs() {}

using Child = std::pair<size_t, TextInfo>;
/// Find the first child where a predicate returns true or the last child if none qualify
template <typename Predicate> static Child Find(InnerNode& node, size_t arg, Predicate predicate) {
    auto child_stats = node.GetChildStats();
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
std::pair<size_t, size_t> InnerNode::FindByte(size_t byte_idx) {
    auto [child, stats] = Find(*this, byte_idx, ChildContainsByte);
    return {child, stats.text_bytes};
}
/// Find the child that contains a character
std::pair<size_t, size_t> InnerNode::FindCodepoint(size_t char_idx) {
    auto [child, stats] = Find(*this, char_idx, ChildContainsCodepoint);
    return {child, stats.utf8_codepoints};
}
/// Find the child that contains a line break
std::pair<size_t, size_t> InnerNode::FindLineBreak(size_t line_break_idx) {
    auto [child, stats] = Find(*this, line_break_idx, ChildContainsLineBreak);
    return {child, stats.line_breaks};
}

/// Find a range where two predicate return true
template <typename Predicate>
static std::pair<Child, Child> FindRange(InnerNode& node, size_t arg0, size_t arg1, Predicate predicate) {
    auto child_stats = node.GetChildStats();
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

/// Constructor
Rope::Rope(size_t page_size, NodePtr root_node, TextInfo root_info, LeafNode* first_leaf)
    : page_size(page_size), root_node(root_node), root_info(root_info), first_leaf(first_leaf) {}
/// Constructor
Rope::Rope(size_t page_size) : page_size(page_size) {
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
/// Move constructor
Rope::Rope(Rope&& other)
    : page_size(other.page_size), root_node(other.root_node), root_info(other.root_info), first_leaf(other.first_leaf) {
    other.root_node = {};
    other.root_info = TextInfo{};
    other.first_leaf = nullptr;
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
    while (!next_node.Is<LeafNode>()) {
        // Find child with codepoint
        InnerNode* next_as_inner = next_node.Get<InnerNode>();
        auto [child_idx, child_prefix_chars] = next_as_inner->FindCodepoint(char_idx);
        inner_path.push_back(VisitedInnerNode{.node_info = next_stats, .node = next_as_inner, .child_idx = child_idx});

        // Continue with child
        next_node = next_as_inner->GetChildNodes()[child_idx];
        next_stats = &next_as_inner->GetChildStats()[child_idx];
        char_idx -= child_prefix_chars;
        assert(!next_node.IsNull());
    }

    // Edit when reached leaf
    LeafNode* leaf_node = next_node.Get<LeafNode>();

    // Create leaf node
    NodePage new_leaf_page{page_size};
    auto new_leaf = new (new_leaf_page.Get()) LeafNode(page_size);
    leaf_node->SplitCharsOff(char_idx, *new_leaf);
    leaf_node->next_node = nullptr;
    new_leaf->previous_node = nullptr;
    TextInfo child_stats{new_leaf->GetData()};
    NodePtr child_node{new_leaf};

    // Create new inner nodes
    std::vector<NodePage> new_inners;
    new_inners.reserve(inner_path.getSize());
    for (auto iter = inner_path.rbegin(); iter != inner_path.rend(); ++iter) {
        new_inners.emplace_back(page_size);
        auto* right = new (new_inners.back().Get()) InnerNode(page_size);
        auto* left = iter->node;
        left->SplitOffRight(iter->child_idx, *right);
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
void Rope::Append(Rope right_rope) {
    // Append works as follows:
    // Let's assume we want to append the second rope to the first one:
    //
    // Level 2     Inner
    // Level 1     Inner   Inner
    // Level 0     Leaf    Leaf
    //
    // A) We first collect all nodes along the "seam" between the ropes.
    //    That means we collect the right-most nodes of the left side and the left-most nodes of the right side.
    // B) We then link the shared levels as if they would belong to the same tree.
    // C) If both ropes have the same height, merge the roots or create a new one
    // E) Otherwise the root of the "smaller" rope is inserted into the top of the "larger" rope.
    //    This may lead to splits.

    // A.1) Collect the last nodes of the left side
    struct VisitedInnerNode {
        TextInfo* node_info;
        InnerNode* node;
    };
    auto& left_rope = *this;
    SmallVector<VisitedInnerNode, 8> left_seam;
    auto iter_node = left_rope.root_node;
    auto iter_stats = &left_rope.root_info;
    while (!iter_node.Is<LeafNode>()) {
        // Get last child
        InnerNode* next_as_inner = iter_node.Get<InnerNode>();
        left_seam.push_back(VisitedInnerNode{.node_info = iter_stats, .node = next_as_inner});
        assert(!next_as_inner->IsEmpty());

        // Continue with child
        auto last = next_as_inner->GetSize();
        iter_node = next_as_inner->GetChildNodes()[last];
        iter_stats = &next_as_inner->GetChildStats()[last];
        assert(!iter_node.IsNull());
    }
    LeafNode* left_last_leaf = iter_node.Get<LeafNode>();

    // A.2) Collect the first nodes of the right side
    SmallVector<VisitedInnerNode, 8> right_seam;
    iter_node = right_rope.root_node;
    iter_stats = &right_rope.root_info;
    while (!iter_node.Is<LeafNode>()) {
        // Get first child
        InnerNode* next_as_inner = iter_node.Get<InnerNode>();
        left_seam.push_back(VisitedInnerNode{.node_info = iter_stats, .node = next_as_inner});
        assert(!next_as_inner->IsEmpty());

        // Continue with child
        iter_node = next_as_inner->GetChildNodes()[0];
        iter_stats = &next_as_inner->GetChildStats()[0];
        assert(!iter_node.IsNull());
    }

    // B.1) Link leaf nodes
    left_last_leaf->next_node = right_rope.first_leaf;
    right_rope.first_leaf->previous_node = left_last_leaf->next_node;

    // B.2) Connect seam nodes
    auto left_seam_path = left_seam.span();
    auto right_seam_path = right_seam.span();
    size_t seam_size = std::min<size_t>(left_seam_path.size(), right_seam_path.size());
    for (size_t i = 0; i < seam_size; ++i) {
        size_t left_height = left_seam_path.size();
        size_t right_height = left_seam_path.size();
        left_seam_path[left_height - i - 1].node->next_node = right_seam_path[left_height - i - 1].node;
        right_seam_path[right_height - i - 1].node->previous_node = left_seam_path[right_height - i - 1].node;
    }

    // C) Handle special case where both ropes have the same height
    if (left_seam_path.size() && right_seam_path.size()) {
        assert(left_rope.root_node.Is<LeafNode>() == right_rope.root_node.Is<LeafNode>());
        // Merge the roots if they have enough free space
        if (left_rope.root_node.Is<LeafNode>()) {
            if (left_rope.first_leaf->GetFreeSpace() >= right_rope.first_leaf->GetSize()) {
                left_rope.root_info += right_rope.root_info;
                left_rope.first_leaf->PushBytes(right_rope.first_leaf->TruncateBytes());
                right_rope.root_node = {};
                return;
            }
        } else {
            auto left_inner = left_rope.root_node.Get<InnerNode>();
            auto right_inner = left_rope.root_node.Get<InnerNode>();
            if (left_inner->GetFreeSpace() >= right_inner->GetSize()) {
                left_rope.root_info += right_rope.root_info;
                auto [right_nodes, right_stats] = right_inner->Truncate();
                left_inner->Push(right_nodes, right_stats);
                right_rope.root_node = {};
                return;
            }
        }

        // Otherwise create a new parent for both
        NodePage new_root_page{page_size};
        auto new_root = new (new_root_page.Get()) InnerNode(page_size);
        new_root->Push(left_rope.root_node, left_rope.root_info);
        new_root->Push(right_rope.root_node, right_rope.root_info);
        auto new_root_info = new_root->AggregateTextInfo();

        // Store new root into left rope
        left_rope.root_node = new_root_page.Release<InnerNode>();
        left_rope.root_info = new_root_info;
        right_rope.root_node = {};
        return;
    }

    // D.1) Collect nodes at the top of the "taller" rope where we have to insert the child of the "smaller" rope.
    //      The root of the "smaller" rope is in the following called "orphan".
    std::span<VisitedInnerNode> top_path;
    auto right_is_orphan = true;
    NodePtr next_root_node;
    TextInfo next_root_info;
    NodePtr orphan_node;
    TextInfo orphan_info;
    if (left_seam_path.size() >= right_seam_path.size()) {
        // Left rope is deeper then right rope?
        top_path = left_seam_path.subspan(0, left_seam_path.size() - seam_size);
        next_root_node = left_rope.root_node;
        next_root_info = left_rope.root_info;
        orphan_node = right_rope.root_node;
        orphan_info = right_rope.root_info;
    } else {
        // Right rope is deeper than left rope
        top_path = right_seam_path.subspan(0, right_seam_path.size() - seam_size);
        right_is_orphan = false;
        next_root_node = right_rope.root_node;
        next_root_info = right_rope.root_info;
        orphan_node = left_rope.root_node;
        orphan_info = left_rope.root_info;
    }
    assert(!top_path.empty());

    // D.2) Now insert the orphan root into the larger side and propagate splits
    for (auto iter = top_path.rbegin(); iter != top_path.rend(); ++iter) {
        // Parent is not full?
        // Then we can just insert the orphan and we're done!
        auto node = iter->node;
        if (!node->IsFull()) {
            // If the right rope is our orphan, we push to the left
            if (right_is_orphan) {
                node->Push(orphan_node, orphan_info);
            } else {
                // If the left rope is our orphan, we prepend to the right
                node->Insert(0, orphan_node, orphan_info);
            }
            // Reset the orphan to signal that we're done
            orphan_node = {};
            break;
        }
        // We need to split the top
        NodePage split_page{page_size};
        auto split = new (split_page.Get()) InnerNode(page_size);
        // If the right rope is our orphan, we split off the right side of the left node to preserve the
        // left node pointer.
        if (right_is_orphan) {
            node->SplitOffRight(node->GetSize() / 2, *split);
            split->Push(orphan_node, orphan_info);
        } else {
            // If the left rope is our orphan, we split off the left side of the right node to preserve the
            // right node pointer 
            node->SplitOffLeft(node->GetSize() / 2, *split);
            split->Insert(0, orphan_node, orphan_info);
        }
        orphan_info = split->AggregateTextInfo();
        orphan_node = split_page.Release<InnerNode>();
    }

    // D.3) Create a new root if the split propagated fully upwards
    if (orphan_node.IsNull()) {
        NodePage new_root_page{page_size};
        auto new_root = new (new_root_page.Get()) InnerNode(page_size);
        if (right_is_orphan) {
            new_root->Push(next_root_node, next_root_info);
            new_root->Push(orphan_node, orphan_info);
        } else {
            new_root->Push(orphan_node, orphan_info);
            new_root->Push(next_root_node, next_root_info);
        }
        next_root_info = new_root->AggregateTextInfo();
        next_root_node = new_root_page.Release<InnerNode>();
    }

    // Synchronize the roots
    left_rope.root_info = next_root_info;
    left_rope.root_node = next_root_node;
    right_rope.root_node = {};
    right_rope.root_info = {};
}

/// Insert a small text at index.
/// The text to be inserted must not exceed the size of leaf page.
/// That guarantees that we need at most one split.
void Rope::InsertBounded(size_t char_idx, std::span<const std::byte> text_bytes) {
    assert(text_bytes.size() <= LeafCapacity(page_size));
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
    while (!next_node.Is<LeafNode>()) {
        // Find child with codepoint
        InnerNode* next_as_inner = next_node.Get<InnerNode>();
        auto [child_idx, child_prefix_chars] = next_as_inner->FindCodepoint(char_idx);
        inner_path.push_back(VisitedInnerNode{.node_info = next_stats, .node = next_as_inner, .child_idx = child_idx});

        // Continue with child
        next_node = next_as_inner->GetChildNodes()[child_idx];
        next_stats = &next_as_inner->GetChildStats()[child_idx];
        char_idx -= child_prefix_chars;
        assert(!next_node.IsNull());
    }

    // Edit when reached leaf
    LeafNode* leaf_node = next_node.Get<LeafNode>();
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
    NodePage new_leaf_page{page_size};
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
        NodePage new_inner_page{page_size};
        auto new_inner = new (new_inner_page.Get()) InnerNode(page_size);
        prev_visit.node->InsertAndSplit(prev_visit.child_idx + 1, split_node, split_info, *new_inner);
        split_info = new_inner->AggregateTextInfo();
        split_node = NodePtr{new_inner_page.Release<InnerNode>()};
        *prev_visit.node_info = *prev_visit.node_info + insert_info - split_info;
    }

    // Is not null, then we have to split the root!
    if (!split_node.IsNull()) {
        NodePage new_root_page{page_size};
        auto new_root = new (new_root_page.Get()) InnerNode(page_size);
        new_root->Push(root_node, root_info);
        new_root->Push(split_node, split_info);
        root_info = new_root->AggregateTextInfo();
        root_node = new_root_page.Release<InnerNode>();
    }
}

/// Insert at index
void Rope::Insert(size_t char_idx, std::string_view text) {
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
        auto split_idx = utf8::findCodepoint(text_buffer, std::min(LeafCapacity(page_size) - 4, text.size()), false);
        auto tail = text_buffer.subspan(split_idx);
        text = text.substr(0, split_idx);
        InsertBounded(char_idx, tail);
    }
}

/// Create a rope from a string
Rope Rope::FromString(size_t page_size, std::string_view text) {
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
        Rope rope{page_size, NodePtr{leaf_node}, root_info, leaf_node};
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
    Rope rope{page_size, NodePtr{root_inner_node}, root_info, first_leaf};

    for (auto& leaf : leafs) {
        leaf.Release();
    }
    for (auto& inner : inners) {
        inner.Release();
    }
    return rope;
}

}  // namespace flatsql::rope
