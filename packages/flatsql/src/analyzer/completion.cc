#include "flatsql/analyzer/completion.h"

#include <flatbuffers/buffer.h>

#include "flatsql/analyzer/completion_index.h"
#include "flatsql/context.h"
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/parser/names.h"
#include "flatsql/parser/parser.h"
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

void Completion::FindCandidatesInGrammar(bool& expects_identifier) {
    expects_identifier = false;

    // Get the cursor completions at a cursor
    // auto token_id = cursor.scanner_token_id.value_or(0); XXX
    auto token_id = 0;
    auto& scanned = *cursor.script.scanned_script;
    auto expected_symbols = parser::Parser::ParseUntil(scanned, token_id);

    for (parser::Parser::symbol_kind_type sym : expected_symbols) {
        switch (sym) {
            case parser::Parser::symbol_kind_type::S_IDENT:
                expects_identifier = true;
                break;
            default: {
                auto name = parser::Keyword::GetKeywordName(sym);
                if (!name.empty()) {
                    Candidate candidate{
                        .name_tags = NameTags{proto::NameTag::KEYWORD},
                        .name_text = name,
                        .score = 0,
                        .count = 0,
                    };
                    result_heap.Insert(candidate, 0);
                }
                break;
            }
        }
    }
}

void Completion::FindCandidatesInIndex(const CompletionIndex& index) {
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
        if (auto iter = pending_candidates.find(entry_data.name_id); iter != pending_candidates.end()) {
            // Update the score if it is higher
            iter->second.score = std::max(iter->second.score, score);
            iter->second.name_tags |= entry_data.name_tags;
        } else {
            // Otherwise store as new candidate
            pending_candidates.insert({entry_data.name_id, Candidate{
                                                               .name_text = entry_data.name_text,
                                                               .name_tags = entry_data.name_tags,
                                                               .score = score,
                                                           }});
        }
    }
}

void Completion::FindCandidatesInIndexes() {
    // Find candidates in name dictionary of main script
    if (auto& index = cursor.script.completion_index) {
        FindCandidatesInIndex(*index);
    }
    // Find candidates in name dictionary of external script
    if (cursor.script.external_script && cursor.script.external_script->completion_index) {
        auto& index = cursor.script.external_script->completion_index;
        FindCandidatesInIndex(*index);
    }
}

void Completion::FindCandidatesInAST() {
    /// XXX Discover candidates around the cursor
}

void Completion::FlushCandidatesAndFinish() {
    for (auto& [key, candidate] : pending_candidates) {
        result_heap.Insert(candidate, candidate.score);
    }
    result_heap.Finish();
}

static const Completion::ScoringTable& selectScoringTable(const ScriptCursor& cursor) {
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
    return *scoring_table;
}

Completion::Completion(const ScriptCursor& cursor, size_t k)
    : cursor(cursor), scoring_table(selectScoringTable(cursor)), result_heap(k) {}

std::pair<std::unique_ptr<Completion>, proto::StatusCode> Completion::Compute(const ScriptCursor& cursor, size_t k) {
    auto completion = std::make_unique<Completion>(cursor, k);
    bool expects_identifier = false;
    completion->FindCandidatesInGrammar(expects_identifier);
    if (expects_identifier) {
        completion->FindCandidatesInIndexes();
        completion->FindCandidatesInAST();
    }
    completion->FlushCandidatesAndFinish();
    return {std::move(completion), proto::StatusCode::OK};
}

flatbuffers::Offset<proto::Completion> Completion::Pack(flatbuffers::FlatBufferBuilder& builder) {
    auto& entries = result_heap.Finish();

    // Pack candidates
    std::vector<flatbuffers::Offset<proto::CompletionCandidate>> candidates;
    candidates.reserve(entries.size());
    for (auto& entry : entries) {
        auto text_offset = builder.CreateString(entry.value.name_text);
        proto::CompletionCandidateBuilder candidateBuilder{builder};
        candidateBuilder.add_name_tags(entry.value.name_tags);
        candidateBuilder.add_name_text(text_offset);
        candidateBuilder.add_score(entry.score);
        candidates.push_back(candidateBuilder.Finish());
    }
    auto candidatesOfs = builder.CreateVector(candidates);

    // Pack completion table
    proto::CompletionBuilder completionBuilder{builder};
    completionBuilder.add_text_offset(cursor.text_offset);
    // completionBuilder.add_scanner_token_id(cursor.scanner_token_id.value_or(0)); XXX
    completionBuilder.add_candidates(candidatesOfs);
    return completionBuilder.Finish();
}

}  // namespace flatsql
