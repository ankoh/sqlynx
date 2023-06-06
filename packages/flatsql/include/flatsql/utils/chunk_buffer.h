#pragma once

#include <algorithm>
#include <array>
#include <cassert>
#include <cstring>
#include <iostream>
#include <memory>
#include <span>
#include <type_traits>
#include <vector>

namespace flatsql {

template <typename T, size_t InitialSize = 1024> struct ChunkBuffer {
   public:
    struct ForwardIterator {
        /// The buffer
        ChunkBuffer<T>& buffer;
        /// The chunk chunk
        size_t chunk_id;
        /// The local value id
        size_t local_value_id;

        /// Constructor
        ForwardIterator(ChunkBuffer<T>& buffer) : buffer(buffer), chunk_id(0), local_value_id(0) {}
        /// Reset
        void Reset() {
            chunk_id = 0;
            local_value_id = 0;
        }
        /// Increment operator
        ForwardIterator& operator++() {
            ++local_value_id;
            if (local_value_id >= buffer.buffers[chunk_id].size() && (chunk_id + 1) < buffer.buffers.size()) {
                ++chunk_id;
                local_value_id = 0;
            }
            return *this;
        }
        /// Increment operator
        ForwardIterator& operator+=(size_t n) {
            n = std::min<size_t>(buffer.buffers[chunk_id].size() - local_value_id, n);
            local_value_id += n;
            if (local_value_id >= buffer.buffers[chunk_id].size() && (chunk_id + 1) < buffer.buffers.size()) {
                ++chunk_id;
                local_value_id = 0;
            }
            return *this;
        }
        /// Is at end?
        bool IsAtEnd() { return local_value_id >= buffer.buffers[chunk_id].size(); }
        /// Get the value
        T GetValue() {
            assert(!IsAtEnd());
            return buffer.buffers[chunk_id][local_value_id];
        }
        /// Get the next N value
        std::span<T> GetValues(size_t n) {
            n = std::min<size_t>(buffer.buffers[chunk_id].size() - local_value_id, n);
            return std::span<T>{buffer.buffers[chunk_id]}.subspan(local_value_id, n);
        }
    };

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
        return {chunk_id, offsets[chunk_id]};
    }

   public:
    /// Constructor
    ChunkBuffer() : buffers(), offsets(), next_chunk_size(InitialSize), total_value_count(0) {
        buffers.reserve(64);
        offsets.reserve(64);
        grow();
    }

    /// Get the size
    size_t GetSize() const { return total_value_count; }
    /// Subscript operator
    T& operator[](size_t offset) {
        auto [chunk_id, chunk_offset] = find(offset);
        return buffers[chunk_id][offset - chunk_offset];
    }
    /// Get the last node
    T& GetLast() {
        assert(total_value_count > 0);
        return buffers.back().back();
    }
    /// Iterate the buffer
    ForwardIterator Iterate() { return ForwardIterator{*this}; }
    /// Clear the buffer
    void Clear() {
        buffers.erase(buffers.begin() + 1, buffers.end());
        offsets.erase(offsets.begin() + 1, offsets.end());
        next_chunk_size = InitialSize;
        total_value_count = 0;
        buffers[0].clear();
        offsets[0] = 0;
    }
    /// Append a node
    T& Append(T value) {
        auto* last = &buffers.back();
        if (last->size() == last->capacity()) {
            grow();
            last = &buffers.back();
        }
        last->push_back(std::move(value));
        ++total_value_count;
        return last->back();
    }
    /// Apply a function for each value
    template <typename F> void ForEach(F fn) {
        size_t value_id = 0;
        for (auto& chunk : buffers) {
            for (auto& value : chunk) {
                fn(value_id++, value);
            }
        }
    }
    /// Apply a function for each value
    template <typename F> void ForEach(F fn) const {
        size_t value_id = 0;
        for (auto& chunk : buffers) {
            for (auto& value : chunk) {
                fn(value_id++, value);
            }
        }
    }
    /// Apply a function for each node in a range
    template <typename F> void ForEachIn(size_t begin, size_t count, F fn) {
        auto [chunk_id, chunk_offset] = find(begin);
        auto local_offset = begin - chunk_offset;
        auto global_offset = begin;
        while (count > 0) {
            auto& chunk = buffers[chunk_id];
            assert(chunk.size() >= local_offset);
            auto here = std::min(chunk.size() - local_offset, count);
            for (size_t i = 0; i < here; ++i) {
                fn(global_offset++, chunk[local_offset + i]);
            }
            count -= here;
            ++chunk_id;
            local_offset = 0;
        }
    }
    /// Flatten the buffer
    std::vector<T> Flatten() {
        std::vector<T> flat;
        flat.resize(total_value_count);
        size_t writer = 0;
        for (auto& buffer : buffers) {
            std::memcpy(flat.data() + writer, buffer.data(), buffer.size() * sizeof(T));
            writer += buffer.size();
        }
        return flat;
    }
};

}  // namespace flatsql
