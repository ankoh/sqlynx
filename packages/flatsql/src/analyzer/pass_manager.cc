#include "flatsql/analyzer/pass_manager.h"

namespace flatsql {

/// Constructor
PassManager::PassManager(parser::ParsedProgram& parser) : parsedProgram(parser) {}
/// Execute DFS post-order passes
void PassManager::Execute(std::span<std::reference_wrapper<DepthFirstPostOrderPass>> passes) {
    // Prepare all passes
    for (auto pass : passes) {
        pass.get().Prepare();
    }
    // Scan all nodes
    auto iter = parsedProgram.nodes.Iterate();
    size_t offset = 0;
    while (!iter.IsAtEnd()) {
        auto nodes = iter.GetValues(1024);
        for (auto pass : passes) {
            pass.get().Visit(offset, nodes);
        }
        iter += nodes.size();
        offset += nodes.size();
    }
    // Finish all passes
    for (auto pass : passes) {
        pass.get().Finish();
    }
}

}  // namespace flatsql
