#include "sqlynx/analyzer/completion_index.h"

#include <flatbuffers/buffer.h>

#include "sqlynx/context.h"
#include "sqlynx/parser/grammar/keywords.h"
#include "sqlynx/parser/names.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/suffix_trie.h"

namespace sqlynx {

CompletionIndex::CompletionIndex(ChunkBuffer<EntryData, 256> entry_data, std::vector<Entry> entries,
                                 std::shared_ptr<AnalyzedScript> script)
    : entry_data(std::move(entry_data)), entries(std::move(entries)), script(std::move(script)) {}

/// Find all entries that share a prefix
std::span<const CompletionIndex::Entry> CompletionIndex::FindEntriesWithPrefix(fuzzy_ci_string_view prefix) const {
    auto begin =
        std::lower_bound(entries.begin(), entries.end(), prefix,
                         [](const Entry& entry, fuzzy_ci_string_view prefix) { return entry.suffix < prefix; });
    auto end = std::upper_bound(begin, entries.end(), prefix, [](fuzzy_ci_string_view prefix, const Entry& entry) {
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
            ScannedScript::Name keyword_as_name{keyword.name, sx::Location(), {proto::NameTag::KEYWORD}, 0};
            auto& entry_data = entry_data_chunked.Append(EntryData{keyword_as_name, keyword_as_name.text, 0});
            for (size_t offset = 0; offset < entry_data.name.text.size(); ++offset) {
                auto suffix = entry_data.name.text.substr(offset);
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
            auto& entry_data = entry_data_chunked.Append(EntryData{names[i], names[i].text, 0});
            for (size_t offset = 0; offset < entry_data.name.text.size(); ++offset) {
                auto suffix = entry_data.name.text.substr(offset);
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

}  // namespace sqlynx
