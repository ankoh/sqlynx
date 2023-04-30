#pragma once

#include <initializer_list>
#include <string_view>

#include "flatsql/parser/parser_generated.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"

namespace flatsql {

class PassManager {
   public:
    /// Analysis pass that visits node in a DFS post-order traversal
    struct DepthFirstPostOrderPass {
        /// Prepare the analysis pass
        virtual void Prepare();
        /// Visit a chunk of nodes
        virtual void Visit(size_t offset, std::span<proto::Node> nodes);
        /// Finish the analysis pass
        virtual void Finish();
    };

   protected:
    /// The output of the parser
    ParsedProgram& parsedProgram;

   public:
    /// Constructor
    PassManager(ParsedProgram& parser);
    /// Execute a pass
    void Execute(std::span<std::reference_wrapper<DepthFirstPostOrderPass>> passes);
};

}  // namespace flatsql
