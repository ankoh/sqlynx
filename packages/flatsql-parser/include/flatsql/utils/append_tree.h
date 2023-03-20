#pragma once

#include <algorithm>
#include <array>
#include <iostream>
#include <span>
#include <type_traits>
#include <vector>

namespace flatsql {

template <class T, size_t LEAF_CAP, size_t INNER_CAP> struct AppendTree {
   public:
    /// A leaf node
    struct LeafNode {
        /// The values
        std::array<T, LEAF_CAP> values;
        /// The next node
        LeafNode* next_node;
        /// The number of values
        size_t value_count;

        /// Constructor
        LeafNode() : next_node(nullptr), value_count(0) {}
        /// Get the values
        std::span<T> GetValues() { return {values.data(), value_count}; }
    };

   protected:
    /// An inner node
    struct InnerNode {
        /// The children
        std::array<void*, INNER_CAP> child_pointers;
        /// The children
        std::array<size_t, INNER_CAP> child_offsets;
        /// The prev node
        InnerNode* prev_node;
        /// The number of nodes
        size_t child_count;

        /// Constructor
        InnerNode() : child_offsets(), child_pointers(), prev_node(nullptr), child_count(0) {}
        /// Get the child offsets
        std::span<T> GetChildOffsets() { return {child_offsets.data(), child_count}; }
        /// Get the child pointers
        std::span<T> GetChildPointers() { return {child_pointers.data(), child_count}; }
    };

    /// The inner levels
    std::array<InnerNode*, 64> last_at_level;
    /// The first leaf
    LeafNode* first_leaf;
    /// The last leaf
    LeafNode* last_leaf;
    /// The total node count
    size_t total_node_count;
    /// The max level
    ssize_t max_level;

   public:
    /// Constructor
    AppendTree()
        : last_at_level(), first_leaf(new LeafNode()), last_leaf(first_leaf), total_node_count(0), max_level(0) {
        void* child = static_cast<void*>(first_leaf);
        for (auto& level : last_at_level) {
            level = new InnerNode();
            level->child_offsets[0] = 0;
            level->child_pointers[0] = child;
            level->child_count = 1;
            child = static_cast<void*>(level);
        }
    }
    /// Destructor
    ~AppendTree() {
        for (size_t i = 0; i < last_at_level.size(); ++i) {
            auto* iter = last_at_level[i];
            while (iter) {
                auto next = iter->prev_node;
                delete iter;
                iter = next;
            }
        }
        auto iter = first_leaf;
        while (iter) {
            auto next = iter->next_node;
            delete iter;
            iter = next;
        }
    }

    /// Get the begin
    LeafNode* GetBegin() { return first_leaf; }
    /// Get the size
    auto GetSize() const { return total_node_count; }
    /// Get the level count
    auto GetLevelCount() const { return max_level + 1; }
    /// Get the root
    auto* GetRoot() { return last_at_level[max_level]; }
    /// Get the leafs
    auto* GetLeafs() { return first_leaf; }
    /// Get the levels
    auto& GetLevels() { return last_at_level; }
    /// Append a node
    void Append(T value) {
        // Add to leaf?
        if (last_leaf->value_count < LEAF_CAP) {
            last_leaf->values[last_leaf->value_count++] = value;
            ++total_node_count;
            return;
        }

        // Create new leaf node
        auto new_leaf = new LeafNode();
        last_leaf->next_node = new_leaf;
        last_leaf = new_leaf;
        last_leaf->values[last_leaf->value_count++] = value;

        // Propagate the leaf node upwards
        void* add_in_parent = new_leaf;
        for (ssize_t level_id = 0;; ++level_id) {
            max_level = std::max(max_level, level_id);

            // Enough space at level?
            auto& last = last_at_level[level_id];
            if (last->child_count < INNER_CAP) {
                auto cid = last->child_count++;
                last->child_offsets[cid] = total_node_count;
                last->child_pointers[cid] = add_in_parent;
                break;
            } else {
                // Create new node at level
                auto new_inner = new InnerNode();
                auto cid = new_inner->child_count++;
                new_inner->child_offsets[cid] = total_node_count;
                new_inner->child_pointers[cid] = add_in_parent;
                new_inner->prev_node = last;
                last = new_inner;
                add_in_parent = new_inner;
            }
        }
        ++total_node_count;
    }
    /// Find an element at an offset
    std::pair<LeafNode*, size_t> Find(size_t offset) {
        LeafNode* leaf = nullptr;
        InnerNode* inner = last_at_level[max_level];
        for (ssize_t level_id = max_level; level_id >= 0; --level_id) {
            auto& offsets = inner->child_offsets;
            auto offset_iter = std::upper_bound(offsets.begin(), offsets.begin() + inner->child_count, offset);
            auto child_id = std::max<ssize_t>((offset_iter - offsets.begin()), 1) - 1;
            auto child = inner->child_pointers[child_id];
            if (level_id == 0) {
                leaf = reinterpret_cast<LeafNode*>(child);
                break;
            }
            inner = reinterpret_cast<InnerNode*>(child);
        }
        auto leaf_offset = offset & (LEAF_CAP - 1);
        if (leaf_offset >= leaf->value_count) {
            return {nullptr, 0};
        } else {
            return {leaf, leaf_offset};
        }
    }
};

}  // namespace flatsql
