#pragma once

#include <algorithm>
#include <iostream>
#include <list>
#include <memory>
#include <type_traits>
#include <utility>

#include "flatsql/utils/chunk_buffer.h"

namespace flatsql {

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
            return &node->data;
        }
        return static_cast<void *>(&node_buffer.Append(Node{}).data);
    }
    /// Deallocate a node
    void Deallocate(T *pointer) {
        assert(allocated_nodes > 0);
        --allocated_nodes;
        auto node = reinterpret_cast<Node *>(reinterpret_cast<std::byte *>(pointer) - offsetof(Node, data));
        node->next = free_list;
        free_list = node;
    }
};

}  // namespace flatsql
