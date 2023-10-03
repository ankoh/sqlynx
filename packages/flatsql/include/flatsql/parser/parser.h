#pragma once

#include "flatsql/parser/parser_generated.h"

namespace flatsql {

class ParsedScript;
class ScannedScript;

namespace parser {

class Parser : public ParserBase {
    using ParserBase::ParserBase;

   public:
    /// An expected symbol
    struct ExpectedSymbol {
        /// The symbol
        Parser::symbol_kind_type symbol;
        /// Expected through default action?
        bool throughDefault;
        /// Constructor
        ExpectedSymbol(Parser::symbol_kind_type sym, bool throughDefault)
            : symbol(sym), throughDefault(throughDefault) {}
    };

   protected:
    /// Collect all expected symbols
    std::vector<ExpectedSymbol> CollectExpectedSymbols();
    /// Parse until a token and return expected symbols
    std::vector<ExpectedSymbol> CollectExpectedSymbolsAt(size_t symbol_id);

   public:
    /// Complete at a token
    static std::vector<ExpectedSymbol> ParseUntil(ScannedScript& in, size_t symbol_id);
    /// Parse a module
    static std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> Parse(std::shared_ptr<ScannedScript> in,
                                                                             bool trace_scanning = false,
                                                                             bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql
