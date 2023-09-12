#include "flatsql/analyzer/completion.h"

#include "flatsql/context.h"
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

namespace {

static constexpr std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8> NAME_SCORE_TABLE_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 20},
    {proto::NameTag::DATABASE_NAME, 20},
    {proto::NameTag::TABLE_NAME, 20},
    {proto::NameTag::TABLE_ALIAS, 0},
    {proto::NameTag::COLUMN_NAME, 0},
}};

static constexpr std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8> NAME_SCORE_COLUMN_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 0},
    {proto::NameTag::DATABASE_NAME, 0},
    {proto::NameTag::TABLE_NAME, 0},
    {proto::NameTag::TABLE_ALIAS, 20},
    {proto::NameTag::COLUMN_NAME, 0},
}};

static constexpr std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8> NAME_SCORE_EXPRESSION{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 0},
    {proto::NameTag::DATABASE_NAME, 0},
    {proto::NameTag::TABLE_NAME, 0},
    {proto::NameTag::TABLE_ALIAS, 20},
    {proto::NameTag::COLUMN_NAME, 30},
}};

static constexpr std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8> NAME_SCORE_FROM_CLAUSE{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 20},
    {proto::NameTag::DATABASE_NAME, 20},
    {proto::NameTag::TABLE_NAME, 20},
    {proto::NameTag::TABLE_ALIAS, 0},
    {proto::NameTag::COLUMN_NAME, 0},
}};

}  // namespace

void Completion::FindCandidates(const CompletionIndex& index, std::string_view cursor_text,
                                const std::array<std::pair<proto::NameTag, ScoreValueType>, 8>& scoring_table) {
    std::span<const CompletionIndex::Entry> entries = index.FindEntriesWithPrefix(cursor_text);

    for (auto& entry : entries) {
        auto name_id = QualifiedID(index.GetScript()->context_id, entry.value_id);
        auto candidate_text =
            index.GetScript()->parsed_script->scanned_script->name_dictionary[name_id.GetIndex()].text;

        // Determine score
        ScoreValueType score = 0;
        for (auto [tag, tag_score] : scoring_table) {
            score = std::max(score, entry.tags.contains(tag) ? tag_score : 0);
        }
        // Do we know the candidate already?
        if (auto iter = candidates.find(name_id); iter != candidates.end()) {
            // Update the score if it is higher
            iter->second.score = std::max(iter->second.score, score);
            iter->second.tags |= entry.tags;
        } else {
            // Otherwise store as new candidate
            candidates.insert({name_id, Candidate{
                                            .tags = entry.tags,
                                            .text = {candidate_text.data(), candidate_text.size()},
                                            .score = score,
                                        }});
        }
    }
}

void Completion::FindCandidatesAroundCursor(const ScriptCursor& cursor) {
    /// XXX Discover candidates around the cursor
}

std::vector<TopKHeap<QualifiedID, Completion::ScoreValueType>::Entry> Completion::SelectTopN(size_t n) {
    TopKHeap<QualifiedID, ScoreValueType> top{n};
    for (auto& [key, value] : candidates) {
        top.Insert(key, value.score);
    }
    return top.Finish();
}

std::pair<std::unique_ptr<Completion>, proto::StatusCode> Completion::Compute(const ScriptCursor& cursor) {
    auto completion = std::make_unique<Completion>();

    // auto& main_script = cursor.script;
    // auto& external_script = cursor.script->external_script;
    // assert(!!main_script);

    // Is a table ref?
    if (cursor.table_reference_id.has_value()) {
        // XXX
    }

    // Is a column ref?
    if (cursor.column_reference_id.has_value()) {
        // XXX
    }

    // XXX

    return {std::move(completion), proto::StatusCode::OK};
}

CompletionIndex::CompletionIndex(std::vector<Entry> entries, std::shared_ptr<AnalyzedScript> script)
    : entries(std::move(entries)), script(std::move(script)) {}

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
