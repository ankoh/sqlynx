#include "flatsql/analyzer/completion_index.h"

#include <flatbuffers/buffer.h>

#include "flatsql/context.h"
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/parser/names.h"
#include "flatsql/parser/parser.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

CompletionIndex::CompletionIndex(ChunkBuffer<EntryData, 256> entry_data, std::vector<Entry> entries,
                                 std::shared_ptr<AnalyzedScript> script)
    : entry_data(std::move(entry_data)), entries(std::move(entries)), script(std::move(script)) {}

/// Find all entries that share a prefix
std::span<const CompletionIndex::Entry> CompletionIndex::FindEntriesWithPrefix(
    CompletionIndex::StringView prefix) const {
    auto begin = std::lower_bound(entries.begin(), entries.end(), prefix,
                                  [](const Entry& entry, StringView prefix) { return entry.suffix < prefix; });
    auto end = std::upper_bound(begin, entries.end(), prefix, [](StringView prefix, const Entry& entry) {
        return prefix < entry.suffix && !entry.suffix.starts_with(prefix);
    });
    return {begin, static_cast<size_t>(end - begin)};
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
    ChunkBuffer<EntryData, 256> entry_data_chunked;
    std::vector<Entry> entries;
    {
        ChunkBuffer<Entry, 256> entries_chunked;
        for (size_t i = 0; i < keywords.size(); ++i) {
            auto& keyword = keywords[i];
            QualifiedID name_id{QualifiedID::KEYWORD_CONTEXT_ID, static_cast<uint32_t>(i)};
            auto& entry_data =
                entry_data_chunked.Append(EntryData{keyword.name, name_id, proto::NameTag::KEYWORD, 0, 0});
            for (size_t offset = 0; offset < entry_data.name_text.size(); ++offset) {
                auto suffix = entry_data.name_text.substr(offset);
                entries_chunked.Append(Entry{
                    .suffix = {suffix.data(), suffix.size()},
                    .data = &entry_data,
                });
            }
        }
        entries = entries_chunked.Flatten();
    }
    std::sort(entries.begin(), entries.end(), [](Entry& l, Entry& r) { return l.suffix < r.suffix; });
    // Build the index
    index = std::make_unique<CompletionIndex>(std::move(entry_data_chunked), std::move(entries));
    return *index;
}

/// Construct completion index from script
std::pair<std::unique_ptr<CompletionIndex>, proto::StatusCode> CompletionIndex::Build(
    std::shared_ptr<AnalyzedScript> script) {
    auto& scanned = script->parsed_script->scanned_script;
    auto& names = scanned->name_dictionary;

    // Collect the entries
    ChunkBuffer<EntryData, 256> entry_data_chunked;
    std::vector<Entry> entries;
    {
        ChunkBuffer<Entry, 256> entries_chunked;
        for (size_t i = 0; i < names.size(); ++i) {
            auto& name = names[i];
            QualifiedID name_id{script->context_id, static_cast<uint32_t>(i)};
            auto& entry_data = entry_data_chunked.Append(EntryData{name.text, name_id, name.tags, name.occurrences});
            for (size_t offset = 0; offset < entry_data.name_text.size(); ++offset) {
                auto suffix = entry_data.name_text.substr(offset);
                entries_chunked.Append(Entry{
                    .suffix = {suffix.data(), suffix.size()},
                    .data = &entry_data,
                });
            }
        }
        entries = entries_chunked.Flatten();
    }
    std::sort(entries.begin(), entries.end(), [](Entry& l, Entry& r) { return l.suffix < r.suffix; });

    auto index =
        std::make_unique<CompletionIndex>(std::move(entry_data_chunked), std::move(entries), std::move(script));
    return {std::move(index), proto::StatusCode::OK};
}

}  // namespace flatsql
