#include "flatsql/version.h"

#include <string_view>

namespace flatsql {

FlatSQLVersion VERSION = {
    .text_data = "@FLATSQL_VERSION@",
    .text_size = static_cast<uint32_t>(strlen("@FLATSQL_VERSION@")),
    .major = @FLATSQL_VERSION_MAJOR@,
    .minor = @FLATSQL_VERSION_PATCH@,
    .patch = @FLATSQL_VERSION_PATCH@,
    .dev = @FLATSQL_VERSION_DEV@,
};

}
