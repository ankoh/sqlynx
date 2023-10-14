#pragma once

#include <initializer_list>
#include <string_view>

#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/text/rope.h"

namespace sqlynx {

class PassManager {
   public:
    /// Analysis pass that visits node in a DFS left-to-right post-order traversal.
    /// Scans the AST node buffer from left to right.
    struct LTRPass {
        /// Destructor
        virtual ~LTRPass();
        /// Prepare the analysis pass
        virtual void Prepare() = 0;
        /// Visit a chunk of nodes
        virtual void Visit(std::span<proto::Node> morsel) = 0;
        /// Finish the analysis pass
        virtual void Finish() = 0;
    };
    /// Analysis pass that visits nodes in a DFS right-to-left pre-order traversal
    /// Scans the AST node buffer from right to left.
    struct RTLPass {
        /// Destructor
        virtual ~RTLPass();
        /// Prepare the analysis pass
        virtual void Prepare() = 0;
        /// Visit a chunk of nodes
        virtual void Visit(std::span<proto::Node> morsel) = 0;
        /// Finish the analysis pass
        virtual void Finish() = 0;
    };

   protected:
    /// The output of the parser
    ParsedScript& parsedProgram;

   public:
    /// Constructor
    PassManager(ParsedScript& parser);
    /// Execute a pass
    void Execute(LTRPass& pass);
};

}  // namespace sqlynx
