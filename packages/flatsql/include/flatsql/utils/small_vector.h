#pragma once

#include <array>
#include <iostream>
#include <vector>
#include <span>
#include <type_traits>

namespace flatsql {

/// A poor-mans small vector
template <class T, std::size_t N> class SmallVector {
   protected:
    /// The stack elements (if any)
    std::array<T, N> stack;
    /// The heap elements (if any)
    std::vector<T> heap;
    /// The size of the vector
    std::size_t size{0};

   public:
    /// Constructor
    SmallVector() = default;
    /// Constructor
    explicit SmallVector(size_t count, const T& value = T()) : size(count) {
        if (count == N) {
            stack.fill(value);
        } else if (count < N) {
            for (size_t i = 0; i < count; i++) {
                stack[i] = value;
            }
        } else {
            heap = {count, value};
        }
    }
    /// Initializer list
    SmallVector(std::initializer_list<T> initlist) {
        const auto input_size = initlist.size();
        if (input_size <= N) {
            std::copy(initlist.begin(), initlist.end(), stack.begin());
        } else {
            heap = initlist;
        }
        size = input_size;
    }
    /// Get the size
    size_t getSize() const { return size; }
    /// Access data
    T* getData() noexcept { return (size <= N) ? stack.data() : heap.data(); }
    /// Get a span
    std::span<T> span() { return {getData(), size}; }
    /// Is empty?
    bool empty() const { return size == 0; }
    /// Reserve heap space
    void reserve(size_t n) noexcept {
        if (n > N) {
            return heap.reserve(n);
        }
    }
    /// Push a value
    void push_back(const T& value) {
        if (size < N) {
            stack[size] = value;
        } else {
            if (size == N) {
                heap.reserve(N + 1);
                std::move(stack.begin(), stack.end(), std::back_inserter(heap));
            }
            heap.push_back(value);
        }
        size += 1;
    }
    /// Push a value
    void push_back(T&& value) {
        if (size < N) {
            stack[size] = std::move(value);
        } else {
            if (size == N) {
                heap.reserve(N + 1);
                std::move(stack.begin(), stack.end(), std::back_inserter(heap));
            }
            heap.push_back(std::move(value));
        }
        size += 1;
    }
    /// Prepend a value
    void push_front(T&& value) {
        if (size < N) {
            for (size_t i = 0; i < size; ++i) {
                stack[size - i] = std::move(stack[size - i - 1]);
            }
            stack[0] = std::move(value);
        } else if (size == N) {
            heap.reserve(N + 1);
            heap.push_back(std::move(value));
            std::move(stack.begin(), stack.end(), std::back_inserter(heap));
        } else {
            heap.insert(heap.begin(), std::move(value));
        }
        size += 1;
    }
    /// Forward iterator
    auto begin() { return span().begin(); }
    /// Forward iterator end
    auto end() { return span().end(); }
    /// Reverse iterator
    auto rbegin() { return span().rbegin(); }
    /// Reverse iterator end
    auto rend() { return span().rend(); }
};

}  // namespace flatsql
