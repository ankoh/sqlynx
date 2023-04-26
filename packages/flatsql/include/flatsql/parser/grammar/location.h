#pragma once

#include <charconv>

#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

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
}  // namespace flatsql
