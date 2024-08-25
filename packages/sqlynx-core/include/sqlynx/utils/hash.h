#pragma once

#include <cstddef>
#include <functional>
#include <string>
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

struct StringHasher {
    using is_transparent = void;
    using hasher = std::hash<std::string_view>;

    std::size_t operator()(const char* str) const { return hasher{}(str); }
    std::size_t operator()(std::string_view str) const { return hasher{}(str); }
    std::size_t operator()(std::string const& str) const { return hasher{}(str); }
};

struct StringPairHasher {
    using is_transparent = void;
    using view_hasher = std::hash<std::string_view>;

    size_t operator()(std::pair<std::string_view, std::string_view> str) const {
        size_t hash = 0;
        hash_combine(hash, view_hasher{}(str.first));
        hash_combine(hash, view_hasher{}(str.second));
        return hash;
    }
    size_t operator()(std::pair<std::string, std::string> const& str) const {
        size_t hash = 0;
        hash_combine(hash, view_hasher{}(str.first));
        hash_combine(hash, view_hasher{}(str.second));
        return hash;
    }
};

struct StringPairEqual {
    using is_transparent = std::true_type;

    template <typename A, typename B> bool operator()(std::pair<A, A> l, std::pair<B, B> r) const noexcept {
        std::pair<std::string_view, std::string_view> l_view = l;
        std::pair<std::string_view, std::string_view> r_view = r;
        return l_view == r_view;
    }
};

}  // namespace sqlynx
