#pragma once

#include <cstdint>

namespace sqlynx {

struct SQLynxVersion {
    const char* text_data;
    uint32_t text_size;
    uint32_t major;
    uint32_t minor;
    uint32_t patch;
    uint32_t dev;
};
extern SQLynxVersion VERSION;

}  // namespace sqlynx
