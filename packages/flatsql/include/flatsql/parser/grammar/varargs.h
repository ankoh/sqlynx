#ifndef INCLUDE_FLATSQL_PARSER_GRAMMAR_VARARG_H_
#define INCLUDE_FLATSQL_PARSER_GRAMMAR_VARARG_H_

#include <charconv>

#include "flatsql/parser/parser_driver.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

class VarArgDictionary {
    /// The text
    const std::string_view program_text_;
    /// The text
    const proto::ProgramT& program_;
    /// The key mapping
    const std::unordered_map<std::string_view, uint16_t> key_mapping_;

   public:
    /// Constructor
    VarArgDictionary(std::string_view program_text, const proto::ProgramT& program);

    /// Get an attribute key from a string
    uint16_t keyFromString(std::string_view text) const;
    /// Get the string representation of a key
    std::string_view keyToString(uint16_t key) const;
    /// Get the string representation of a key for a script
    std::string_view keyToStringForScript(uint16_t key, std::string& tmp) const;
    /// Get the (camelCase) string representation of a key for JSON
    std::string_view keyToStringForJSON(uint16_t key, std::string& tmp) const;
};

}  // namespace parser
}  // namespace flatsql

#endif
