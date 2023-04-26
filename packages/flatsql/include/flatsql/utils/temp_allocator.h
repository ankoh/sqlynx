#pragma once

#include <algorithm>
#include <iostream>
#include <list>
#include <memory>
#include <type_traits>
#include <utility>

#include "flatsql/utils/chunk_buffer.h"

namespace flatsql {

template <class T> class TempNodePool {
    union Node {
        /// The next node
        Node *next;
        /// The value
        std::aligned_storage<sizeof(T), alignof(T)> data;
    };
    /// The node buffer
    ChunkBuffer<T> node_buffer;
    /// The first free block
    Node *free_list = nullptr;

   public:
    /// Constructor
    TempNodePool() = default;
    /// Move constructor
    TempNodePool(TempNodePool &&memoryPool) = delete;
    /// Copy constructor
    TempNodePool(const TempNodePool &memoryPool) = delete;
    /// Move assignment
    TempNodePool &operator=(TempNodePool &&memoryPool) = delete;
    /// Copy assignment
    TempNodePool &operator=(const TempNodePool &memoryPool) = delete;

    /// Clear node 0ool
    void Clear() {
        node_buffer.Clear();
        free_list = nullptr;
    }

    /// Allocate a node
    T *Allocate() {
        if (free_list) {
            Node *node = free_list;
            free_list = node->next;
            return reinterpret_cast<T *>(&node->data);
        }
        return &node_buffer.Append({});
    }
    /// Deallocate a node
    void Deallocate(T *pointer) {
        auto node = reinterpret_cast<Node *>(reinterpret_cast<std::byte *>(pointer) - offsetof(Node, data));
        node->next = free_list;
        free_list = node;
    }
};

template <class T> class TempNodeAllocator {
   public:
    typedef std::size_t size_type;
    typedef std::ptrdiff_t difference_type;
    typedef T *pointer;
    typedef const T *const_pointer;
    typedef T &reference;
    typedef const T &const_reference;
    typedef T value_type;

    template <typename U> struct rebind {
        using other = TempNodeAllocator<U>;
    };

   protected:
    /// The selected pool for temporary nodes
    TempNodePool<T> &node_pool;

   public:
    /// Constructor
    TempNodeAllocator() : node_pool(GetThreadPool()) {}
    /// Constructor
    TempNodeAllocator(const TempNodeAllocator &aOther) = default;
    /// Constructor
    template <typename O>
    TempNodeAllocator(const TempNodeAllocator<O> &aOther) : node_pool(TempNodeAllocator<O>::GetThreadPool()) {}

    /// Get a node pool
    auto &GetNodePool() const { return node_pool; }

    /// Allocate a node
    pointer allocate(size_type n, const void *hint = 0) {
#ifdef WASM
        assert(n == 1 && !hint);
#else
        if (n != 1 || hint) throw std::bad_alloc();
#endif
        return node_pool.Allocate();
    }
    /// Deallocate a node
    void deallocate(pointer p, size_type n) { node_pool.Deallocate(p); }
    /// Construct a node
    void construct(pointer p, const_reference val) { new (p) T(val); }
    /// Destroy a node
    void destroy(pointer p) { p->~T(); }

    /// Get the thread-local node pool
    static auto &GetThreadPool() {
#ifdef WASM
        static TempNodePool<T> local_pool;
#else
        static thread_local TempNodePool<T> local_pool;
#endif
        return local_pool;
    }
    /// Reset the thread-local node pool
    static void ResetThreadPool() { GetThreadPool().Clear(); }
};

template <typename T, typename U> inline bool operator==(const TempNodeAllocator<T> &a, const TempNodeAllocator<U> &b) {
    return &a.GetNodePool() == &b.GetNodePool();
}
template <typename T, typename U> inline bool operator!=(const TempNodeAllocator<T> &a, const TempNodeAllocator<U> &b) {
    return &a.GetNodePool() != &b.GetNodePool();
}

}  // namespace flatsql
