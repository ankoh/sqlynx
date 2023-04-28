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

template <size_t InitialSize = 1024> struct StringPool {
   protected:
    struct Page {
        /// The buffer
        std::unique_ptr<char[]> buffer = nullptr;
        /// The capacity
        size_t capacity = 0;
        /// The size
        size_t size = 0;
    };

    /// The buffers
    std::vector<Page> pages;
    /// The next chunk size
    size_t next_chunk_size = 0;
    /// The total tuple count
    size_t total_string_bytes = 0;

    /// Grow the buffer
    void grow() {
        auto chunk_size = next_chunk_size;
        next_chunk_size = next_chunk_size * 5 / 4;
        std::unique_ptr<char[]> buffer{new char[chunk_size]};
        pages.push_back({
            .buffer = std::move(buffer),
            .capacity = chunk_size,
            .size = 0,
        });
    }

   public:
    /// Constructor
    StringPool() : pages(), next_chunk_size(InitialSize) { grow(); }

    /// Get the size
    size_t GetSize() { return total_string_bytes; }
    /// Append a node
    std::span<char> Allocate(size_t n) {
        Page& last = pages.back();
        if ((last.capacity - last.size) >= n) {
            char* begin = last.buffer.get() + last.size;
            last.size += n;
            total_string_bytes += n;
            return std::span<char>{begin, n};
        } else if (n > (next_chunk_size * 2 / 3)) {
            std::unique_ptr<char[]> buffer{new char[n]};
            std::span<char> out{buffer.get(), n};
            pages.push_back({
                .buffer = std::move(buffer),
                .capacity = n,
                .size = n,
            });
            std::swap(pages[pages.size() - 1], pages[pages.size() - 2]);
            total_string_bytes += n;
            return out;
        } else {
            grow();
            Page& last = pages.back();
            assert(last.size == 0);
            assert(last.capacity >= n);
            char* begin = last.buffer.get() + last.size;
            last.size += n;
            total_string_bytes += n;
            return std::span<char>{begin, n};
        }
    }
    /// Allocate a copy of a string
    std::string_view AllocateCopy(std::string_view src) {
        std::span<char> buffer = Allocate(src.size());
        return std::string_view{buffer.data(), buffer.size()};
    }
};

}  // namespace flatsql
