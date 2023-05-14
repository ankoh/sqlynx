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
    /// Analysis pass that visits node in a DFS left-to-right post-order traversal.
    /// Scans the AST node buffer from left to right.
    struct LTRDepthFirstPostOrderPass {
        /// Prepare the analysis pass
        virtual void Prepare();
        /// Visit a chunk of nodes
        virtual void Visit(size_t morsel_offset, size_t morsel_size);
        /// Finish the analysis pass
        virtual void Finish();
    };
    /// Analysis pass that visits nodes in a DFS right-to-left pre-order traversal
    /// Scans the AST node buffer from right to left.
    struct RTLDepthFirstPreOrderPass {
        /// Prepare the analysis pass
        virtual void Prepare();
        /// Visit a chunk of nodes
        virtual void Visit(size_t morsel_offset, size_t morsel_size);
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
    void Execute(std::span<std::reference_wrapper<LTRDepthFirstPostOrderPass>> passes);
};

}  // namespace flatsql
