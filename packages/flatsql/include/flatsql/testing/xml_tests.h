#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "flatsql/proto/proto_generated.h"
#include "pugixml.hpp"

namespace flatsql::testing {

/// Encode a location
void EncodeLocation(pugi::xml_node n, proto::Location loc, std::string_view text);
/// Encode an error
void EncodeError(pugi::xml_node n, const proto::ErrorT& err, std::string_view text);

}  // namespace flatsql::testing
