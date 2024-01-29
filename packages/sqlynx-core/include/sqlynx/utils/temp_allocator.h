#pragma once

#include <algorithm>
#include <iostream>
#include <list>
#include <memory>
#include <type_traits>
#include <utility>

#include "sqlynx/utils/chunk_buffer.h"

namespace sqlynx {

template <class T, size_t InitialSize = 128> class TempNodePool {
    struct Node {
        /// The next node
        Node *next;
        /// The value
        std::byte data[sizeof(T)];
    };
    /// The node buffer
    ChunkBuffer<Node, InitialSize> node_buffer;
    /// The first free block
    Node *free_list = nullptr;
    /// The number of allocated objects in the pool
    size_t allocated_nodes = 0;

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

    /// Get the number of allocated nodes
    size_t GetAllocatedNodeCount() { return allocated_nodes; }
    /// Get the allocation marker
    static constexpr Node *GetAllocationMarker() {
        return reinterpret_cast<Node *>(std::numeric_limits<uintptr_t>::max());
    }
    /// Clear node pool
    void Clear() {
        node_buffer.Clear();
        free_list = nullptr;
    }
    /// Allocate a node
    void *Allocate() {
        ++allocated_nodes;
        if (free_list) {
            Node *node = free_list;
            free_list = node->next;
            node->next = GetAllocationMarker();
            return &node->data;
        }
        auto &node = node_buffer.Append(Node{});
        node.next = GetAllocationMarker();
        return static_cast<void *>(&node.data);
    }
    /// Deallocate a node
    void Deallocate(T *pointer) {
        assert(allocated_nodes > 0);
        --allocated_nodes;
        auto node = reinterpret_cast<Node *>(reinterpret_cast<std::byte *>(pointer) - offsetof(Node, data));
        assert(node->next == GetAllocationMarker());
        node->next = free_list;
        free_list = node;
    }
    /// ForEach allocated node
    template <typename F> void ForEachAllocated(F func) {
        node_buffer.ForEachIn(0, node_buffer.GetSize(), [func](size_t value_id, Node &value) {
            if (value.next == GetAllocationMarker()) {
                func(value_id, *reinterpret_cast<T *>(value.data));
            }
        });
    }
};

}  // namespace sqlynx
