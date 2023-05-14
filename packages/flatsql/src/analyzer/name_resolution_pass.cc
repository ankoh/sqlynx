#include "flatsql/analyzer/name_resolution_pass.h"

namespace flatsql {

/// Constructor
NameResolutionPass::NameResolutionPass(ParsedProgram& parser) {}

/// Prepare the analysis pass
void NameResolutionPass::Prepare() {}
/// Visit a chunk of nodes
void NameResolutionPass::Visit(size_t morsel_offset, size_t morsel_size) {}
/// Finish the analysis pass
void NameResolutionPass::Finish() {}

}  // namespace flatsql
