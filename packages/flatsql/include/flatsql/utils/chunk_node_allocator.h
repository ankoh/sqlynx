#pragma once

#include <algorithm>
#include <iostream>
#include <list>
#include <memory>
#include <type_traits>
#include <utility>

#include "flatsql/utils/chunk_buffer.h"

namespace flatsql {

template <class T> class ChunkNodePool {
    union Node {
        /// The next node
        Node *next;
        /// The value
        T value;
    };
    /// The node buffer
    ChunkBuffer<T> node_buffer;
    /// The first free block
    Node *free_list = nullptr;

   public:
    /// Constructor
    ChunkNodePool() = default;
    /// Move constructor
    ChunkNodePool(ChunkNodePool &&memoryPool) = delete;
    /// Copy constructor
    ChunkNodePool(const ChunkNodePool &memoryPool) = delete;
    /// Move assignment
    ChunkNodePool &operator=(ChunkNodePool &&memoryPool) = delete;
    /// Copy assignment
    ChunkNodePool &operator=(const ChunkNodePool &memoryPool) = delete;

    /// Clear node 0ool
    void Clear() {
        node_buffer.Clear();
        free_list = nullptr;
    }

    /// Allocate a node
    T *allocate() {
        if (free_list) {
            Node *node = free_list;
            free_list = node->next;
            return &node->value;
        }
        return &node_buffer.Append();
    }
    /// Deallocate a node
    void deallocate(T *pointer) {
        Node *node = reinterpret_cast<Node *>(pointer);
        node->next = free_list;
        free_list = node;
    }
};

template <class T> class ChunkNodeAllocator {
   public:
    typedef std::size_t size_type;
    typedef std::ptrdiff_t difference_type;
    typedef T *pointer;
    typedef const T *const_pointer;
    typedef T &reference;
    typedef const T &const_reference;
    typedef T value_type;

    template <typename U> struct rebind {
        using other = ChunkNodeAllocator<U>;
    };

   protected:
    /// A chunk
    ChunkNodePool<T> &node_pool;

   public:
    /// Constructor
    ChunkNodeAllocator() : node_pool(GetThreadPool()) {}
    /// Constructor
    ChunkNodeAllocator(const ChunkNodeAllocator &aOther) = default;
    /// Constructor
    template <typename O> ChunkNodeAllocator(const ChunkNodeAllocator<O> &aOther) : node_pool(GetThreadPool()) {}

    /// Get a node pool
    auto &GetNodePool() const { return node_pool; }

    /// Allocate a node
    pointer allocate(size_type n, const void *hint = 0) {
        if (n != 1 || hint) throw std::bad_alloc();
        return node_pool.allocate();
    }
    /// Deallocate a node
    void deallocate(pointer p, size_type n) { node_pool.deallocate(p); }
    /// Construct a node
    void construct(pointer p, const_reference val) { new (p) T(val); }
    /// Destroy a node
    void destroy(pointer p) { p->~T(); }

    /// Get the thread-local node pool
    static auto &GetThreadPool() {
        static thread_local ChunkNodePool<T> local_pool;
        return local_pool;
    }
    /// Reset the thread-local node pool
    static void ResetThreadPool() { GetThreadPool().Clear(); }
};

template <typename T, typename U>
inline bool operator==(const ChunkNodeAllocator<T> &a, const ChunkNodeAllocator<U> &b) {
    return &a.GetNodePool() == &b.GetNodePool();
}
template <typename T, typename U>
inline bool operator!=(const ChunkNodeAllocator<T> &a, const ChunkNodeAllocator<U> &b) {
    return &a.GetNodePool() != &b.GetNodePool();
}

}  // namespace flatsql
