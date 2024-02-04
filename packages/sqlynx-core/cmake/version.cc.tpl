#include "sqlynx/version.h"

#include <cstring>
#include <string_view>

namespace sqlynx {

SQLynxVersion VERSION = {
    .text_data = "@SQLYNX_VERSION@",
    .text_size = static_cast<uint32_t>(std::strlen("@SQLYNX_VERSION@")),
    .major = @SQLYNX_VERSION_MAJOR@,
    .minor = @SQLYNX_VERSION_PATCH@,
    .patch = @SQLYNX_VERSION_PATCH@,
    .dev = @SQLYNX_VERSION_DEV@,
};

}
