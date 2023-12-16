#pragma once

#include <tuple>

#include "sqlynx/utils/chunk_buffer.h"

namespace sqlynx {

/// A list of nodes allocated in a separate buffer
template <typename T> struct OverlayList {
   public:
    /// A list node that is allocate in a separate buffer
    struct Node {
        /// The next node in the list
        Node* next = nullptr;
        /// The index in the underlying buffer, only used for debugging
        size_t buffer_index = 0;
        /// The value
        T value;
        /// Constructor
        Node(T value) : value(std::move(value)) {}
    };

    /// An end marker
    struct EndIterator {};
    /// An iterator
    struct Iterator {
       protected:
        /// The current node
        Node* node;

       public:
        /// Constructor
        Iterator(Node* node) : node(node) {}
        /// Get the index in the underlying buffer
        inline size_t GetBufferIndex() const { return node->buffer_index; }
        /// Get the node
        inline Node& GetNode() { return *node; }
        /// Compare with end iterator
        inline bool operator==(EndIterator&) const { return node == nullptr; }
        /// Compare with end iterator
        inline bool operator==(const EndIterator&) const { return node == nullptr; }
        /// Reference operator
        inline T& operator*() {
            assert(node != nullptr);
            return node->value;
        }
        /// Dereference operator
        inline T* operator->() {
            assert(node != nullptr);
            return &node->value;
        }
        /// Increment operator
        inline Iterator& operator++() {
            if (node) {
                node = node->next;
            }
            return *this;
        }
    };

   protected:
    /// The first node in the list
    Node* first = nullptr;
    /// The last node in the list
    Node* last = nullptr;
    /// The number of nodes in the list
    size_t size = 0;

   public:
    /// Constructor
    OverlayList() = default;

    /// Get the iterator
    Iterator begin() { return Iterator{first}; }
    /// Get the end iterator
    EndIterator end() { return EndIterator{}; }

    /// Get the size of the list
    size_t GetSize() const { return size; }
    /// Append a list
    void Append(OverlayList<T>&& other) {
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
    void PushBack(Node& node) {
        if (size == 0) {
            first = &node;
            last = &node;
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
    /// Pop a node from the front
    Node* PopFront() {
        if (size == 0) {
            return nullptr;
        } else {
            Node* out = first;
            first = out->next;
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
    std::vector<T> Flatten() {
        std::vector<T> buffer;
        buffer.reserve(size);
        for (auto tuple : *this) {
            buffer.push_back(std::move(tuple));
        }
        return buffer;
    }
};

}  // namespace sqlynx
