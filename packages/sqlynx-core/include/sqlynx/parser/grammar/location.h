#pragma once

#include <iostream>

#include "sqlynx/proto/proto_generated.h"

namespace sqlynx {
namespace parser {

inline std::ostream& operator<<(std::ostream& out, const sqlynx::proto::Location& loc) {
    out << "(" << loc.offset() << "+" << loc.length() << ")";
    return out;
}

inline proto::Location Loc(std::initializer_list<proto::Location> locs) {
    assert(locs.size() > 1);
    uint32_t begin = std::numeric_limits<uint32_t>::max();
    uint32_t end = 0;
    for (auto& loc : locs) {
        begin = std::min(begin, loc.offset());
        end = std::max(end, loc.offset() + loc.length());
    }
    return proto::Location(begin, end - begin);
}

}  // namespace parser
}  // namespace sqlynx
