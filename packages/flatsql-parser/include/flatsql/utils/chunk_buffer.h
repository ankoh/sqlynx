#pragma once

#include <algorithm>
#include <array>
#include <iostream>
#include <span>
#include <type_traits>
#include <vector>

namespace flatsql {

template <typename T>
struct ChunkBuffer {
    protected:
    /// The buffers
    std::vector<std::vector<T>> buffers;
    /// The offsets
    std::vector<size_t> offsets;
    /// The next chunk size
    size_t next_chunk_size;
    /// The total tuple count
    size_t total_value_count;

    /// Grow the buffer
    void grow() {
        auto chunk_size = next_chunk_size;
        next_chunk_size = next_chunk_size * 5 / 4;
        std::vector<T> nodes;
        nodes.reserve(chunk_size);
        buffers.push_back(std::move(nodes));
        offsets.push_back(total_value_count);
    }
    /// Find an offset in the buffer
    std::pair<size_t, size_t> find(size_t offset) {
        auto offset_iter = std::upper_bound(offsets.begin(), offsets.end(), offset);
        assert(offset_iter > offsets.begin());
        auto chunk_id = offset_iter - offsets.begin() - 1;
        auto value_id = offset - offsets[chunk_id];
        return {chunk_id, value_id};
    }

    public:
    /// Constructor
    ChunkBuffer()
        : buffers(), offsets(), next_chunk_size(1024), total_value_count(0) {
        buffers.reserve(64);
        offsets.reserve(64);
        grow();
    }

    /// Get the size
    size_t GetSize() { return total_value_count; }
    /// Subscript operator
    T& operator[](size_t offset) {
        auto [chunk_id, value_id] = find(offset);
        return buffers[chunk_id][value_id];
    }
    /// Get the last node
    T& GetLast() {
        assert(total_value_count > 0);
        return buffers.back().back();
    }
    /// Append a node
    void Append(T value) {
        auto* last = &buffers.back();
        if (last->size() == last->capacity()) {
            grow();
            last = &buffers.back();
        }
        last->push_back(value);
        ++total_value_count;
    }
    /// Apply a function for each node in a range
    template <typename F>
    void ForEachIn(size_t begin, size_t count, F fn) {
        auto [chunk_id, value_id] = find(begin);
        while (count > 0) {
            auto& chunk = buffers[chunk_id];
            auto here = std::min(chunk.size() - value_id, count);
            for (size_t i = 0; i < here; ++i) {
                auto& value = chunk[value_id + i];
                fn(value_id, value);
            }
            count -= here;
            ++chunk_id;
            value_id = 0;
        }
    }
    /// Flatten the buffer
    std::vector<T> Flatten() {
        std::vector<T> flat;
        flat.resize(total_value_count);
        size_t writer = 0; 
        for (auto& buffer: buffers) {
            std::memcpy(flat.data() + writer, buffer.data(), buffer.size() * sizeof(T));
            writer += buffer.size();
        }
        return flat;
    }
};

}
