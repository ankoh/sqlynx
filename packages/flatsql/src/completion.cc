#include "flatsql/analyzer/completion.h"

#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

CompletionIndex::CompletionIndex(std::vector<Entry> entries, std::shared_ptr<AnalyzedScript> script)
    : entries(std::move(entries)), script(std::move(script)) {}

/// Find all entries that share a prefix
std::span<CompletionIndex::Entry> CompletionIndex::FindEntriesWithPrefix(CompletionIndex::StringView prefix) {
    auto begin = std::lower_bound(entries.begin(), entries.end(), prefix,
                                  [](Entry& entry, StringView prefix) { return entry.suffix < prefix; });
    auto end = std::upper_bound(begin, entries.end(), prefix, [](StringView prefix, Entry& entry) {
        return prefix < entry.suffix && !entry.suffix.starts_with(prefix);
    });
    return {begin, static_cast<size_t>(end - begin)};
}

/// Get completions at a script cursor
proto::StatusCode CompletionIndex::CompleteAt(const ScriptCursor& cursor, CompletionState& state) {
    // Find all matching entries
    StringView prefix{cursor.text.data(), cursor.text.length()};
    std::span<Entry> entries = FindEntriesWithPrefix(prefix);

    // Now score these entries and store them in the state

    return proto::StatusCode::OK;
}

const CompletionIndex& CompletionIndex::Keywords() {
    static std::unique_ptr<const CompletionIndex> index = nullptr;
    // Already initialized?
    if (index != nullptr) {
        return *index;
    }
    // If not, load keywords
    auto keywords = parser::Keyword::GetKeywords();

    // Collect the entries
    std::vector<Entry> entries;
    {
        ChunkBuffer<Entry, 256> entries_chunked;
        for (size_t i = 0; i < keywords.size(); ++i) {
            auto& keyword = keywords[i];
            Entry entry{keyword.name, i, proto::NameTag::KEYWORD};
            auto text = entry.suffix;
            for (size_t offset = 0; offset < text.size(); ++offset) {
                Entry copy = entry;
                copy.suffix = text.substr(offset);
                entries_chunked.Append(copy);
            }
        }
        entries = entries_chunked.Flatten();
    }
    std::sort(entries.begin(), entries.end(), [](Entry& l, Entry& r) { return l.suffix < r.suffix; });

    // Build the index
    index = std::make_unique<CompletionIndex>(std::move(entries));
    return *index;
}

/// Construct completion index from script
std::pair<std::unique_ptr<CompletionIndex>, proto::StatusCode> CompletionIndex::Build(
    std::shared_ptr<AnalyzedScript> script) {
    auto& scanned = script->parsed_script->scanned_script;
    auto& names = scanned->name_dictionary;

    // Collect the entries
    std::vector<Entry> entries;
    {
        ChunkBuffer<Entry, 256> entries_chunked;
        for (size_t i = 0; i < names.size(); ++i) {
            auto& name = names[i];
            Entry entry{name.text, i, name.tags};
            auto text = entry.suffix;
            for (size_t offset = 0; offset < text.size(); ++offset) {
                Entry copy = entry;
                copy.suffix = text.substr(offset);
                entries_chunked.Append(copy);
            }
        }
        entries = entries_chunked.Flatten();
    }
    std::sort(entries.begin(), entries.end(), [](Entry& l, Entry& r) { return l.suffix < r.suffix; });

    auto index = std::make_unique<CompletionIndex>(std::move(entries), std::move(script));
    return {std::move(index), proto::StatusCode::OK};
}

}  // namespace flatsql
