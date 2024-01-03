#include "sqlynx/analyzer/completion.h"

#include <flatbuffers/buffer.h>

#include <unordered_map>
#include <unordered_set>

#include "sqlynx/external.h"
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
                .name = CatalogEntry::NameInfo{.name_id = static_cast<uint32_t>(expected),
                                               .text = name,
                                               .location = sx::Location(),
                                               .tags = {proto::NameTag::KEYWORD},
                                               .occurrences = 0},
                .combined_tags = NameTags{proto::NameTag::KEYWORD},
                .score = get_score(*location, expected, name),
                .near_cursor = false,
                .external = false,
            };
            result_heap.Insert(candidate);
        }
    }
}

void findCandidatesInIndex(
    Completion& completion,
    const btree::multimap<fuzzy_ci_string_view, std::reference_wrapper<const CatalogEntry::NameInfo>>& index,
    bool external) {
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
    auto search_text = ci_prefix_text;
    if (search_text.empty()) {
        search_text = {cursor.text.data(), cursor.text.size()};
    }

    // Find all suffixes for the cursor prefix
    for (auto iter = index.lower_bound(search_text); iter != index.end() && iter->first.starts_with(search_text);
         ++iter) {
        auto& name_info = iter->second.get();
        // Determine score
        Completion::ScoreValueType score = 0;
        for (auto [tag, tag_score] : scoring_table) {
            score = std::max(score, name_info.tags.contains(tag) ? tag_score : 0);
        }
        // Is a prefix?
        switch (location->relative_pos) {
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL:
                if (fuzzy_ci_string_view{name_info.text.data(), name_info.text.size()}.starts_with(ci_prefix_text)) {
                    score += Completion::PREFIX_SCORE_MODIFIER;
                } else {
                    score += Completion::SUBSTRING_SCORE_MODIFIER;
                }
                break;
            default:
                break;
        }
        // Do we know the candidate already?
        if (auto iter = pending_candidates.find(name_info.text); iter != pending_candidates.end()) {
            // Update the score if it is higher
            iter->second.score = std::max(iter->second.score, score);
            iter->second.combined_tags |= name_info.tags;
            iter->second.external |= external;
        } else {
            // Otherwise store as new candidate
            Completion::Candidate candidate{
                .name = name_info,
                .combined_tags = name_info.tags,
                .score = score,
                .near_cursor = false,
                .external = external,
            };
            pending_candidates.insert({name_info.text, candidate});
        }
    }
}

void Completion::FindCandidatesInIndexes() {
    if (auto& analyzed = cursor.script.analyzed_script) {
        // Find candidates in name dictionary of main script
        findCandidatesInIndex(*this, analyzed->GetNameSearchIndex(), false);
        // Find candidates in name dictionary of external script
        cursor.script.catalog.IterateRanked([this](auto entry_id, auto& schema, size_t rank) {
            findCandidatesInIndex(*this, schema.GetNameSearchIndex(), true);
        });
    }
}

void Completion::FindTablesForUnresolvedColumns() {
    if (!cursor.statement_id.has_value() || !cursor.script.analyzed_script) {
        return;
    }
    auto& analyzed_script = *cursor.script.analyzed_script;
    auto& catalog = cursor.script.catalog;

    // Collect all unresolved columns in the current script
    std::vector<CatalogEntry::ResolvedTableColumn> table_columns;
    for (auto& column_ref : analyzed_script.column_references) {
        // Is unresolved?
        if (column_ref.resolved_table_id.IsNull()) {
            auto& column_name = column_ref.column_name.column_name;
            cursor.script.analyzed_script->ResolveTableColumn(column_name, catalog, table_columns);
        }
    }

    // Now find the distinct table names that contain these columns
    std::unordered_set<std::string_view> visited;
    for (auto& table_col : table_columns) {
        auto table_name = table_col.table.table_name.table_name;
        if (auto iter = pending_candidates.find(table_name);
            iter != pending_candidates.end() && !visited.contains(table_name)) {
            visited.insert(table_name);
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
    auto mark_as_near = [this](std::string_view name) {
        if (auto iter = pending_candidates.find(name); iter != pending_candidates.end()) {
            iter->second.near_cursor = true;
        }
    };

    auto& analyzed = cursor.script.analyzed_script;
    for (auto& table_ref : analyzed->table_references) {
        // The table ref is not part of a statement id?
        // Skip then, we're currently using the statement id as very coarse-granular alternative to naming scopes.
        // TODO: We should remember a fine-granular scope union-find as output of the name resolution pass.
        if (!table_ref.ast_statement_id.has_value() || table_ref.ast_statement_id.value() != statement_id) {
            continue;
        }
        mark_as_near(table_ref.table_name.database_name);
        mark_as_near(table_ref.table_name.schema_name);
        mark_as_near(table_ref.table_name.table_name);
        mark_as_near(table_ref.alias_name);

        // Add all column names of the table
        if (auto resolved = analyzed->ResolveTable(table_ref.resolved_table_id, cursor.script.catalog)) {
            for (auto& table_column : resolved->table_columns) {
                mark_as_near(table_column.column_name);
            }
        }
    }

    // Collect column references in the statement
    for (auto& column_ref : cursor.script.analyzed_script->column_references) {
        if (!column_ref.ast_statement_id.has_value() || column_ref.ast_statement_id.value() != statement_id) {
            continue;
        }
        mark_as_near(column_ref.column_name.column_name);
    }

    // TODO: For unresolved columns, bump the score of tables that contain that column.
    //       Problem: We expose such an index from name resolution and building that index ad-hoc suffers from name id
    //       mapping.
}

void Completion::FlushCandidatesAndFinish() {
    // Helper to check if two locations overlap.
    // Two ranges overlap if the sum of their widths exceeds the (max - min).
    auto intersects = [](const sx::Location& l, const sx::Location& r) {
        auto l_begin = l.offset();
        auto l_end = l_begin + l.length();
        auto r_begin = r.offset();
        auto r_end = r_begin + r.length();
        auto min = std::min(l_begin, r_begin);
        auto max = std::max(l_end, r_end);
        auto l_width = l_end - l_begin;
        auto r_width = r_end - r_begin;
        return (max - min) < (l_width + r_width);
    };

    // Find name if under cursor (if any)
    sx::Location current_symbol_location;
    if (auto& location = cursor.scanner_location; location.has_value()) {
        current_symbol_location = location->symbol.location;
    }

    // Insert all pending candidates into the heap
    for (auto& [key, candidate] : pending_candidates) {
        // Omit candidate if it occurs only once and is located under the cursor
        if (candidate.name.occurrences == 1 && !candidate.external &&
            intersects(candidate.name.location, current_symbol_location)) {
            continue;
        }
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
        candidateBuilder.add_name_text(text_offset);
        candidateBuilder.add_combined_tags(iter->combined_tags);
        candidateBuilder.add_score(iter->GetScore());
        candidateBuilder.add_near_cursor(iter->near_cursor);
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
