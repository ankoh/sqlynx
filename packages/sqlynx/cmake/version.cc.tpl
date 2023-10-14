#include "sqlynx/version.h"

#include <cstring>
#include <string_view>

namespace sqlynx {

SQLynxVersion VERSION = {
    .text_data = "@FLATSQL_VERSION@",
    .text_size = static_cast<uint32_t>(std::strlen("@FLATSQL_VERSION@")),
    .major = @FLATSQL_VERSION_MAJOR@,
    .minor = @FLATSQL_VERSION_PATCH@,
    .patch = @FLATSQL_VERSION_PATCH@,
    .dev = @FLATSQL_VERSION_DEV@,
};

}
