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

namespace sqlynx {

template <typename T, size_t InitialSize = 1024> struct ChunkBuffer {
    friend struct ConstForwardIterator;

   public:
    /// Pseudo end iterator
    struct EndIterator {};
    /// A forward iterator
    struct ConstTupleIterator {
        /// The buffer
        const ChunkBuffer<T, InitialSize>& buffer;
        /// The chunk chunk
        size_t chunk_id;
        /// The local value id
        size_t local_value_id;

        /// Constructor
        ConstTupleIterator(const ChunkBuffer<T, InitialSize>& buffer)
            : buffer(buffer), chunk_id(0), local_value_id(0) {}
        /// Is at end?
        inline bool IsAtEnd() const { return local_value_id >= buffer.buffers[chunk_id].size(); }
        /// Increment operator
        inline ConstTupleIterator& operator++() {
            ++local_value_id;
            if (local_value_id >= buffer.buffers[chunk_id].size() && (chunk_id + 1) < buffer.buffers.size()) {
                ++chunk_id;
                local_value_id = 0;
            }
            return *this;
        }
        /// Compare with end iterator
        inline bool operator==(EndIterator&) const { return IsAtEnd(); }
        /// Compare with end iterator
        inline bool operator==(const EndIterator&) const { return IsAtEnd(); }
        /// Reference operator
        inline const T& operator*() const {
            assert(!IsAtEnd());
            return buffer.buffers[chunk_id][local_value_id];
        }
        /// Reference operator
        inline const T* operator->() const {
            assert(!IsAtEnd());
            return &buffer.buffers[chunk_id][local_value_id];
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
    std::pair<size_t, size_t> find(size_t offset) const {
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
    /// Constructor
    ChunkBuffer(std::vector<T> buffer) : ChunkBuffer() {
        total_value_count = buffer.size();
        offsets.push_back(total_value_count);
        buffers.push_back(std::move(buffer));
    }

    /// Get the size
    size_t GetSize() const { return total_value_count; }
    /// Subscript operator
    T& operator[](size_t offset) {
        auto [chunk_id, chunk_offset] = find(offset);
        return buffers[chunk_id][offset - chunk_offset];
    }
    /// Subscript operator
    const T& operator[](size_t offset) const {
        auto [chunk_id, chunk_offset] = find(offset);
        return buffers[chunk_id][offset - chunk_offset];
    }
    /// Get the begin iterator
    ConstTupleIterator begin() const { return ConstTupleIterator{*this}; }
    /// Get the end iterator
    EndIterator end() const { return EndIterator{}; }
    /// Get the chunks
    auto& GetChunks() { return buffers; }
    /// Get the chunks
    auto& GetChunks() const { return buffers; }
    /// Get the chunk offsets
    auto& GetChunkOffsets() const { return offsets; }
    /// Get the last node
    T& GetLast() {
        assert(total_value_count > 0);
        return buffers.back().back();
    }
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
    std::vector<T> Flatten() const {
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

}  // namespace sqlynx
