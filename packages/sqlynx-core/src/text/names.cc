#include "sqlynx/text/names.h"

#include "sqlynx/utils/string_conversion.h"

namespace sqlynx {

/// Get the byte size
size_t NameRegistry::GetByteSize() const {
    return (names.GetSize() * sizeof(RegisteredName) +
            names_by_text.size() * sizeof(std::pair<std::string_view, void*>));
}

/// Read a name
RegisteredName& NameRegistry::At(RegisteredNameID name) {
    assert(name < names.GetSize());
    return names[name];
}

/// Register a name
RegisteredName& NameRegistry::Register(std::string_view s, sx::Location location, sx::NameTag tag) {
    auto iter = names_by_text.find(s);
    if (iter != names_by_text.end()) {
        auto& name = iter->second.get();
        name.resolved_tags |= tag;
        name.occurrences += 1;
        return name;
    }
    RegisteredNameID name_id = names.GetSize();
    auto& name = names.Append(
        RegisteredName{.name_id = name_id, .text = s, .location = location, .occurrences = 1, .resolved_tags = tag});
    names_by_text.insert({s, name});
    return name;
}

/// Register a name
RegisteredName& NameRegistry::Register(std::string_view text, NameTags tags) {
    auto iter = names_by_text.find(text);
    if (iter != names_by_text.end()) {
        auto& name = iter->second.get();
        name.resolved_tags |= tags;
        ++name.occurrences;
        return name;
    } else {
        fuzzy_ci_string_view ci_name{text.data(), text.size()};
        auto& name = names.Append(RegisteredName{.name_id = static_cast<uint32_t>(names.GetSize()),
                                                 .text = text,
                                                 .location = sx::Location(),
                                                 .occurrences = 1,
                                                 .resolved_tags = tags,
                                                 .resolved_objects = {}});
        names_by_text.insert({name, name});
        return name;
    }
}

}  // namespace sqlynx
