#pragma once

#include <cassert>
#include <cstddef>
#include <type_traits>
#include <vector>

namespace sqlynx {

/// A list node that is allocate in a separate buffer
struct IntrusiveListNode {
    /// The next node in the list
    IntrusiveListNode* next = nullptr;
    /// The index in the underlying buffer, only used for debugging
    size_t buffer_index = 0;
    /// Constructor
    IntrusiveListNode() {}

    /// Reference operator
    template <typename T, typename std::enable_if<std::is_base_of<IntrusiveListNode, T>::value>::type* = nullptr>
    inline T& operator*() {
        return *static_cast<T*>(this);
    }
    /// Dereference operator
    template <typename T, typename std::enable_if<std::is_base_of<IntrusiveListNode, T>::value>::type* = nullptr>
    inline T* operator->() {
        return static_cast<T*>(this);
    }
    /// Reference operator
    template <typename T, typename std::enable_if<std::is_base_of<IntrusiveListNode, T>::value>::type* = nullptr>
    inline const T& operator*() const {
        return *static_cast<const T*>(this);
    }
    /// Dereference operator
    template <typename T, typename std::enable_if<std::is_base_of<IntrusiveListNode, T>::value>::type* = nullptr>
    inline T const* operator->() const {
        return static_cast<T*>(this);
    }
};

/// A list of nodes allocated in a separate buffer
template <typename DerivedType = IntrusiveListNode,
          typename std::enable_if<std::is_base_of<IntrusiveListNode, DerivedType>::value>::type* = nullptr>
struct IntrusiveList {
   public:
    /// An end marker
    struct EndIterator {};
    /// An iterator
    struct Iterator {
       protected:
        /// The current node
        DerivedType* node;

       public:
        /// Constructor
        Iterator(DerivedType* node) : node(node) {}
        /// Get the index in the underlying buffer
        inline size_t GetBufferIndex() const { return node->buffer_index; }
        /// Get the node
        inline DerivedType& GetNode() { return *node; }
        /// Get the node
        inline const DerivedType& GetNode() const { return *node; }
        /// Compare with end iterator
        inline bool operator==(EndIterator&) const { return node == nullptr; }
        /// Compare with end iterator
        inline bool operator==(const EndIterator&) const { return node == nullptr; }
        /// Reference operator
        inline DerivedType& operator*() {
            assert(node != nullptr);
            return *static_cast<DerivedType*>(node);
        }
        /// Dereference operator
        inline DerivedType* operator->() {
            assert(node != nullptr);
            return static_cast<DerivedType*>(node);
        }
        /// Increment operator
        inline Iterator& operator++() {
            if (node) {
                node = static_cast<DerivedType*>(node->next);
            }
            return *this;
        }
    };

   protected:
    /// The first node in the list
    DerivedType* first = nullptr;
    /// The last node in the list
    DerivedType* last = nullptr;
    /// The number of nodes in the list
    size_t size = 0;

   public:
    /// Constructor
    IntrusiveList() = default;

    /// Cast to base
    IntrusiveList<IntrusiveListNode>& CastAsBase() {
        return *reinterpret_cast<IntrusiveList<IntrusiveListNode>*>(this);
    }
    /// Cast to base
    const IntrusiveList<IntrusiveListNode>& CastAsBase() const {
        return *reinterpret_cast<const IntrusiveList<IntrusiveListNode>*>(this);
    }

    /// Get the iterator
    Iterator begin() { return Iterator{first}; }
    /// Get the iterator
    Iterator begin() const { return Iterator{first}; }
    /// Get the end iterator
    EndIterator end() { return EndIterator{}; }
    /// Get the end iterator
    EndIterator end() const { return EndIterator{}; }

    /// Get the size of the list
    size_t GetSize() const { return size; }
    /// Append a list
    void Append(IntrusiveList<DerivedType>&& other) {
        if (other.size == 0) {
            return;
        }
        if (size == 0) {
            first = other.first;
            last = other.last;
            size = other.size;
        } else {
            assert(first != nullptr);
            assert(last != nullptr);
            last->next = other.first;
            last = other.last;
            size += other.size;
        }
        other.first = nullptr;
        other.last = nullptr;
        other.size = 0;
    }
    /// Push back a node
    void PushBack(DerivedType& node) {
        if (size == 0) {
            first = &node;
            last = &node;
            last->next = nullptr;
            size = 1;
        } else {
            assert(first != nullptr);
            assert(last != nullptr);
            assert(node.next == nullptr);
            last->next = &node;
            last = &node;
            ++size;
        }
    }
    /// Push back a node without asserting that the node has it's next pointer set.
    /// Only use this if you want to throw away the original list anyway.
    void PushBackUnsafe(DerivedType& node) {
        if (size == 0) {
            first = &node;
            last = &node;
            last->next = nullptr;
            size = 1;
        } else {
            assert(first != nullptr);
            assert(last != nullptr);
            last->next = &node;
            last = &node;
            ++size;
        }
    }
    /// Pop a node from the front
    DerivedType* PopFront() {
        if (size == 0) {
            return nullptr;
        } else {
            DerivedType* out = first;
            first = static_cast<DerivedType*>(out->next);
            last = (out == last) ? first : last;
            --size;
            return out;
        }
    }
    /// Clear the list
    void Clear() {
        first = nullptr;
        last = nullptr;
        size = 0;
    }
    /// Flatten the list into a vector
    std::vector<DerivedType> Flatten() {
        std::vector<DerivedType> buffer;
        buffer.reserve(size);
        for (auto& tuple : *this) {
            buffer.push_back(tuple);
            buffer.back().next = nullptr;
            buffer.back().buffer_index = -1;
        }
        return buffer;
    }
};

}  // namespace sqlynx
