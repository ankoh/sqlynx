#include "sqlynx/analyzer/completion.h"

#include <flatbuffers/buffer.h>

#include <unordered_map>
#include <unordered_set>

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

static constexpr ScoringTable NAME_SCORE_DEFAULTS{{
    {proto::NameTag::NONE, Completion::TAG_IGNORE},
    {proto::NameTag::KEYWORD, Completion::TAG_UNLIKELY},
    {proto::NameTag::SCHEMA_NAME, Completion::TAG_LIKELY},
    {proto::NameTag::DATABASE_NAME, Completion::TAG_LIKELY},
    {proto::NameTag::TABLE_NAME, Completion::TAG_LIKELY},
    {proto::NameTag::TABLE_ALIAS, Completion::TAG_LIKELY},
    {proto::NameTag::COLUMN_NAME, Completion::TAG_LIKELY},
}};

static constexpr ScoringTable NAME_SCORE_TABLE_REF{{
    {proto::NameTag::NONE, Completion::TAG_IGNORE},
    {proto::NameTag::KEYWORD, Completion::TAG_UNLIKELY},
    {proto::NameTag::SCHEMA_NAME, Completion::TAG_LIKELY},
    {proto::NameTag::DATABASE_NAME, Completion::TAG_LIKELY},
    {proto::NameTag::TABLE_NAME, Completion::TAG_LIKELY},
    {proto::NameTag::TABLE_ALIAS, Completion::TAG_UNLIKELY},
    {proto::NameTag::COLUMN_NAME, Completion::TAG_UNLIKELY},
}};

static constexpr ScoringTable NAME_SCORE_COLUMN_REF{{
    {proto::NameTag::NONE, Completion::TAG_IGNORE},
    {proto::NameTag::KEYWORD, Completion::TAG_LIKELY},
    {proto::NameTag::SCHEMA_NAME, Completion::TAG_UNLIKELY},
    {proto::NameTag::DATABASE_NAME, Completion::TAG_UNLIKELY},
    {proto::NameTag::TABLE_NAME, Completion::TAG_UNLIKELY},
    {proto::NameTag::TABLE_ALIAS, Completion::TAG_LIKELY},
    {proto::NameTag::COLUMN_NAME, Completion::TAG_LIKELY},
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
            return Completion::KEYWORD_VERY_POPULAR;
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
            return Completion::KEYWORD_POPULAR;
        case parser::Parser::symbol_kind_type::S_BETWEEN:
        case parser::Parser::symbol_kind_type::S_DAY_P:
        case parser::Parser::symbol_kind_type::S_PARTITION:
        case parser::Parser::symbol_kind_type::S_SETOF:
        default:
            return Completion::KEYWORD_DEFAULT;
    }
}

bool doNotCompleteAfter(parser::Parser::symbol_type& sym) {
    switch (sym.kind_) {
        case parser::Parser::symbol_kind_type::S_COMMA:
        case parser::Parser::symbol_kind_type::S_LRB:
        case parser::Parser::symbol_kind_type::S_RRB:
        case parser::Parser::symbol_kind_type::S_LSB:
        case parser::Parser::symbol_kind_type::S_RSB:
        case parser::Parser::symbol_kind_type::S_DOT:
        case parser::Parser::symbol_kind_type::S_SEMICOLON:
        case parser::Parser::symbol_kind_type::S_COLON:
        case parser::Parser::symbol_kind_type::S_PLUS:
        case parser::Parser::symbol_kind_type::S_MINUS:
        case parser::Parser::symbol_kind_type::S_STAR:
        case parser::Parser::symbol_kind_type::S_DIVIDE:
        case parser::Parser::symbol_kind_type::S_MODULO:
        case parser::Parser::symbol_kind_type::S_QUESTION_MARK:
        case parser::Parser::symbol_kind_type::S_CIRCUMFLEX:
        case parser::Parser::symbol_kind_type::S_LESS_THAN:
        case parser::Parser::symbol_kind_type::S_GREATER_THAN:
        case parser::Parser::symbol_kind_type::S_EQUALS:
            return true;
        default:
            return false;
    }
}

}  // namespace

void Completion::FindCandidatesInGrammar(bool& expects_identifier) {
    auto& location = cursor.scanner_location;
    if (!location.has_value()) {
        return;
    }
    auto& scanned = *cursor.script.scanned_script;

    // Stop completion?
    if (doNotCompleteAfter(location->symbol)) {
        return;
    }
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
                        score += PREFIX_SCORE_MODIFIER;
                    } else {
                        score += SUBSTRING_SCORE_MODIFIER;
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
                .name = ScannedScript::Name{name, sx::Location(), {proto::NameTag::KEYWORD}, 0},
                .name_tags = NameTags{proto::NameTag::KEYWORD},
                .score = get_score(*location, expected, name),
                .in_statement = false,
            };
            result_heap.Insert(candidate);
        }
    }
}

void findCandidatesInIndex(Completion& completion, const Script& script, bool isExternalScript) {
    using Relative = ScannedScript::LocationInfo::RelativePosition;
    auto& cursor = completion.GetCursor();
    auto& scoring_table = completion.GetScoringTable();
    auto& pending_candidates = completion.GetPendingCandidates();

    // Get the current cursor prefix
    auto& location = cursor.scanner_location;
    auto symbol_ofs = location->symbol.location.offset();
    auto symbol_prefix = std::max<uint32_t>(location->text_offset, symbol_ofs) - symbol_ofs;
    std::string_view prefix_text{cursor.text.data(), symbol_prefix};
    fuzzy_ci_string_view ci_prefix_text{cursor.text.data(), symbol_prefix};

    // Fall back to the full word if the cursor prefix is empty
    auto search_text = prefix_text;
    if (search_text.empty()) {
        search_text = cursor.text;
    }

    // Find all suffixes for the cursor prefix
    auto& index = script.completion_index;
    assert(index != nullptr);
    std::span<const CompletionIndex::Entry> entries = index->FindEntriesWithPrefix(search_text);

    for (auto& entry : entries) {
        auto& entry_data = *entry.data;
        // Determine score
        Completion::ScoreValueType score = 0;
        for (auto [tag, tag_score] : scoring_table) {
            score = std::max(score, entry_data.name.tags.contains(tag) ? tag_score : 0);
        }
        score += entry_data.weight;
        // Is a prefix?
        switch (location->relative_pos) {
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL: {
                fuzzy_ci_string_view ci_entry_text{entry.data->name.text.data(), entry.data->name.text.size()};
                if (auto pos = ci_entry_text.find(ci_prefix_text, 0); pos == 0) {
                    score += Completion::PREFIX_SCORE_MODIFIER;
                } else {
                    score += Completion::SUBSTRING_SCORE_MODIFIER;
                }
                break;
            }
            default:
                break;
        }
        // Do we know the candidate already?
        if (auto iter = pending_candidates.find(entry_data.name.text); iter != pending_candidates.end()) {
            // Update the score if it is higher
            iter->second.score = std::max(iter->second.score, score);
            iter->second.name_tags |= entry_data.name.tags;
        } else {
            // Otherwise store as new candidate
            Completion::Candidate candidate{
                .name = entry_data.name,
                .name_tags = entry_data.name.tags,
                .score = score,
                .in_statement = false,
            };
            pending_candidates.insert({entry_data.name.text, candidate});
        }
    }
}

void Completion::FindCandidatesInIndexes() {
    // Find candidates in name dictionary of main script
    if (auto& index = cursor.script.completion_index) {
        findCandidatesInIndex(*this, cursor.script, false);
    }
    // Find candidates in name dictionary of external script
    if (cursor.script.external_script && cursor.script.external_script->completion_index) {
        auto& index = cursor.script.external_script->completion_index;
        findCandidatesInIndex(*this, *cursor.script.external_script, true);
    }
}

void Completion::FindTablesForUnresolvedColumns() {
    if (!cursor.statement_id.has_value() || !cursor.script.analyzed_script) {
        return;
    }
    auto statement_id = *cursor.statement_id;
    std::unordered_set<std::string_view> table_names;

    // Collect all unresolved columns in the current script
    auto& column_refs = cursor.script.analyzed_script->column_references;
    std::unordered_set<std::string_view> unresolved_columns;
    for (auto& column_ref : column_refs) {
        if (column_ref.table_id.IsNull()) {
            auto name = column_ref.column_name;
            if (!name.table_alias.empty()) {
                unresolved_columns.insert(name.column_name);
            }
        }
    }

    // Now try to find tables that contain these column names.
    // Start with tables defined in the same script.
    std::span<AnalyzedScript::TableColumn> own_columns{cursor.script.analyzed_script->table_columns};
    for (auto& table : cursor.script.analyzed_script->tables) {
        for (auto& column : own_columns.subspan(table.columns_begin, table.column_count)) {
            if (unresolved_columns.contains(column.column_name)) {
                table_names.insert(table.table_name.table_name);
                table_names.insert(table.table_name.schema_name);
                table_names.insert(table.table_name.database_name);
                break;
            }
        }
    }

    // Has external script?
    if (auto* external = cursor.script.external_script; external && external->analyzed_script) {
        std::span<AnalyzedScript::TableColumn> external_columns{external->analyzed_script->table_columns};

        // Map unresolved column names to external name dictionary
        std::unordered_set<std::string_view> unresolved_external_columns;
        for (auto column : unresolved_columns) {
            auto external_name_id = external->FindNameId(own_name);
            if (!external_name_id.IsNull()) {
                unresolved_external_columns.insert(external_name_id);
            }
        }
        if (!unresolved_external_columns.empty()) {
            // Lookup unresolved external columns
            for (auto& table : external->analyzed_script->tables) {
                for (auto& column : external_columns.subspan(table.columns_begin, table.column_count)) {
                    if (unresolved_external_columns.contains(column.column_name)) {
                        table_names.insert(table.table_name.table_name);
                        table_names.insert(table.table_name.schema_name);
                        table_names.insert(table.table_name.database_name);
                        break;
                    }
                }
            }
        }
    }
    // Adjust the score
    for (auto table_name : table_names) {
        if (auto iter = pending_candidates.find(table_name); iter != pending_candidates.end()) {
            iter->second.score += RESOLVING_TABLE_SCORE_MODIFIER;
        }
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
    auto mark_as_in_scope = [this](std::string_view name) {
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
        mark_as_in_scope(table_ref.table_name.database_name);
        mark_as_in_scope(table_ref.table_name.schema_name);
        mark_as_in_scope(table_ref.table_name.table_name);
        mark_as_in_scope(table_ref.alias_name);

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
    auto intersects = [](const sx::Location& l, const sx::Location& r) {
        auto l_begin = l.offset();
        auto l_end = l_begin + l.length();
        auto r_begin = r.offset();
        auto r_end = r_begin + r.length();

        // Two ranges overlap if the sum of their widths exceeds the (max - min)
        auto min = std::max(l_begin, r_begin);
        auto max = std::max(l_end, r_end);
        auto l_width = l_end - l_begin;
        auto r_width = r_end - r_begin;
        return (max - min) < (l_width + r_width);
    };

    // Find name if under cursor (if any)
    sx::Location current_symbol_location;
    if (auto& location = cursor.scanner_location; location.has_value()) {
        // XXX
    }

    // Insert all pending candidates into the heap
    for (auto& [key, candidate] : pending_candidates) {
        // Omit candidate if it occurs only once and is located under the cursor
        if (candidate.name.occurrences == 1 && intersects(candidate.name.location, current_symbol_location)) {
            continue;
        }
        // Remember candidate
        result_heap.Insert(candidate);
    }
    pending_candidates.clear();

    // Finish the heap
    result_heap.Finish();
}

static proto::CompletionStrategy selectStrategy(const ScriptCursor& cursor) {
    // Is a table ref?
    if (cursor.table_reference_id.has_value()) {
        return proto::CompletionStrategy::TABLE_REF;
    }
    // Is a column ref?
    if (cursor.column_reference_id.has_value()) {
        return proto::CompletionStrategy::COLUMN_REF;
    }
    return proto::CompletionStrategy::DEFAULT;
}

static const Completion::ScoringTable& selectScoringTable(proto::CompletionStrategy strategy) {
    switch (strategy) {
        case proto::CompletionStrategy::DEFAULT:
            return NAME_SCORE_DEFAULTS;
        case proto::CompletionStrategy::TABLE_REF:
            return NAME_SCORE_TABLE_REF;
        case proto::CompletionStrategy::COLUMN_REF:
            return NAME_SCORE_COLUMN_REF;
    }
}

Completion::Completion(const ScriptCursor& cursor, size_t k)
    : cursor(cursor), strategy(selectStrategy(cursor)), scoring_table(selectScoringTable(strategy)), result_heap(k) {}

std::pair<std::unique_ptr<Completion>, proto::StatusCode> Completion::Compute(const ScriptCursor& cursor, size_t k) {
    auto completion = std::make_unique<Completion>(cursor, k);
    bool expects_identifier = false;
    completion->FindCandidatesInGrammar(expects_identifier);
    if (expects_identifier) {
        completion->FindCandidatesInIndexes();
        completion->FindCandidatesInAST();
        completion->FindTablesForUnresolvedColumns();
    }
    completion->FlushCandidatesAndFinish();
    return {std::move(completion), proto::StatusCode::OK};
}

flatbuffers::Offset<proto::Completion> Completion::Pack(flatbuffers::FlatBufferBuilder& builder) {
    auto& entries = result_heap.GetEntries();

    // Pack candidates
    std::vector<flatbuffers::Offset<proto::CompletionCandidate>> candidates;
    candidates.reserve(entries.size());
    for (auto iter = entries.rbegin(); iter != entries.rend(); ++iter) {
        auto text_offset = builder.CreateString(iter->name.text);
        proto::CompletionCandidateBuilder candidateBuilder{builder};
        candidateBuilder.add_name_tags(iter->name_tags);
        candidateBuilder.add_name_text(text_offset);
        candidateBuilder.add_score(iter->GetScore());
        candidateBuilder.add_in_statement(iter->in_statement);
        candidates.push_back(candidateBuilder.Finish());
    }
    auto candidatesOfs = builder.CreateVector(candidates);

    // Pack completion table
    proto::CompletionBuilder completionBuilder{builder};
    completionBuilder.add_strategy(strategy);
    completionBuilder.add_text_offset(cursor.text_offset);
    completionBuilder.add_candidates(candidatesOfs);
    return completionBuilder.Finish();
}

}  // namespace sqlynx
