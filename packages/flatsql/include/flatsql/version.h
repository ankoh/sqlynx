#pragma once

#include <cstdint>

namespace flatsql {

struct FlatSQLVersion {
    const char* text_data;
    uint32_t text_size;
    uint32_t major;
    uint32_t minor;
    uint32_t patch;
    uint32_t dev;
};
extern FlatSQLVersion VERSION;

}  // namespace flatsql
