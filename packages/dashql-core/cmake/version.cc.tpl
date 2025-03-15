#include "dashql/version.h"

#include <cstring>
#include <string_view>

namespace dashql {

DashQLVersion VERSION = {
    .text_data = "@DASHQL_VERSION@",
    .text_size = static_cast<uint32_t>(std::strlen("@DASHQL_VERSION@")),
    .major = @DASHQL_VERSION_MAJOR@,
    .minor = @DASHQL_VERSION_PATCH@,
    .patch = @DASHQL_VERSION_PATCH@,
    .dev = @DASHQL_VERSION_DEV@,
};

}
