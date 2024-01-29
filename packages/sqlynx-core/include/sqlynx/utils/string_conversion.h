#pragma once

#include <array>
#include <string_view>

namespace sqlynx {

extern const std::array<unsigned char, 256> TOLOWER_ASCII_TABLE;
// This will return weird results with non-ascii characters, use with caution
inline unsigned char tolower_fuzzy(unsigned char c) { return TOLOWER_ASCII_TABLE[c]; }

inline bool anyupper_fuzzy(std::string_view s) {
    bool anyupper = false;
    for (char c : s) {
        anyupper |= c >= 65 && c <= 90;
    }
    return anyupper;
}

inline int memicmp_fuzzy(const void *_s1, const void *_s2, size_t len) {
    auto *s1 = static_cast<const unsigned char *>(_s1);
    auto *s2 = static_cast<const unsigned char *>(_s2);
    for (; len > 0; --len, ++s1, ++s2) {
        auto c1 = tolower_fuzzy(*s1);
        auto c2 = tolower_fuzzy(*s2);
        if (c1 != c2) return c1 - c2;
    }
    return 0;
}

struct fuzzy_ci_char_traits : public std::char_traits<char> {
    static bool eq(char c1, char c2) { return tolower_fuzzy(c1) == tolower_fuzzy(c2); }
    static bool ne(char c1, char c2) { return tolower_fuzzy(c1) != tolower_fuzzy(c2); }
    static bool lt(char c1, char c2) { return tolower_fuzzy(c1) < tolower_fuzzy(c2); }
    static int compare(const char *s1, const char *s2, size_t n) { return memicmp_fuzzy(s1, s2, n); }
    static const char *find(const char *s, int n, char a) {
        for (; n-- > 0; ++s) {
            if (tolower_fuzzy(*s) == tolower_fuzzy(a)) {
                return s;
            }
        }
        return nullptr;
    }
};
using fuzzy_ci_string_view = std::basic_string_view<char, fuzzy_ci_char_traits>;

}  // namespace sqlynx
