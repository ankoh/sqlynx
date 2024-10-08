#pragma once

#include "sqlynx/parser/parser_generated.h"

namespace sqlynx {

class ParsedScript;
class ScannedScript;

namespace parser {

class Parser : public ParserBase {
    using ParserBase::ParserBase;

   public:
    using ExpectedSymbol = Parser::symbol_kind_type;

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
                                                                             bool debug = false);
};

}  // namespace parser
}  // namespace sqlynx
