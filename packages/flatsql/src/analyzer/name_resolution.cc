#include "flatsql/analyzer/name_resolution.h"

namespace flatsql {

/// Constructor
NameResolutionPass::NameResolutionPass(ParsedProgram& parser) {}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}
/// Visit a chunk of nodes
void NameResolutionPass::Visit(size_t offset, std::span<proto::Node> nodes) {}
/// Finish the analysis pass
void NameResolutionPass::Finish() {}

}  // namespace flatsql
