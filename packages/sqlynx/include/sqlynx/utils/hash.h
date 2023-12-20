#pragma once

#include <cstddef>
#include <functional>
#include <tuple>

namespace sqlynx {

template <class T> inline void hash_combine(std::size_t& seed, const T& v) {
    std::hash<T> hasher;
    seed ^= hasher(v) + 0x9e3779b9 + (seed << 6) + (seed >> 2);
}

struct TupleHasher {
    template <typename... Args> size_t operator()(const std::tuple<Args...>& key) const {
        size_t hash = 0;
        std::apply([&](auto&... arg) { (hash_combine(hash, arg), ...); }, key);
        return hash;
    }
    template <typename... Args> size_t operator()(const std::pair<Args...>& key) const {
        size_t hash = 0;
        std::apply([&](auto&... arg) { (hash_combine(hash, arg), ...); }, key);
        return hash;
    }
};

}  // namespace sqlynx
