#include "sqlynx/analyzer/completion.h"

#include <flatbuffers/buffer.h>

#include <unordered_map>

#include "sqlynx/analyzer/completion_index.h"
#include "sqlynx/context.h"
#include "sqlynx/parser/grammar/keywords.h"
#include "sqlynx/parser/names.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/suffix_trie.h"

namespace sqlynx {

namespace {

using ScoringTable = std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8>;

static constexpr Completion::ScoreValueType NAME_UNLIKELY = 10;
static constexpr Completion::ScoreValueType NAME_LIKELY = 20;

static constexpr Completion::ScoreValueType KEYWORD_VERY_POPULAR = 3;
static constexpr Completion::ScoreValueType KEYWORD_POPULAR = 2;
static constexpr Completion::ScoreValueType KEYWORD_DEFAULT = 0;

static constexpr Completion::ScoreValueType IS_IN_STATEMENT_SCORE_MODIFIER = 1;
static constexpr Completion::ScoreValueType IS_SUBSTRING_SCORE_MODIFIER = 15;
static constexpr Completion::ScoreValueType IS_PREFIX_SCORE_MODIFIER = 20;

static_assert(IS_PREFIX_SCORE_MODIFIER > IS_SUBSTRING_SCORE_MODIFIER,
              "Begin a prefix weighs more than being a substring");
static_assert(IS_IN_STATEMENT_SCORE_MODIFIER < KEYWORD_POPULAR,
              "Being in scope doesn't outweigh a popular keyword of similar likelyhood without also being a substring");
static_assert((NAME_UNLIKELY + IS_SUBSTRING_SCORE_MODIFIER) > NAME_LIKELY,
              "An unlikely name that is a substring outweighs a likely name");
static_assert((NAME_UNLIKELY + KEYWORD_VERY_POPULAR) < NAME_LIKELY,
              "A very likely keyword prevalance doesn't outweighing a likely tag");

static constexpr ScoringTable NAME_SCORE_DEFAULTS{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, NAME_UNLIKELY},
    {proto::NameTag::SCHEMA_NAME, NAME_LIKELY},
    {proto::NameTag::DATABASE_NAME, NAME_LIKELY},
    {proto::NameTag::TABLE_NAME, NAME_LIKELY},
    {proto::NameTag::TABLE_ALIAS, NAME_LIKELY},
    {proto::NameTag::COLUMN_NAME, NAME_LIKELY},
}};

static constexpr ScoringTable NAME_SCORE_TABLE_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, NAME_UNLIKELY},
    {proto::NameTag::SCHEMA_NAME, NAME_LIKELY},
    {proto::NameTag::DATABASE_NAME, NAME_LIKELY},
    {proto::NameTag::TABLE_NAME, NAME_LIKELY},
    {proto::NameTag::TABLE_ALIAS, NAME_UNLIKELY},
    {proto::NameTag::COLUMN_NAME, NAME_UNLIKELY},
}};

static constexpr ScoringTable NAME_SCORE_COLUMN_REF{{
    {proto::NameTag::NONE, 0},
    {proto::NameTag::KEYWORD, NAME_LIKELY},
    {proto::NameTag::SCHEMA_NAME, NAME_UNLIKELY},
    {proto::NameTag::DATABASE_NAME, NAME_UNLIKELY},
    {proto::NameTag::TABLE_NAME, NAME_UNLIKELY},
    {proto::NameTag::TABLE_ALIAS, NAME_LIKELY},
    {proto::NameTag::COLUMN_NAME, NAME_UNLIKELY},
}};

/// We use a prevalence score to rank keywords by popularity.
/// It is much more likely that a user wants to complete certain keywords than others.
/// The added score is chosen so small that it only influences the ranking among similarly ranked keywords.
/// (i.e., being prefix, substring or in-scope outweighs the prevalence score)
static constexpr Completion::ScoreValueType GetKeywordPrevalenceScore(parser::Parser::symbol_kind_type keyword) {
    switch (keyword) {
        case parser::Parser::symbol_kind_type::S_AND:
        case parser::Parser::symbol_kind_type::S_FROM:
        case parser::Parser::symbol_kind_type::S_GROUP_P:
        case parser::Parser::symbol_kind_type::S_ORDER:
        case parser::Parser::symbol_kind_type::S_SELECT:
        case parser::Parser::symbol_kind_type::S_WHERE:
            return KEYWORD_VERY_POPULAR;
        case parser::Parser::symbol_kind_type::S_AS:
        case parser::Parser::symbol_kind_type::S_ASC_P:
        case parser::Parser::symbol_kind_type::S_BY:
        case parser::Parser::symbol_kind_type::S_CASE:
        case parser::Parser::symbol_kind_type::S_CAST:
        case parser::Parser::symbol_kind_type::S_DESC_P:
        case parser::Parser::symbol_kind_type::S_END_P:
        case parser::Parser::symbol_kind_type::S_LIKE:
        case parser::Parser::symbol_kind_type::S_LIMIT:
        case parser::Parser::symbol_kind_type::S_OFFSET:
        case parser::Parser::symbol_kind_type::S_OR:
        case parser::Parser::symbol_kind_type::S_SET:
        case parser::Parser::symbol_kind_type::S_THEN:
        case parser::Parser::symbol_kind_type::S_WHEN:
        case parser::Parser::symbol_kind_type::S_WITH:
            return KEYWORD_POPULAR;
        case parser::Parser::symbol_kind_type::S_BETWEEN:
        case parser::Parser::symbol_kind_type::S_DAY_P:
        case parser::Parser::symbol_kind_type::S_PARTITION:
        case parser::Parser::symbol_kind_type::S_SETOF:
        default:
            return KEYWORD_DEFAULT;
    }
}

}  // namespace

void Completion::FindCandidatesInGrammar(bool& expects_identifier) {
    auto& location = cursor.scanner_location;
    if (!location.has_value()) {
        return;
    }
    auto& scanned = *cursor.script.scanned_script;

    // Do we try to complete the current symbol or the next one?
    std::vector<parser::Parser::ExpectedSymbol> expected_symbols;
    if (location->relative_pos == ScannedScript::LocationInfo::RelativePosition::NEW_SYMBOL_AFTER &&
        !location->at_eof) {
        expected_symbols = parser::Parser::ParseUntil(scanned, location->symbol_id + 1);
    } else {
        expected_symbols = parser::Parser::ParseUntil(scanned, location->symbol_id);
    }

    // Helper to determine the score of a cursor symbol
    auto get_score = [&](const ScannedScript::LocationInfo& loc, parser::Parser::ExpectedSymbol expected,
                         std::string_view keyword_text) {
        fuzzy_ci_string_view ci_keyword_text{keyword_text.data(), keyword_text.size()};
        using Relative = ScannedScript::LocationInfo::RelativePosition;
        auto score = scoring_table[static_cast<size_t>(proto::NameTag::NONE)].second;
        score += GetKeywordPrevalenceScore(expected);
        switch (location->relative_pos) {
            case Relative::NEW_SYMBOL_AFTER:
            case Relative::NEW_SYMBOL_BEFORE:
                return score;
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL: {
                auto symbol_ofs = location->symbol.location.offset();
                auto symbol_prefix = std::max<uint32_t>(location->text_offset, symbol_ofs) - symbol_ofs;
                fuzzy_ci_string_view ci_symbol_text{cursor.text.data(), symbol_prefix};
                // Is substring?
                if (auto pos = ci_keyword_text.find(ci_symbol_text, 0); pos != fuzzy_ci_string_view::npos) {
                    if (pos == 0) {
                        score += IS_PREFIX_SCORE_MODIFIER;
                    } else {
                        score += IS_SUBSTRING_SCORE_MODIFIER;
                    }
                }
                return score;
            }
        }
    };

    // Add all expected symbols to the result heap
    for (auto& expected : expected_symbols) {
        if (expected == parser::Parser::symbol_kind_type::S_IDENT) {
            expects_identifier = true;
        }
        auto name = parser::Keyword::GetKeywordName(expected);
        if (!name.empty()) {
            Candidate candidate{
                .name_text = name,
                .name_tags = NameTags{proto::NameTag::KEYWORD},
                .score = get_score(*location, expected, name),
                .in_statement = false,
            };
            result_heap.Insert(candidate, candidate.score);
        }
    }
}

void Completion::FindCandidatesInIndex(const CompletionIndex& index) {
    using Relative = ScannedScript::LocationInfo::RelativePosition;
    std::span<const CompletionIndex::Entry> entries = index.FindEntriesWithPrefix(cursor.text);

    for (auto& entry : entries) {
        auto& entry_data = *entry.data;
        // Determine score
        ScoreValueType score = 0;
        for (auto [tag, tag_score] : scoring_table) {
            score = std::max(score, entry_data.name_tags.contains(tag) ? tag_score : 0);
        }
        score += entry_data.weight;
        // Is a prefix?
        auto& location = cursor.scanner_location;
        switch (location->relative_pos) {
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL: {
                auto symbol_ofs = location->symbol.location.offset();
                auto symbol_prefix = std::max<uint32_t>(location->text_offset, symbol_ofs) - symbol_ofs;
                fuzzy_ci_string_view ci_prefix_text{cursor.text.data(), symbol_prefix};
                fuzzy_ci_string_view ci_entry_text{entry.data->name_text.data(), entry.data->name_text.size()};
                if (auto pos = ci_entry_text.find(ci_prefix_text, 0); pos == 0) {
                    score += IS_PREFIX_SCORE_MODIFIER;
                } else {
                    score += IS_SUBSTRING_SCORE_MODIFIER;
                }
                break;
            }
            default:
                break;
        }
        // Do we know the candidate already?
        if (auto iter = pending_candidates.find(entry_data.name_id); iter != pending_candidates.end()) {
            // Update the score if it is higher
            iter->second.score = std::max(iter->second.score, score);
            iter->second.name_tags |= entry_data.name_tags;
        } else {
            // Otherwise store as new candidate
            Candidate candidate{
                .name_text = entry_data.name_text,
                .name_tags = entry_data.name_tags,
                .score = score,
                .in_statement = false,
            };
            pending_candidates.insert({entry_data.name_id, candidate});
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
    // Right now, we're just collecting all table and column refs with the same statement id.
    // We could later make this scope-aware (s.t. table refs in CTEs dont bump the score of completions in the main
    // clauses)

    // Bail out if there's no statement id
    if (!cursor.statement_id.has_value()) {
        return;
    }
    auto statement_id = *cursor.statement_id;

    // Helper to mark a name as in-scope
    auto mark_as_in_scope = [this](QualifiedID name) {
        if (auto iter = pending_candidates.find(name); iter != pending_candidates.end()) {
            iter->second.in_statement = true;
        }
    };

    for (auto& table_ref : cursor.script.analyzed_script->table_references) {
        // The table ref is not part of a statement id?
        // Skip then, we're currently using the statement id as very coarse-granular alternative to naming scopes.
        // TODO: We should remember a fine-granular scope union-find as output of the name resolution pass.
        if (!table_ref.ast_statement_id.has_value() || table_ref.ast_statement_id.value() != statement_id) {
            continue;
        }
        // Mark the table alias as in-scope
        if (!table_ref.alias_name.IsNull()) {
            mark_as_in_scope(table_ref.alias_name);
        }
        // Add all column names of the table
        if (auto maybe_table = cursor.script.FindTable(table_ref.table_id)) {
            auto& [table, table_columns] = *maybe_table;
            for (auto& table_column : table_columns) {
                mark_as_in_scope(table_column.column_name);
            }
        }
    }

    // Collect column references in the statement
    for (auto& column_ref : cursor.script.analyzed_script->column_references) {
        if (!column_ref.ast_statement_id.has_value() || column_ref.ast_statement_id.value() != statement_id) {
            continue;
        }
        mark_as_in_scope(column_ref.column_name.column_name);
    }

    // TODO: For unresolved columns, bump the score of tables that contain that column.
    //       Problem: We expose such an index from name resolution and building that index ad-hoc suffers from name id
    //       mapping.
}

void Completion::FlushCandidatesAndFinish() {
    // Find name if under cursor (if any)
    QualifiedID current_symbol_name;
    if (auto& location = cursor.scanner_location; location.has_value()) {
        auto& scanned = *cursor.script.scanned_script;
        auto name_id = scanned.FindName(cursor.text);
        if (name_id.has_value()) {
            current_symbol_name = QualifiedID{scanned.context_id, *name_id};
        }
    }

    // Insert all pending candidates into the heap
    for (auto& [key, candidate] : pending_candidates) {
        // Omit candidate if it occurs only once and is located at the cursor
        if (current_symbol_name == key) {
            continue;
        }
        // Adjust the score
        auto score = candidate.score + (candidate.in_statement ? IS_IN_STATEMENT_SCORE_MODIFIER : 0);
        result_heap.Insert(candidate, score);
    }

    // Finish the heap
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
    for (auto iter = entries.rbegin(); iter != entries.rend(); ++iter) {
        auto text_offset = builder.CreateString(iter->value.name_text);
        proto::CompletionCandidateBuilder candidateBuilder{builder};
        candidateBuilder.add_name_tags(iter->value.name_tags);
        candidateBuilder.add_name_text(text_offset);
        candidateBuilder.add_score(iter->score);
        candidateBuilder.add_in_statement(iter->value.in_statement);
        candidates.push_back(candidateBuilder.Finish());
    }
    auto candidatesOfs = builder.CreateVector(candidates);

    // Pack completion table
    proto::CompletionBuilder completionBuilder{builder};
    completionBuilder.add_text_offset(cursor.text_offset);
    completionBuilder.add_candidates(candidatesOfs);
    return completionBuilder.Finish();
}

}  // namespace sqlynx
