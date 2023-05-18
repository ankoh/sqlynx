#include "flatsql/testing/xml_tests.h"

#include <sstream>

namespace flatsql::testing {

constexpr size_t INLINE_LOCATION_CAP = 20;
constexpr size_t LOCATION_HINT_LENGTH = 10;

void EncodeLocation(pugi::xml_node n, proto::Location loc, std::string_view text) {
    auto begin = loc.offset();
    auto end = loc.offset() + loc.length();
    {
        std::stringstream ss;
        ss << begin << ".." << end;
        n.append_attribute("loc") = ss.str().c_str();
    }
    {
        std::stringstream ss;
        if (loc.length() < INLINE_LOCATION_CAP) {
            ss << text.substr(loc.offset(), loc.length());
        } else {
            auto prefix = text.substr(loc.offset(), LOCATION_HINT_LENGTH);
            auto suffix = text.substr(loc.offset() + loc.length() - LOCATION_HINT_LENGTH, LOCATION_HINT_LENGTH);
            ss << prefix << ".." << suffix;
        }
        n.append_attribute("text") = ss.str().c_str();
    }
}

void EncodeError(pugi::xml_node n, const proto::ErrorT& err, std::string_view text) {
    n.append_attribute("message") = err.message.c_str();
    EncodeLocation(n, *err.location, text);
}

}  // namespace flatsql::testing
