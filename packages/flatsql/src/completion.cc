#include "flatsql/analyzer/completion.h"

#include <flatbuffers/buffer.h>

#include "flatsql/context.h"
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/parser/names.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

namespace {

using ScoringTable = std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8>;

static constexpr ScoringTable NAME_SCORE_DEFAULTS{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 100},
    {proto::NameTag::DATABASE_NAME, 100},
    {proto::NameTag::TABLE_NAME, 100},
    {proto::NameTag::TABLE_ALIAS, 100},
    {proto::NameTag::COLUMN_NAME, 100},
}};

static constexpr ScoringTable NAME_SCORE_TABLE_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 10},
    {proto::NameTag::SCHEMA_NAME, 100},
    {proto::NameTag::DATABASE_NAME, 100},
    {proto::NameTag::TABLE_NAME, 100},
    {proto::NameTag::TABLE_ALIAS, 0},
    {proto::NameTag::COLUMN_NAME, 0},
}};

static constexpr ScoringTable NAME_SCORE_COLUMN_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, 100},
    {proto::NameTag::SCHEMA_NAME, 0},
    {proto::NameTag::DATABASE_NAME, 0},
    {proto::NameTag::TABLE_NAME, 0},
    {proto::NameTag::TABLE_ALIAS, 100},
    {proto::NameTag::COLUMN_NAME, 0},
}};

}  // namespace

void Completion::FindCandidatesInIndex(CandidateMap& candidates, const CompletionIndex& index) {
    std::span<const CompletionIndex::Entry> entries = index.FindEntriesWithPrefix(cursor.text);

    for (auto& entry : entries) {
        auto& entry_data = *entry.data;
        // Determine score
        ScoreValueType score = 0;
        for (auto [tag, tag_score] : scoring_table) {
            score = std::max(score, entry_data.name_tags.contains(tag) ? tag_score : 0);
        }
        score += entry_data.weight;
        // Do we know the candidate already?
        if (auto iter = candidates.find(entry_data.name_id); iter != candidates.end()) {
            // Update the score if it is higher
            iter->second.score = std::max(iter->second.score, score);
            iter->second.name_tags |= entry_data.name_tags;
        } else {
            // Otherwise store as new candidate
            candidates.insert({entry_data.name_id, Candidate{
                                                       .name_text = entry_data.name_text,
                                                       .name_id = entry_data.name_id,
                                                       .name_tags = entry_data.name_tags,
                                                       .score = score,
                                                   }});
        }
    }
}

void Completion::FindCandidatesInIndexes(CandidateMap& candidates) {
    // Find candidates among keywords
    auto& keyword_index = CompletionIndex::Keywords();
    FindCandidatesInIndex(candidates, keyword_index);
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

Completion::Completion(const ScriptCursor& cursor,
                       const std::array<std::pair<proto::NameTag, ScoreValueType>, 8>& scoring_table, size_t k)
    : cursor(cursor), scoring_table(scoring_table), result_heap(k) {}

flatbuffers::Offset<proto::Completion> Completion::Pack(flatbuffers::FlatBufferBuilder& builder) {
    auto& entries = result_heap.Finish();

    // Pack candidates
    std::vector<flatbuffers::Offset<proto::CompletionCandidate>> candidates;
    candidates.reserve(entries.size());
    for (auto& entry : entries) {
        auto text_offset = builder.CreateString(entry.value.name_text);
        proto::CompletionCandidateBuilder candidateBuilder{builder};
        candidateBuilder.add_name_id(entry.value.name_id.Pack());
        candidateBuilder.add_name_tags(entry.value.name_tags);
        candidateBuilder.add_name_text(text_offset);
        candidateBuilder.add_score(entry.score);
        candidates.push_back(candidateBuilder.Finish());
    }
    auto candidatesOfs = builder.CreateVector(candidates);

    // Pack completion table
    proto::CompletionBuilder completionBuilder{builder};
    completionBuilder.add_text_offset(cursor.text_offset);
    completionBuilder.add_scanner_token_id(cursor.scanner_token_id.value_or(0));
    completionBuilder.add_candidates(candidatesOfs);
    return completionBuilder.Finish();
}

std::pair<std::unique_ptr<Completion>, proto::StatusCode> Completion::Compute(const ScriptCursor& cursor, size_t k) {
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
    auto completion = std::make_unique<Completion>(cursor, *scoring_table, k);
    CandidateMap candidates;
    completion->FindCandidatesInIndexes(candidates);
    completion->FindCandidatesInAST(candidates);
    // Insert all candidates into the top-k heap
    for (auto& [key, value] : candidates) {
        completion->result_heap.Insert(value, value.score);
    }
    completion->result_heap.Finish();
    return {std::move(completion), proto::StatusCode::OK};
}

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
            auto& entry_data = entry_data_chunked.Append(
                EntryData{keyword.name, name_id, proto::NameTag::KEYWORD, 0, keyword.completion_weight});
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
