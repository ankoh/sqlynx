#pragma once

#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/string_conversion.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

struct CompletionState {
    /// XXX Max-heap for scored candidates
};

class CompletionIndex {
   public:
    using StringView = fuzzy_ci_string_view;

    /// An entry in the trie
    struct Entry {
        /// The suffix
        StringView suffix;
        /// The name id
        size_t value_id;
        /// The name tags
        NameTags tags;

        /// Constructor
        Entry(StringView suffix = "", size_t value_id = 0, NameTags tags = 0)
            : suffix(suffix), value_id(value_id), tags(tags) {}
        /// Constructor
        Entry(std::string_view suffix, size_t value_id = 0, NameTags tags = 0)
            : suffix(suffix.data(), suffix.length()), value_id(value_id), tags(tags) {}
    };

    /// Constructor
    CompletionIndex(std::vector<Entry> entries, std::shared_ptr<AnalyzedScript> script = nullptr);

   protected:
    /// The entries sorted by suffix
    std::vector<Entry> entries;
    /// The analyzed script
    std::shared_ptr<AnalyzedScript> script;

   public:
    /// Get the entries
    const auto& GetEntries() const { return entries; }
    /// Get the script
    const auto& GetScript() const { return script; }
    /// Get completions at a script cursor
    void CompleteAt(const ScriptCursor& cursor, CompletionState& state);

    /// Construct completion index from script
    static std::pair<std::unique_ptr<CompletionIndex>, proto::StatusCode> Build(std::shared_ptr<AnalyzedScript> script);
    /// Get the static keyword index
    static const CompletionIndex& Keywords();
};

}  // namespace flatsql
