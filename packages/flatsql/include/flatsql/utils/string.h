#pragma once

#include <strings.h>

#include <algorithm>
#include <cstddef>
#include <string>

namespace flatsql {

inline bool is_no_quote(unsigned char c) { return c != '\''; }
inline bool is_no_double_quote(unsigned char c) { return c != '\"'; }
inline bool is_no_space(unsigned char c) { return c != ' ' && c != '\n'; }

template <typename Fn> inline void trim_left(std::string &s, Fn keep_char) {
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), keep_char));
}
template <typename Fn> inline void trim_right(std::string &s, Fn keep_char) {
    s.erase(std::find_if(s.rbegin(), s.rend(), keep_char).base(), s.end());
}
template <typename Fn> inline void trim(std::string &s, Fn keep_char) {
    trim_left(s, keep_char);
    trim_right(s, keep_char);
}
template <typename Fn> inline std::string_view trim_view_left(std::string_view s, Fn keepChar) {
    auto begin = std::find_if(s.begin(), s.end(), keepChar);
    return {begin, static_cast<size_t>(s.end() - begin)};
}
template <typename Fn> inline std::string_view trim_view_right(std::string_view s, Fn keepChar) {
    auto end = std::find_if(s.rbegin(), s.rend(), keepChar).base();
    return {s.begin(), static_cast<size_t>(end - s.begin())};
}
template <typename Fn> inline std::string_view trim_view(std::string_view s, Fn keepChar) {
    return trim_view_left(trim_view_right(s, keepChar), keepChar);
}

extern const std::array<unsigned char, 256> LOWER_LOOKUP_TABLE;
inline unsigned char lookup_lower(unsigned char c) { return LOWER_LOOKUP_TABLE[c]; }

inline int memicmp_lookup(const void *_s1, const void *_s2, size_t len) {
    auto *s1 = static_cast<const unsigned char *>(_s1);
    auto *s2 = static_cast<const unsigned char *>(_s2);
    for (; len > 0; --len, ++s1, ++s2) {
        auto c1 = lookup_lower(*s1);
        auto c2 = lookup_lower(*s2);
        if (c1 != c2) return c1 - c2;
    }
    return 0;
}

struct ci_char_traits : public std::char_traits<char> {
    static bool eq(char c1, char c2) { return lookup_lower(c1) == lookup_lower(c2); }
    static bool ne(char c1, char c2) { return lookup_lower(c1) != lookup_lower(c2); }
    static bool lt(char c1, char c2) { return lookup_lower(c1) < lookup_lower(c2); }
    static int compare(const char *s1, const char *s2, size_t n) { return memicmp_lookup(s1, s2, n); }
    static const char *find(const char *s, int n, char a) {
        while (n-- > 0 && lookup_lower(*s) != lookup_lower(a)) {
            ++s;
        }
        return s;
    }
};
using ci_string_view = std::basic_string_view<char, ci_char_traits>;

}  // namespace flatsql
