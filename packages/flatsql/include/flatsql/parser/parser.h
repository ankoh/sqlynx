#pragma once

#include "flatsql/parser/parser_generated.h"

namespace flatsql {

class ParsedScript;
class ScannedScript;

namespace parser {

class Parser : public ParserBase {
    using ParserBase::ParserBase;

    /// Collect all expected symbols
    std::vector<symbol_kind_type> CollectExpectedSymbols();
    /// Parse until a token and return expected symbols
    std::vector<symbol_kind_type> CollectExpectedSymbolsAt(size_t token);

   public:
    /// Complete at a token
    static std::vector<Parser::symbol_kind_type> ParseUntil(ScannedScript& in, size_t token);
    /// Parse a module
    static std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> Parse(std::shared_ptr<ScannedScript> in,
                                                                             bool trace_scanning = false,
                                                                             bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql
