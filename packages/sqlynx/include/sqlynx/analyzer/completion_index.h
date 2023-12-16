#pragma once

#include "sqlynx/context.h"
#include "sqlynx/parser/names.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/suffix_trie.h"
#include "sqlynx/utils/topk.h"

namespace sqlynx {

class CompletionIndex {
   public:
    /// An entry in the trie
    struct EntryData {
        /// The name
        const ScannedScript::Name name;
        /// The suffix text
        std::string_view name_suffix;
        /// The weight of the entry
        /// Weight adds "preference" to entries in a completion index.
        /// For example, when entering "se", a keyword like "select" should be returned before "false" independent of
        /// the context.
        size_t weight;

        /// Constructor
        EntryData(const ScannedScript::Name& name, std::string_view name_suffix = {}, size_t weight = 0)
            : name(name), name_suffix(name_suffix), weight(weight) {}
    };

    struct Entry {
        /// The suffix
        fuzzy_ci_string_view suffix;
        /// The entry
        EntryData* data;
    };

    /// Constructor
    CompletionIndex(ChunkBuffer<EntryData, 256> entry_data, std::vector<Entry> entries,
                    std::shared_ptr<AnalyzedScript> script = nullptr);

   protected:
    /// The entry data
    ChunkBuffer<EntryData, 256> entry_data;
    /// The entries sorted by suffix
    std::vector<Entry> entries;
    /// The analyzed script
    std::shared_ptr<AnalyzedScript> script;

   public:
    /// Get the entries
    const auto& GetEntries() const { return entries; }
    /// Get the script
    const auto& GetScript() const { return script; }
    /// Find all entries that share a prefix
    std::span<const Entry> FindEntriesWithPrefix(fuzzy_ci_string_view prefix) const;
    /// Find all entries that share a prefix
    inline std::span<const Entry> FindEntriesWithPrefix(std::string_view prefix) const {
        return FindEntriesWithPrefix(fuzzy_ci_string_view{prefix.data(), prefix.length()});
    }

    /// Construct completion index from script
    static std::pair<std::unique_ptr<CompletionIndex>, proto::StatusCode> Build(std::shared_ptr<AnalyzedScript> script);
    /// Get the static keyword index
    static const CompletionIndex& Keywords();
};

}  // namespace sqlynx
