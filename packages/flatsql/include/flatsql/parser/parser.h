#pragma once

#include "flatsql/parser/parser_generated.h"

namespace flatsql {

class ParsedScript;
class ScannedScript;

namespace parser {

class Parser : public ParserBase {
    using ParserBase::ParserBase;

   public:
    /// Run the parser rules and get the list of expected tokens at a position.
    /// Returns the expected tokens for the NEXT token and substitutes.
    int CompleteAt(std::shared_ptr<ScannedScript> in, size_t token);

    /// Parse a module
    static std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> Parse(std::shared_ptr<ScannedScript> in,
                                                                             bool trace_scanning = false,
                                                                             bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql
