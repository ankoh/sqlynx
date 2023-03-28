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

struct Rope;
struct LeafNode;
struct InnerNode;

struct PagePtr {
   protected:
    /// The page size
    size_t page_size;
    /// The page
    std::unique_ptr<std::byte[]> page;

   public:
    /// Constructor
    PagePtr(size_t page_size) : page_size(page_size), page(std::make_unique_for_overwrite<std::byte[]>(page_size)) {}
    /// Move constructor
    PagePtr(PagePtr&& other) = default;
    /// Move assignment
    PagePtr& operator=(PagePtr&& other) = default;

    /// Get the page size
    size_t GetPageSize() { return page_size; }
    /// Get raw page pointer
    std::byte* Get() { return page.get(); }
    /// Cast leaf pointer
    template <typename T> T* Cast() { return reinterpret_cast<T*>(page.get()); }
    /// Release leaf pointer
    template <typename T = void> T* Release() { return reinterpret_cast<T*>(page.release()); }
};

struct TextInfo {
    /// The text bytes
    size_t text_bytes = 0;
    /// The UTF-8 codepoints
    size_t utf8_codepoints = 0;
    /// The line breaks
    size_t line_breaks = 0;

    /// Constructor
    TextInfo();
    /// Constructor
    TextInfo(std::span<std::byte> data);
    /// Constructor
    TextInfo(std::span<const std::byte> data);
    /// Addition
    TextInfo operator+(const TextInfo& other);
    /// Addition
    TextInfo& operator+=(const TextInfo& other);
    /// Subtraction
    TextInfo operator-(const TextInfo& other);
    /// Subtraction
    TextInfo& operator-=(const TextInfo& other);
};

struct NodePtr {
   protected:
    /// The raw pointer
    uintptr_t raw_ptr;

   public:
    /// Default constructor
    NodePtr();
    /// Create node ptr from leaf node
    NodePtr(LeafNode* ptr);
    /// Create node ptr from inner node
    NodePtr(InnerNode* ptr);

    /// Get the tag
    uint8_t GetTag();
    /// Is null?
    bool IsNull();
    /// Is a leaf node?
    bool IsLeafNode();
    /// Is an inner node?
    bool IsInnerNode();
    /// Get as leaf node
    LeafNode* AsLeafNode();
    /// Get as inner node
    InnerNode* AsInnerNode();
};

struct LeafNode {
    friend struct Rope;

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
    LeafNode(uint32_t page_size);

    /// Get the capacity of the buffer
    auto GetCapacity() noexcept { return buffer_capacity; }
    /// Get the size of the buffer
    auto GetSize() noexcept { return buffer_size; }
    /// Get the data
    auto GetData() noexcept { return GetDataBuffer().subspan(0, buffer_size); }
    /// Get buffer content as string
    auto GetStringView() noexcept { return std::string_view{reinterpret_cast<char*>(GetData().data()), GetSize()}; }
    /// Is valid?
    auto IsValid() noexcept { return utf8::isCodepointBoundary(GetData(), 0); }
    /// Is the node empty?
    auto IsEmpty() noexcept { return GetSize() == 0; }
    /// Reset the node
    auto Reset() noexcept { buffer_size = 0; }

    /// Link a neighbor
    void LinkNeighbors(LeafNode& other);
    /// Insert raw bytes at an offset
    void InsertBytes(size_t ofs, std::span<const std::byte> data) noexcept;
    /// Appends a string to the end of the buffer
    void PushBytes(std::span<const std::byte> str) noexcept;
    /// Remove text in range
    void RemoveByteRange(size_t start_byte_idx, size_t end_byte_idx) noexcept;
    /// Remove text in range
    TextInfo RemoveCharRange(size_t start_idx, size_t end_idx) noexcept;
    /// Removes text after byte_idx
    std::span<std::byte> TruncateBytes(size_t byte_idx = 0) noexcept;
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
    /// Distribute children equally between nodes
    void BalanceBytes(LeafNode& right);

    /// Create a leaf node from a string
    static LeafNode* FromString(PagePtr& page, std::string_view& text);
};

struct InnerNode {
    friend struct Rope;

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
    InnerNode(size_t page_size);

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

    /// Find the child that contains a byte index
    std::pair<size_t, size_t> FindByte(size_t byte_idx);
    /// Find the child that contains a character
    std::pair<size_t, size_t> FindCodepoint(size_t char_idx);
    /// Find the child that contains a line break
    std::pair<size_t, size_t> FindLineBreak(size_t line_break_idx);

    /// Link a neighbor
    void LinkNeighbors(InnerNode& other);
    /// Combine the text statistics
    auto AggregateTextInfo() noexcept;
    /// Pushes an item into the array
    void Push(NodePtr child, TextInfo stats);
    /// Pushes items into the array
    void Push(std::span<const NodePtr> nodes, std::span<const TextInfo> stats);
    /// Pops an item from the end of the array
    std::pair<NodePtr, TextInfo> Pop();
    /// Inserts an item at a position
    void Insert(size_t idx, NodePtr child, TextInfo stats);
    /// Remove an element at a position
    std::pair<NodePtr, TextInfo> Remove(size_t idx);
    /// Truncate children from a position
    std::pair<std::span<const NodePtr>, std::span<const TextInfo>> Truncate(size_t idx) noexcept;
    /// Splits node at index
    void SplitOff(size_t child_idx, InnerNode& right);
    /// Pushes an element onto the end of the array, and then splits it in half
    void PushAndSplit(NodePtr child, TextInfo stats, InnerNode& dst);
    /// Inserts an element into a the array, and then splits it in half
    void InsertAndSplit(size_t idx, NodePtr child, TextInfo stats, InnerNode& other);
    /// Distribute children equally between nodes
    void Balance(InnerNode& right);
    /// Equi-distributes the children between the two child arrays, preserving ordering
    void Balance(size_t idx1, size_t idx2);
    /// If the children are leaf nodes, compacts them to take up the fewest nodes
    void CompactLeafs();
};

struct Rope {
    /// The page size
    const size_t page_size;
    /// The root page
    NodePtr root_node;
    /// The root page
    TextInfo root_info;
    /// The first leaf
    LeafNode* first_leaf;

    /// Constructor
    Rope(size_t page_size, NodePtr root_node, TextInfo root_info, LeafNode* first_leaf);
    /// Constructor
    Rope(size_t page_size);
    /// Destructor
    ~Rope();
    /// Copy constructor
    Rope(Rope& other) = delete;
    /// Move constructor
    Rope(Rope&& other);
    /// Copy assignment
    Rope& operator=(Rope& other) = delete;

    /// Get the root text info
    auto& GetInfo() { return root_info; }
    /// Copy the rope to a std::string
    std::string ToString();

    /// Split off a rope
    Rope SplitOff(size_t char_idx);
    /// Append a rope to this rope
    void Append(Rope other);
    /// Insert a small text at index.
    /// The text to be inserted must not exceed the size of leaf page.
    /// That guarantees that we need at most one split.
    void InsertBounded(size_t char_idx, std::span<const std::byte> text_bytes);
    /// Insert at index
    void Insert(size_t char_idx, std::string_view text);

    /// Create a rope from a string
    static Rope FromString(size_t page_size, std::string_view text);
};

}  // namespace flatsql::rope
