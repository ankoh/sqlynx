#pragma once

#include <cassert>
#include <span>
#include <vector>

namespace sqlynx {

/// Adjecency list as compressed sparse rows
struct AdjacencyMap {
    /// The adjacency nodes
    std::vector<size_t> adjacency_nodes;
    /// The adjacency offsets
    std::vector<size_t> adjacency_offsets;

    /// Get adjacent nodes for a vertex
    inline std::span<const size_t> operator[](size_t vertex_id) const {
        assert(vertex_id < adjacency_offsets.size());
        assert((vertex_id + 1) < adjacency_offsets.size());
        return std::span<const size_t>{adjacency_nodes}.subspan(
            adjacency_offsets[vertex_id], adjacency_offsets[vertex_id + 1] - adjacency_offsets[vertex_id]);
    }
    /// Get the edge count
    inline size_t GetEdgeCount() const { return adjacency_offsets.size() - 1; }
};

}  // namespace sqlynx
