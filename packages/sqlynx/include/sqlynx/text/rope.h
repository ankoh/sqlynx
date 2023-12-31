#pragma once

#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <span>
#include <string_view>
#include <type_traits>

#include "sqlynx/text/utf8.h"

namespace sqlynx {
namespace rope {

struct Rope;
struct LeafNode;
struct InnerNode;

struct TextStats {
    /// The text bytes
    size_t text_bytes = 0;
    /// The UTF-8 codepoints
    size_t utf8_codepoints = 0;
    /// The line breaks
    size_t line_breaks = 0;

    /// Constructor
    TextStats();
    /// Constructor
    TextStats(std::span<std::byte> data);
    /// Constructor
    TextStats(std::span<const std::byte> data);
    /// Addition
    TextStats operator+(const TextStats& other);
    /// Addition
    TextStats& operator+=(const TextStats& other);
    /// Subtraction
    TextStats operator-(const TextStats& other);
    /// Subtraction
    TextStats& operator-=(const TextStats& other);
};

struct NodePage {
   protected:
    /// The page size
    size_t page_size;
    /// The page
    std::unique_ptr<std::byte[]> page;

   public:
    /// Constructor
    explicit NodePage(size_t page_size)
        : page_size(page_size), page(std::unique_ptr<std::byte[]>(new std::byte[page_size])) {}

    /// Get the page size
    inline size_t GetPageSize() { return page_size; }
    /// Cast leaf pointer
    template <typename T = void> T* Get() { return reinterpret_cast<T*>(page.get()); }
    /// Release leaf pointer
    template <typename T = void> T* Release() { return reinterpret_cast<T*>(page.release()); }
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
    inline uint8_t GetTag() const { return raw_ptr & 0b1; };
    /// Is null?
    inline bool IsNull() const { return raw_ptr == 0; };
    /// Node type check
    template <typename T> bool Is() { return GetTag() == T::NodePtrTag; }
    /// Cast a node
    template <typename T> T* Get() {
        assert(Is<T>());
        return reinterpret_cast<T*>((raw_ptr >> 1) << 1);
    }
    /// Comparison operator
    bool operator==(const NodePtr& other) const { return raw_ptr == other.raw_ptr; }
};

struct LeafNode {
    friend struct Rope;
    static constexpr size_t NodePtrTag = 0;
    static constexpr size_t Capacity(size_t page_size) { return page_size - 2 * sizeof(void*) - 2 * sizeof(uint32_t); }

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
    inline std::span<std::byte> GetDataBuffer() noexcept {
        auto buffer = reinterpret_cast<std::byte*>(this + 1);
        return {buffer, buffer_capacity};
    }

   public:
    /// Constructor
    explicit LeafNode(uint32_t page_size);

    /// Get the next node
    inline auto GetNext() noexcept { return next_node; }
    /// Get the capacity of the buffer
    inline auto GetCapacity() noexcept { return buffer_capacity; }
    /// Get the size of the buffer
    inline auto GetSize() noexcept { return buffer_size; }
    /// Get the free space of the buffer
    inline auto GetFreeSpace() noexcept { return buffer_capacity - buffer_size; }
    /// Get the data
    inline auto GetData() noexcept { return GetDataBuffer().subspan(0, buffer_size); }
    /// Get buffer content as string
    inline auto GetStringView() noexcept {
        return std::string_view{reinterpret_cast<char*>(GetData().data()), GetSize()};
    }
    /// Is valid?
    inline auto IsValid() noexcept { return utf8::isCodepointBoundary(GetData(), 0); }
    /// Is the node empty?
    inline auto IsEmpty() noexcept { return GetSize() == 0; }
    /// Reset the node
    inline auto Reset() noexcept { buffer_size = 0; }

    /// Link a node
    void LinkNodeRight(LeafNode& other);
    /// Unlink a node
    void UnlinkNode();

    /// Insert raw bytes at an offset
    void InsertBytes(size_t ofs, std::span<const std::byte> data) noexcept;
    /// Appends a string to the end of the buffer
    void PushBytes(std::span<const std::byte> str) noexcept;

    /// Remove text in range
    void RemoveByteRange(size_t start_byte_idx, size_t byte_count) noexcept;
    /// Remove text in range
    TextStats RemoveCharRange(size_t start_idx, size_t end_idx) noexcept;
    /// Removes text after byte_idx
    std::span<std::byte> TruncateBytes(size_t byte_idx = 0) noexcept;
    /// Removes text after char_idx
    std::span<std::byte> TruncateChars(size_t char_idx = 0) noexcept;
    /// Splits bytes at index
    void SplitBytesOff(size_t byte_idx, LeafNode& right) noexcept;
    /// Split chars at index
    void SplitCharsOff(size_t char_idx, LeafNode& right) noexcept;

    /// Inserts `string` at `byte_idx` and splits the resulting string in half.
    /// Only splits on code point boundaries, so if the whole string is a single code point the right node will be
    /// empty.
    void InsertBytesAndSplit(size_t byte_idx, std::span<const std::byte> str, LeafNode& right);
    /// Appends a string and splits the resulting string in half.
    /// Only splits on code point boundaries, so if the whole string is a single code point,
    /// the split will fail and the returned string will be empty.
    void PushBytesAndSplit(std::span<const std::byte> str, LeafNode& right);

    /// Distribute characters equally between nodes
    void BalanceCharsRight(TextStats& own_info, LeafNode& right_node, TextStats& right_info, bool force = false);

    /// Create a leaf node from a string
    static LeafNode* FromString(NodePage& page, std::string_view& text,
                                size_t leaf_capacity = std::numeric_limits<size_t>::max());
};

struct InnerNode {
    friend struct Rope;
    static constexpr size_t NodePtrTag = 1;
    static constexpr size_t Capacity(size_t page_size) {
        return (page_size - 2 * sizeof(void*) - 2 * sizeof(uint32_t) - 8) / (sizeof(TextStats) + sizeof(NodePtr));
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
    inline std::span<TextStats> GetChildStatsBuffer() noexcept {
        return {reinterpret_cast<TextStats*>(this + 1), child_capacity};
    }
    /// Get the child nodes buffer
    inline std::span<NodePtr> GetChildNodesBuffer() noexcept {
        return {reinterpret_cast<NodePtr*>(GetChildStatsBuffer().data() + child_capacity), child_capacity};
    }

   public:
    /// Constructor
    explicit InnerNode(size_t page_size);

    /// Get the capacity of the node
    inline size_t GetCapacity() noexcept { return child_capacity; }
    /// Get the size of the node
    inline size_t GetSize() noexcept { return child_count; }
    /// Get the free space in the node
    inline size_t GetFreeSpace() noexcept { return child_capacity - child_count; }
    /// Get the statistics
    inline auto GetChildStats() noexcept { return GetChildStatsBuffer().subspan(0, GetSize()); }
    /// Get child nodes
    inline auto GetChildNodes() noexcept { return GetChildNodesBuffer().subspan(0, GetSize()); }
    /// Is the node empty?
    inline auto IsEmpty() noexcept { return GetSize() == 0; }
    /// Is the node full?
    inline auto IsFull() noexcept { return GetSize() >= GetCapacity(); }

    using Boundary = std::pair<size_t, TextStats>;
    /// Find the child that contains a byte index
    Boundary FindByte(size_t byte_idx);
    /// Find the child that contains a character
    Boundary FindCodepoint(size_t char_idx);
    /// Find the child that contains a line break
    Boundary FindLineBreak(size_t line_break_idx);
    /// Find the children that contain a codepoint range
    std::pair<Boundary, Boundary> FindCodepointRange(size_t char_idx, size_t count);

    /// Link a neighbor
    void LinkNodeRight(InnerNode& other);
    /// Unlink a node
    void UnlinkNode();
    /// Combine the text statistics
    TextStats AggregateTextInfo() noexcept;
    /// Combine the text statistics
    TextStats AggregateTextInfoInRange(size_t child_id, size_t count) noexcept;

    /// Pushes an item into the array
    void Push(NodePtr child, TextStats stats);
    /// Pushes items into the array
    void Push(std::span<const NodePtr> nodes, std::span<const TextStats> stats);
    /// Pops an item from the end of the array
    std::pair<NodePtr, TextStats> Pop();
    /// Inserts an item at a position
    void Insert(size_t idx, NodePtr child, TextStats stats);
    /// Inserts items at a position
    void Insert(size_t idx, std::span<const NodePtr> child, std::span<const TextStats> stats);

    /// Remove an element at a position
    std::pair<NodePtr, TextStats> Remove(size_t idx);
    /// Remove elements in a range
    void RemoveRange(size_t idx, size_t count);
    /// Truncate children from a position
    std::pair<std::span<const NodePtr>, std::span<const TextStats>> Truncate(size_t idx = 0) noexcept;
    /// Splits node at index
    void SplitOffRight(size_t child_idx, InnerNode& right);
    /// Splits node at index
    void SplitOffLeft(size_t child_idx, InnerNode& left);

    /// Distribute children equally between nodes
    void BalanceRight(TextStats& own_info, InnerNode& right_node, TextStats& right_info);
};

struct Rope {
   protected:
    /// The page size
    const size_t page_size;
    /// The tree height
    size_t tree_height;
    /// The root page
    NodePtr root_node;
    /// The root page
    TextStats root_info;
    /// The first leaf
    LeafNode* first_leaf;

    /// Connect nodes
    static void LinkEquiHeight(size_t page_size, NodePtr left, NodePtr right);
    /// Balance a child of an inner node
    static void BalanceChild(InnerNode& node, size_t idx, LeafNode*& first_leaf);

    /// Ensure at least one element can be inserted into the child node.
    /// This method will attempt to move elements to the immediate left and right neighbors.
    /// The balancing only succeeds if the other neighbor also has at least one child node capacity after balancing.
    /// It might happen, that the child node is moved to a different parent and therefore MUST NOT rely on parent state.
    void PreemptiveBalanceOrSplit(InnerNode& parent, size_t& child_idx, TextStats& child_prefix, size_t char_idx);
    /// Split the inner root nodes
    void PreemptiveSplitRoot();
    /// Append a rope
    void AppendEquiHeight(Rope&& right_rope);
    /// Append a rope that is smaller
    void AppendSmaller(Rope&& right_rope);
    /// Append a rope that is taller
    void AppendTaller(Rope&& right_rope);
    /// Insert a small text at index.
    /// The text to be inserted must not exceed the size of leaf page.
    /// That guarantees that we need at most one split.
    void InsertBounded(size_t char_idx, std::span<const std::byte> text_bytes);
    /// Flatten the root
    void FlattenTree();
    /// Split off a rope
    Rope SplitOff(size_t char_idx);
    /// Append a rope to this rope
    void Append(Rope&& other);

    /// Reset the rope
    void Reset();

   public:
    /// Constructor
    explicit Rope(size_t page_size, NodePtr root_node, TextStats root_info, LeafNode* first_leaf, size_t tree_height);
    /// Constructor
    explicit Rope(size_t page_size);
    /// Constructor.
    /// Control fill degree through `leaf_capacity` and `inner_capacity`.
    explicit Rope(size_t page_size, std::string_view text, size_t leaf_capacity = std::numeric_limits<size_t>::max(),
                  size_t inner_capacity = std::numeric_limits<size_t>::max());
    /// Destructor
    ~Rope();
    /// Copy constructor
    Rope(Rope& other) = delete;
    /// Move constructor
    Rope(Rope&& other);
    /// Copy assignment
    Rope& operator=(Rope& other) = delete;
    /// Move assignment
    Rope& operator=(Rope&& other);

    /// Get the root text info
    inline auto& GetStats() { return root_info; }
    /// Get the first leaf node
    inline auto GetLeafs() noexcept { return first_leaf; }

    /// Insert a character at index
    void Insert(size_t char_idx, std::string_view text, bool force_bulk = false);
    /// Remove a range of characters
    void Remove(size_t char_idx, size_t count);
    /// Read from the rope
    std::string_view Read(size_t char_idx, size_t count, std::string& tmp) const;
    /// Check the integrity of the rope
    void CheckIntegrity();
    /// Copy the rope to a std::string
    std::string ToString(bool withPadding = false) const;
};

}  // namespace rope
}  // namespace sqlynx
