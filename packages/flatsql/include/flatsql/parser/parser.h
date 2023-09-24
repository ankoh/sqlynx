#pragma once

#include "flatsql/parser/parser_generated.h"

namespace flatsql {

class ParsedScript;
class ScannedScript;

namespace parser {

class Parser : public ParserBase {
    using ParserBase::ParserBase;

   public:
    /// Parse a module
    static std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> Parse(std::shared_ptr<ScannedScript> in,
                                                                             bool trace_scanning = false,
                                                                             bool trace_parsing = false);
};

}  // namespace parser
}  // namespace flatsql
