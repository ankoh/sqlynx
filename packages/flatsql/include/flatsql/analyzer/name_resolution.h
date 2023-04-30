#pragma once

#include "flatsql/analyzer/pass_manager.h"

namespace flatsql {

class NameResolutionPass : public PassManager::DepthFirstPostOrderPass {
    /// Constructor
    NameResolutionPass(ParsedProgram& parser);

    /// Prepare the analysis pass
    void Prepare() override;
    /// Visit a chunk of nodes
    void Visit(size_t offset, std::span<proto::Node> nodes) override;
    /// Finish the analysis pass
    void Finish() override;
};

}  // namespace flatsql
