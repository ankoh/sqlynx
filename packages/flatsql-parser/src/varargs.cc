#include "flatsql/parser/grammar/varargs.h"

#include <sstream>
#include <unordered_map>

#include "flatsql/parser/grammar/nodes.h"
#include "flatsql/parser/string.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

/// Get the text at a location
static std::string_view textAt(std::string_view text, proto::Location loc) {
    return text.substr(loc.offset(), loc.length());
}

/// Map the VarArg keys
static std::unordered_map<std::string_view, uint16_t> mapVarArgKeys(std::string_view text,
                                                                  const std::vector<proto::Location>& keys) {
    std::unordered_map<std::string_view, uint16_t> dict;
    dict.reserve(keys.size());
    for (auto i = 0; i < keys.size(); ++i) {
        auto& key = keys[i];
        dict.insert({text.substr(key.offset(), key.length()), i});
    }
    return dict;
}

/// Constructor
VarArgDictionary::VarArgDictionary(std::string_view program_text, const proto::ProgramT& program)
    : program_text_(std::move(program_text)),
      program_(program),
      key_mapping_(mapVarArgKeys(program_text_, program_.vararg_keys)) {}

/// Convert an dson key to string
std::string_view VarArgDictionary::keyToString(uint16_t key) const {
    if (key < static_cast<uint16_t>(proto::AttributeKey::EXT_VARARG_DYNAMIC_KEYS_)) {
        return proto::AttributeKeyTypeTable()->names[key];
    } else {
        key -= static_cast<uint16_t>(proto::AttributeKey::EXT_VARARG_DYNAMIC_KEYS_);
        assert(key < program_.vararg_keys.size());
        auto text = textAt(program_text_, program_.vararg_keys[key]);
        return text;
    }
}

/// Convert an dson key to camelcase (primarily for JSON)
std::string_view VarArgDictionary::keyToStringForJSON(uint16_t key, std::string& tmp) const {
    if (key < static_cast<uint16_t>(proto::AttributeKey::EXT_VARARG_DYNAMIC_KEYS_)) {
        return proto::AttributeKeyTypeTable()->names[key];
    } else {
        key -= static_cast<uint16_t>(proto::AttributeKey::EXT_VARARG_DYNAMIC_KEYS_);
        assert(key < program_.vararg_keys.size());
        return textAt(program_text_, program_.vararg_keys[key]);
    }
}

/// Convert an dson key to string for a script
std::string_view VarArgDictionary::keyToStringForScript(uint16_t key, std::string& tmp) const {
    tmp = "'";
    tmp += keyToString(key);
    tmp += "'";
    return tmp;
}

/// Get an attribute key from a string
uint16_t VarArgDictionary::keyFromString(std::string_view text) const {
    if (auto iter = key_mapping_.find(text); iter != key_mapping_.end()) {
        return iter->second;
    }
    return 0;
}

/// Add a dson file in the parser.
proto::Node ParserDriver::AddVarArgField(proto::Location loc, std::vector<proto::Location>&& key_path,
                                       proto::Node value) {
    // return Null();
    constexpr size_t MAX_NESTING_LEVEL = 4;

    // Check max nesting level
    std::array<uint16_t, MAX_NESTING_LEVEL> keys;
    if (key_path.size() > keys.size()) {
        std::stringstream err_msg;
        err_msg << "key length exceeds max nesting level of " << MAX_NESTING_LEVEL;
        AddError(loc, err_msg.str());
        return Null();
    }

    // Parse keys
    for (unsigned i = 0; i < key_path.size(); ++i) {
        auto key_loc = key_path[i];
        auto key_text = scanner().TextAt(key_loc);
        auto& key = keys[i];
        key = 0;

        // Check dictionary for unknown keys
        key_text = trimview(key_text, isNoQuote);
        key_loc = scanner().LocationOf(key_text);
        if (auto iter = dson_key_map_.find(key_text); iter != dson_key_map_.end()) {
            key = iter->second;
        } else {
            key = static_cast<uint16_t>(proto::AttributeKey::EXT_VARARG_DYNAMIC_KEYS_) + vararg_keys_.size();
            dson_key_map_.insert({key_text, key});
            vararg_keys_.push_back(key_loc);
        }

        // Register as dson key in scanner (for syntax highlighting)
        scanner().MarkAsVarArgKey(key_loc);
    }

    // XXX Check whether the given (key, value) pair is valid.
    // This is a best-effort check and will produce false-positives.

    // Expand key path
    auto iter = keys.rbegin() + (keys.size() - key_path.size());
    auto prev = Attr(*iter, value);
    for (++iter; iter != keys.rend(); ++iter) {
        prev = Attr(*iter, AddObject(loc, proto::NodeType::OBJECT_EXT_VARARGS, {&prev, 1}, true, false));
    }
    return prev;
}

}  // namespace parser
}  // namespace flatsql
