#ifndef INCLUDE_FLATSQL_PARSER_STRING_H_
#define INCLUDE_FLATSQL_PARSER_STRING_H_

#include <algorithm>
#include <cstddef>
#include <string>

namespace flatsql {
namespace parser {

inline bool isNoQuote(unsigned char c) { return c != '\"' && c != '\''; }

template <typename Fn> static inline void ltrim(std::string &s, Fn keepChar) {
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), keepChar));
}

template <typename Fn> static inline void rtrim(std::string &s, Fn keepChar) {
    s.erase(std::find_if(s.rbegin(), s.rend(), keepChar).base(), s.end());
}

template <typename Fn> static inline void trim(std::string &s, Fn keepChar) {
    ltrim(s, keepChar);
    rtrim(s, keepChar);
}

template <typename Fn> static inline std::string_view ltrimview(std::string_view s, Fn keepChar) {
    auto begin = std::find_if(s.begin(), s.end(), keepChar);
    return {begin, static_cast<size_t>(s.end() - begin)};
}

template <typename Fn> static inline std::string_view rtrimview(std::string_view s, Fn keepChar) {
    auto end = std::find_if(s.rbegin(), s.rend(), keepChar).base();
    return {s.begin(), static_cast<size_t>(end - s.begin())};
}

template <typename Fn> static inline std::string_view trimview(std::string_view s, Fn keepChar) {
    return ltrimview(rtrimview(s, keepChar), keepChar);
}

}  // namespace parser
}  // namespace flatsql

#endif  // INCLUDE_FLATSQL_COMMON_STRING_H_
