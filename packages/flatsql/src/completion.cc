#include "flatsql/analyzer/completion.h"

#include "flatsql/context.h"
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

namespace {

using ScoringTable = std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8>;

static constexpr ScoringTable NAME_SCORE_DEFAULTS{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 10},
    {proto::NameTag::DATABASE_NAME, 10},
    {proto::NameTag::TABLE_NAME, 10},
    {proto::NameTag::TABLE_ALIAS, 10},
    {proto::NameTag::COLUMN_NAME, 10},
}};

static constexpr ScoringTable NAME_SCORE_TABLE_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 20},
    {proto::NameTag::DATABASE_NAME, 20},
    {proto::NameTag::TABLE_NAME, 20},
    {proto::NameTag::TABLE_ALIAS, 0},
    {proto::NameTag::COLUMN_NAME, 0},
}};

static constexpr ScoringTable NAME_SCORE_COLUMN_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 0},
    {proto::NameTag::DATABASE_NAME, 0},
    {proto::NameTag::TABLE_NAME, 0},
    {proto::NameTag::TABLE_ALIAS, 20},
    {proto::NameTag::COLUMN_NAME, 0},
}};

}  // namespace

void Completion::FindCandidatesInIndex(CandidateMap& candidates, const CompletionIndex& index) {
    std::span<const CompletionIndex::Entry> entries = index.FindEntriesWithPrefix(cursor.text);

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

void Completion::FindCandidatesInIndexes(CandidateMap& candidates) {
    // Find candidates among keywords
    auto& keywords = CompletionIndex::Keywords();
    FindCandidatesInIndex(candidates, keywords);
    // Find candidates in name dictionary of main script
    if (auto& index = cursor.script.completion_index) {
        FindCandidatesInIndex(candidates, *index);
    }
    // Find candidates in name dictionary of external script
    if (cursor.script.external_script && cursor.script.external_script->completion_index) {
        auto& index = cursor.script.external_script->completion_index;
        FindCandidatesInIndex(candidates, *index);
    }
}

void Completion::FindCandidatesInAST(CandidateMap& candidates) {
    /// XXX Discover candidates around the cursor
}

void Completion::SelectTopN(CandidateMap& candidates) {
    for (auto& [key, value] : candidates) {
        result_heap.Insert(key, value.score);
    }
}

Completion::Completion(const ScriptCursor& cursor,
                       const std::array<std::pair<proto::NameTag, ScoreValueType>, 8>& scoring_table, size_t k)
    : cursor(cursor), scoring_table(scoring_table), result_heap(k) {}

flatbuffers::Offset<proto::Completion> Completion::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::CompletionBuilder completion{builder};
    // XXX
    return completion.Finish();
}

std::pair<std::unique_ptr<Completion>, proto::StatusCode> Completion::Compute(const ScriptCursor& cursor) {
    // Determine scoring table
    auto* scoring_table = &NAME_SCORE_DEFAULTS;
    // Is a table ref?
    if (cursor.table_reference_id.has_value()) {
        scoring_table = &NAME_SCORE_TABLE_REF;
    }
    // Is a column ref?
    if (cursor.column_reference_id.has_value()) {
        scoring_table = &NAME_SCORE_COLUMN_REF;
    }
    // Create completion
    auto completion = std::make_unique<Completion>(cursor, *scoring_table, 40);
    CandidateMap candidates;
    completion->FindCandidatesInIndexes(candidates);
    completion->FindCandidatesInAST(candidates);
    completion->SelectTopN(candidates);

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
