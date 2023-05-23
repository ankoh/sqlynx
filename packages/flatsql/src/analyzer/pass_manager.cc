#include "flatsql/analyzer/pass_manager.h"

namespace flatsql {

/// Constructor
PassManager::PassManager(ParsedProgram& parser) : parsedProgram(parser) {}
/// Execute DFS post-order passes
void PassManager::Execute(LTRPass& pass) {
    // Prepare all passes
    pass.Prepare();
    // Scan all nodes
    auto iter = 0;
    while (iter != parsedProgram.nodes.size()) {
        size_t morsel_size = std::min<size_t>(parsedProgram.nodes.size() - iter, 1024);
        pass.Visit(std::span<proto::Node>(parsedProgram.nodes).subspan(iter, morsel_size));
        iter += morsel_size;
    }
    // Finish all passes
    pass.Finish();
}

}  // namespace flatsql
