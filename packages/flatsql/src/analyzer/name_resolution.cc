#include "flatsql/analyzer/name_resolution.h"

namespace flatsql {

/// Constructor
NameResolution::NameResolution(ParsedProgram& parser) {}

/// Prepare the analysis pass
void NameResolution::Prepare() {}
/// Visit a chunk of nodes
void NameResolution::Visit(size_t offset, std::span<proto::Node> nodes) {}
/// Finish the analysis pass
void NameResolution::Finish() {}

}  // namespace flatsql
