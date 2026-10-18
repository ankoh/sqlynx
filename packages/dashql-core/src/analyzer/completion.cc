#include "dashql/analyzer/completion.h"

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <array>
#include <variant>

#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/catalog_object.h"
#include "dashql/exception.h"
#include "dashql/parser/grammar/keywords.h"
#include "dashql/parser/parser.h"
#include "dashql/script.h"
#include "dashql/text/names.h"
#include "dashql/utils/string_conversion.h"
#include "dashql/utils/string_trimming.h"

namespace dashql {
namespace sx = buffers;

namespace {

// Tokens that suppress passive inline hints when the cursor immediately follows them.
// After these tokens, the user is about to type an identifier or expression, not a keyword.
bool suppressPassiveHint(parser::Parser::symbol_kind_type kind) {
    switch (kind) {
        case parser::Parser::symbol_kind_type::S_SELECT:
        case parser::Parser::symbol_kind_type::S_FROM:
        case parser::Parser::symbol_kind_type::S_JOIN:
        case parser::Parser::symbol_kind_type::S_WHERE:
        case parser::Parser::symbol_kind_type::S_ON:
        case parser::Parser::symbol_kind_type::S_AND:
        case parser::Parser::symbol_kind_type::S_OR:
        case parser::Parser::symbol_kind_type::S_BY:
        case parser::Parser::symbol_kind_type::S_VISUALISE:
        case parser::Parser::symbol_kind_type::S_VISUALIZE:
            return true;
        default:
            return false;
    }
}

// Keyword prevalence modifiers
// Users write some keywords much more likely than others, and we hardcode some prevalence scores.
// Example: "se" should suggest "select" before "set"
static constexpr Completion::ScoreValueType KEYWORD_A = 4;
static constexpr Completion::ScoreValueType KEYWORD_B = 3;
static constexpr Completion::ScoreValueType KEYWORD_C = 2;
static constexpr Completion::ScoreValueType KEYWORD_D = 0;

// Coarse base score of a registered name
static constexpr Completion::ScoreValueType NAME_TAG_IGNORE = 0;
static constexpr Completion::ScoreValueType NAME_TAG_UNLIKELY = 10;
static constexpr Completion::ScoreValueType NAME_TAG_LIKELY = 20;

// Fine-granular score modifiers
static constexpr Completion::ScoreValueType SUBSTRING_SCORE_MODIFIER = 30;    // User typed name substring
static constexpr Completion::ScoreValueType PREFIX_SCORE_MODIFIER = 5;        // User typed name prefix
static constexpr Completion::ScoreValueType EXACT_MATCH_SCORE_MODIFIER = 15;  // User typed exact name
// Bonus for an expected-keyword candidate whose text substring-matches the user's input.
// Applied on top of SUBSTRING_SCORE_MODIFIER so a substring-matched expected keyword outranks a
// generic substring-matched name from the index by a meaningful margin.
static constexpr Completion::ScoreValueType KEYWORD_SUBSTRING_BONUS = 20;
static constexpr Completion::ScoreValueType THROUGH_CATALOG_SCORE_MODIFIER = 2;    // Candidate comes from the catalog
static constexpr Completion::ScoreValueType RESOLVING_TABLE_SCORE_MODIFIER = 5;    // Table is resolving unresolved
static constexpr Completion::ScoreValueType UNRESOLVED_PEER_SCORE_MODIFIER = 1;    // Share unresolved table
static constexpr Completion::ScoreValueType DOT_SCHEMA_SCORE_MODIFIER = 2;         // Dot completion for schema
static constexpr Completion::ScoreValueType DOT_TABLE_SCORE_MODIFIER = 2;          // Dot completion for table
static constexpr Completion::ScoreValueType DOT_COLUMN_SCORE_MODIFIER = 2;         // Dot completion for column
static constexpr Completion::ScoreValueType IN_NAME_SCOPE_SCORE_MODIFIER = 10;     // Candidate is in scope
static constexpr Completion::ScoreValueType IN_SAME_STATEMENT_SCORE_MODIFIER = 1;  // Candidate used in same statement

// Suffix-probe modifiers. The penalty demotes keywords that the post-cursor stream can't accept
// after them. The depth bonus rewards candidates that align with deeper suffix structure — kept
// small (1 unit) so it breaks ties among k=1-compatible candidates without inflating common
// unreserved keywords above legitimate identifiers (which sit ~2 units higher via THROUGH_CATALOG
// and would otherwise lose ranking with a larger bonus).
static constexpr Completion::ScoreValueType SUFFIX_INCOMPATIBLE_PENALTY = 15;
static constexpr Completion::ScoreValueType SUFFIX_DEPTH_ONE_BONUS = 0;
static constexpr Completion::ScoreValueType SUFFIX_DEPTH_MANY_BONUS = 1;

// Identity candidate scores (context-dependent)
// At definition positions: max (always keep user's text)
// At TABLE_REF: low enough that any substring-matching catalog table wins
// At TABLE_REF_ALIAS: low enough that prefix-matching keywords (WHERE=58) win over the alias text,
//   so typing "w" after FROM suggests WHERE before treating it as an alias
// At COLUMN_REF: low enough that in-scope substring-matching columns win
static constexpr Completion::ScoreValueType IDENTITY_SCORE_TABLE_REF = 50;
static constexpr Completion::ScoreValueType IDENTITY_SCORE_TABLE_REF_ALIAS = 50;
static constexpr Completion::ScoreValueType IDENTITY_SCORE_COLUMN_REF = 59;

// Cap identity candidate length. Guards against runaway tokens (e.g. a delimited
// identifier missing its closing quote consumes everything up to the next quote).
static constexpr size_t MAX_IDENTITY_LENGTH = 64;

// Design choices for the score modifiers
static_assert((NAME_TAG_UNLIKELY + SUBSTRING_SCORE_MODIFIER) > NAME_TAG_LIKELY,
              "An unlikely name that is a substring outweighs a likely name");
static_assert(IN_NAME_SCOPE_SCORE_MODIFIER > PREFIX_SCORE_MODIFIER,
              "Candidates being available in scope weighs more than being a prefix");
static_assert(EXACT_MATCH_SCORE_MODIFIER > IN_NAME_SCOPE_SCORE_MODIFIER, "An exact match outweighs being in scope");
static_assert(SUBSTRING_SCORE_MODIFIER > IN_SAME_STATEMENT_SCORE_MODIFIER,
              "Candidates that are used elsewhere are not higher scoring than a substring match");
static_assert(IN_NAME_SCOPE_SCORE_MODIFIER > IN_SAME_STATEMENT_SCORE_MODIFIER,
              "Being in scope outweighs being referenced elsewhere");
static_assert(RESOLVING_TABLE_SCORE_MODIFIER > IN_SAME_STATEMENT_SCORE_MODIFIER,
              "Resolving unresolved columns outweighs being referenced elsewhere");
static_assert((NAME_TAG_LIKELY + THROUGH_CATALOG_SCORE_MODIFIER) > KEYWORD_SUBSTRING_BONUS,
              "A likely catalog name with prefix match outranks an expected keyword with prefix match");

Completion::ScoreValueType computeCandidateScore(Completion::CandidateTags tags) {
    Completion::ScoreValueType score = 0;
    score += ((tags & buffers::completion::CandidateTag::KEYWORD_D) != 0) * KEYWORD_D;
    score += ((tags & buffers::completion::CandidateTag::KEYWORD_C) != 0) * KEYWORD_C;
    score += ((tags & buffers::completion::CandidateTag::KEYWORD_B) != 0) * KEYWORD_B;
    score += ((tags & buffers::completion::CandidateTag::KEYWORD_A) != 0) * KEYWORD_A;

    score += ((tags & buffers::completion::CandidateTag::SUBSTRING_MATCH) != 0) * SUBSTRING_SCORE_MODIFIER;
    score += ((tags & buffers::completion::CandidateTag::PREFIX_MATCH) != 0) * PREFIX_SCORE_MODIFIER;
    score += ((tags & buffers::completion::CandidateTag::EXACT_MATCH) != 0) * EXACT_MATCH_SCORE_MODIFIER;
    // Expected-keyword + substring-match: bonus on top of SUBSTRING_SCORE_MODIFIER so keyword
    // candidates that the user is actively typing rank above generic name-index substring matches.
    {
        bool expected_kw = (tags & buffers::completion::CandidateTag::EXPECTED_PARSER_SYMBOL) != 0;
        bool substring = (tags & buffers::completion::CandidateTag::SUBSTRING_MATCH) != 0;
        score += (expected_kw && substring) * KEYWORD_SUBSTRING_BONUS;
    }
    score += ((tags & buffers::completion::CandidateTag::THROUGH_CATALOG) != 0) * THROUGH_CATALOG_SCORE_MODIFIER;
    score += ((tags & buffers::completion::CandidateTag::RESOLVING_TABLE) != 0) * RESOLVING_TABLE_SCORE_MODIFIER;
    score += ((tags & buffers::completion::CandidateTag::UNRESOLVED_PEER) != 0) * UNRESOLVED_PEER_SCORE_MODIFIER;

    score += ((tags & buffers::completion::CandidateTag::DOT_RESOLUTION_TABLE) != 0) * DOT_TABLE_SCORE_MODIFIER;
    score += ((tags & buffers::completion::CandidateTag::DOT_RESOLUTION_SCHEMA) != 0) * DOT_SCHEMA_SCORE_MODIFIER;
    score += ((tags & buffers::completion::CandidateTag::DOT_RESOLUTION_COLUMN) != 0) * DOT_COLUMN_SCORE_MODIFIER;

    score += ((tags & buffers::completion::CandidateTag::IN_NAME_SCOPE) != 0) * IN_NAME_SCOPE_SCORE_MODIFIER;
    score += ((tags & buffers::completion::CandidateTag::IN_SAME_STATEMENT) != 0) * IN_SAME_STATEMENT_SCORE_MODIFIER;

    score += ((tags & buffers::completion::CandidateTag::SUFFIX_DEPTH_ONE) != 0) * SUFFIX_DEPTH_ONE_BONUS;
    score += ((tags & buffers::completion::CandidateTag::SUFFIX_DEPTH_MANY) != 0) * SUFFIX_DEPTH_MANY_BONUS;
    Completion::ScoreValueType penalty =
        ((tags & buffers::completion::CandidateTag::SUFFIX_INCOMPATIBLE) != 0) * SUFFIX_INCOMPATIBLE_PENALTY;
    score = (score > penalty) ? (score - penalty) : 0;
    return score;
}

using NameScoringTable = std::array<std::pair<buffers::analyzer::NameTag, Completion::ScoreValueType>, 8>;

static constexpr NameScoringTable NAME_SCORE_DEFAULTS{{
    {buffers::analyzer::NameTag::NONE, NAME_TAG_IGNORE},
    {buffers::analyzer::NameTag::SCHEMA_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::DATABASE_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::TABLE_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::TABLE_ALIAS, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::COLUMN_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::FUNCTION_NAME, NAME_TAG_LIKELY},
}};

static constexpr NameScoringTable NAME_SCORE_TABLE_REF{{
    {buffers::analyzer::NameTag::NONE, NAME_TAG_IGNORE},
    {buffers::analyzer::NameTag::SCHEMA_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::DATABASE_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::TABLE_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::TABLE_ALIAS, NAME_TAG_UNLIKELY},
    {buffers::analyzer::NameTag::COLUMN_NAME, NAME_TAG_UNLIKELY},
    {buffers::analyzer::NameTag::FUNCTION_NAME, NAME_TAG_UNLIKELY},
}};

static constexpr NameScoringTable NAME_SCORE_COLUMN_REF{{
    {buffers::analyzer::NameTag::NONE, NAME_TAG_IGNORE},
    {buffers::analyzer::NameTag::SCHEMA_NAME, NAME_TAG_UNLIKELY},
    {buffers::analyzer::NameTag::DATABASE_NAME, NAME_TAG_UNLIKELY},
    {buffers::analyzer::NameTag::TABLE_NAME, NAME_TAG_UNLIKELY},
    {buffers::analyzer::NameTag::TABLE_ALIAS, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::COLUMN_NAME, NAME_TAG_LIKELY},
    {buffers::analyzer::NameTag::FUNCTION_NAME, NAME_TAG_UNLIKELY},
}};

/// We use a prevalence score to rank keywords by popularity.
/// It is much more likely that a user wants to complete certain keywords than others.
/// The added score is chosen so small that it only influences the ranking among similarly ranked keywords.
/// (i.e., being prefix, substring or in-scope outweighs the prevalence score)
static constexpr buffers::completion::CandidateTag GetKeywordPrevalence(parser::Parser::symbol_kind_type keyword) {
    switch (keyword) {
        case parser::Parser::symbol_kind_type::S_SELECT:
        case parser::Parser::symbol_kind_type::S_FROM:
        case parser::Parser::symbol_kind_type::S_WHERE:
            return buffers::completion::CandidateTag::KEYWORD_A;
        case parser::Parser::symbol_kind_type::S_AND:
        case parser::Parser::symbol_kind_type::S_GROUP_P:
        case parser::Parser::symbol_kind_type::S_ORDER:
            return buffers::completion::CandidateTag::KEYWORD_B;
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
            return buffers::completion::CandidateTag::KEYWORD_C;
        case parser::Parser::symbol_kind_type::S_BETWEEN:
        case parser::Parser::symbol_kind_type::S_DAY_P:
        case parser::Parser::symbol_kind_type::S_PARTITION:
        case parser::Parser::symbol_kind_type::S_SETOF:
        default:
            return buffers::completion::CandidateTag::KEYWORD_D;
    }
}

bool doNotCompleteSymbol(parser::Parser::symbol_type& sym) { return !Completion::IsSymbolKindCompletable(sym.kind_); }

bool isScopeWithin(const AnalyzedScript::NameScope& scope, const AnalyzedScript::NameScope* ancestor) {
    // Scope objects form a parent chain even when an incomplete query leaves holes in the AST.
    // Use that semantic chain to decide CTE visibility instead of relying on text containment.
    for (auto* current = &scope; current != nullptr; current = current->parent_scope) {
        if (current == ancestor) return true;
    }
    return false;
}

template <typename Callback>
void forEachResolvedCTEColumn(const ResolvedCTE& cte, Callback&& callback) {
    if (!cte.child_scope) return;
    for (size_t i = 0; i < cte.child_scope->output_columns.size(); ++i) {
        auto& output = cte.child_scope->output_columns[i];
        auto& name = i < cte.column_aliases.size() ? cte.column_aliases[i].get() : output.column_name.get();
        if (!name.text.empty()) callback(name);
    }
}

// Keyword continuation scores.
// When a keyword or identifier has multiple valid next-tokens in the grammar,
// we pick the uniquely highest-scored one as the suggested continuation.
uint8_t getKeywordContinuationScore(parser::Parser::symbol_kind_type sym) {
    switch (sym) {
        // Keywords that almost always follow their predecessor
        case parser::Parser::symbol_kind_type::S_BY:
        case parser::Parser::symbol_kind_type::S_AS:
        case parser::Parser::symbol_kind_type::S_EQUALS_GREATER:
        case parser::Parser::symbol_kind_type::S_ON:
        case parser::Parser::symbol_kind_type::S_SELECT:
        case parser::Parser::symbol_kind_type::S_INTO:
        case parser::Parser::symbol_kind_type::S_TABLE:
        case parser::Parser::symbol_kind_type::S_SET:
            return 10;
        // Join qualifiers
        case parser::Parser::symbol_kind_type::S_OUTER_P:
        // Ordering / window continuations (appear in specialized contexts)
        case parser::Parser::symbol_kind_type::S_ASC_P:
        case parser::Parser::symbol_kind_type::S_DESC_P:
        case parser::Parser::symbol_kind_type::S_NULLS_P:
        case parser::Parser::symbol_kind_type::S_FIRST_P:
        case parser::Parser::symbol_kind_type::S_LAST_P:
        case parser::Parser::symbol_kind_type::S_UNBOUNDED:
        case parser::Parser::symbol_kind_type::S_PRECEDING:
        case parser::Parser::symbol_kind_type::S_CURRENT_P:
        case parser::Parser::symbol_kind_type::S_ROW:
        case parser::Parser::symbol_kind_type::S_WITHIN:
        case parser::Parser::symbol_kind_type::S_SETS:
            return 6;
        default:
            return 0;
    }
}

}  // namespace

bool Completion::IsSymbolKindCompletable(parser::Parser::symbol_kind_type kind) {
    switch (kind) {
        case parser::Parser::symbol_kind_type::S_SCONST:
        case parser::Parser::symbol_kind_type::S_ICONST:
        case parser::Parser::symbol_kind_type::S_FCONST:
        case parser::Parser::symbol_kind_type::S_BCONST:
        case parser::Parser::symbol_kind_type::S_XCONST:
        case parser::Parser::symbol_kind_type::S_COMMA:
        case parser::Parser::symbol_kind_type::S_LRB:
        case parser::Parser::symbol_kind_type::S_RRB:
        case parser::Parser::symbol_kind_type::S_LSB:
        case parser::Parser::symbol_kind_type::S_RSB:
        case parser::Parser::symbol_kind_type::S_SEMICOLON:
        case parser::Parser::symbol_kind_type::S_COLON:
        case parser::Parser::symbol_kind_type::S_PLUS:
        case parser::Parser::symbol_kind_type::S_MINUS:
        case parser::Parser::symbol_kind_type::S_STAR:
        case parser::Parser::symbol_kind_type::S_DIVIDE:
        case parser::Parser::symbol_kind_type::S_MODULO:
        case parser::Parser::symbol_kind_type::S_QUESTION_MARK:
        case parser::Parser::symbol_kind_type::S_PARAM:
        case parser::Parser::symbol_kind_type::S_CIRCUMFLEX:
        case parser::Parser::symbol_kind_type::S_LESS_THAN:
        case parser::Parser::symbol_kind_type::S_GREATER_THAN:
        case parser::Parser::symbol_kind_type::S_EQUALS:
        case parser::Parser::symbol_kind_type::S_Op:
        case parser::Parser::symbol_kind_type::S_EQUALS_GREATER:
        case parser::Parser::symbol_kind_type::S_LESS_EQUALS:
        case parser::Parser::symbol_kind_type::S_GREATER_EQUALS:
        case parser::Parser::symbol_kind_type::S_NOT_EQUALS:
        case parser::Parser::symbol_kind_type::S_DOT_STAR_LA:
            return false;
        default:
            return true;
    }
}

std::span<std::string_view> Completion::GetQualifiedFunctionName(const CatalogEntry::QualifiedFunctionName& name) {
    std::vector<std::string_view> names;
    names.reserve(3);
    if (!name.database_name.get().text.empty()) {
        names.push_back(name.database_name.get().text);
        names.push_back(name.schema_name.get().text);
        names.push_back(name.function_name.get().text);
    } else if (!name.schema_name.get().text.empty()) {
        names.push_back(name.schema_name.get().text);
        names.push_back(name.function_name.get().text);
    } else if (!name.function_name.get().text.empty()) {
        names.push_back(name.function_name.get().text);
    }
    return top_candidate_names.PushBack(std::move(names));
}

std::span<std::string_view> Completion::GetQualifiedTableName(const CatalogEntry::QualifiedTableName& name) {
    std::vector<std::string_view> names;
    names.reserve(3);
    if (!name.database_name.get().text.empty()) {
        names.push_back(name.database_name.get().text);
        names.push_back(name.schema_name.get().text);
        names.push_back(name.table_name.get().text);
    } else if (!name.schema_name.get().text.empty()) {
        names.push_back(name.schema_name.get().text);
        names.push_back(name.table_name.get().text);
    } else if (!name.table_name.get().text.empty()) {
        names.push_back(name.table_name.get().text);
    }
    return top_candidate_names.PushBack(std::move(names));
}

std::span<std::string_view> Completion::GetQualifiedColumnName(const CatalogEntry::QualifiedTableName& name,
                                                               const RegisteredName& column) {
    std::vector<std::string_view> names;
    names.reserve(4);
    if (!name.database_name.get().text.empty()) {
        names.push_back(name.database_name.get().text);
        names.push_back(name.schema_name.get().text);
        names.push_back(name.table_name.get().text);
    } else if (!name.schema_name.get().text.empty()) {
        names.push_back(name.schema_name.get().text);
        names.push_back(name.table_name.get().text);
    } else if (!name.table_name.get().text.empty()) {
        names.push_back(name.table_name.get().text);
    }
    names.push_back(column.text);
    return top_candidate_names.PushBack(std::move(names));
}

std::span<std::string_view> Completion::GetQualifiedColumnName(const RegisteredName& alias,
                                                               const RegisteredName& column) {
    std::vector<std::string_view> names;
    names.reserve(2);
    names.push_back(alias.text);
    names.push_back(column.text);
    return top_candidate_names.PushBack(std::move(names));
}

void Completion::FindCandidatesForNamePath() {
    // A trailing dot followed by more SQL may not belong to a materialized column-ref AST node.
    // ScriptCursor marks that recovered case with a sentinel expression id. Resolve the alias
    // directly from its recovered name scope so `q.| ...` still lists q's columns.
    if (auto* ctx = std::get_if<ScriptCursor::ColumnRefContext>(&cursor.context);
        ctx != nullptr && ctx->expression_id == std::numeric_limits<uint32_t>::max()) {
        auto& scan = *cursor.script.scanned_script;
        const auto& current = *target_scanner_symbol;
        const auto* dot = (current.symbolIsDot() || current.symbolIsTrailingDot())
                              ? &current
                              : cursor.scanner_location->previous.has_value() &&
                                        (cursor.scanner_location->previous->symbolIsDot() ||
                                         cursor.scanner_location->previous->symbolIsTrailingDot())
                                    ? &*cursor.scanner_location->previous
                                    : nullptr;
        if (dot == nullptr) return;

        const auto& input = scan.GetInput();
        size_t alias_end = std::min<size_t>(dot->symbol.location.offset(), input.size());
        while (alias_end > 0 && input[alias_end - 1] == '.') --alias_end;
        size_t alias_begin = alias_end;
        while (alias_begin > 0 &&
               (std::isalnum(static_cast<unsigned char>(input[alias_begin - 1])) || input[alias_begin - 1] == '_')) {
            --alias_begin;
        }
        const auto alias_text = input.substr(alias_begin, alias_end - alias_begin);
        const auto alias_offset = static_cast<uint32_t>(alias_begin);

        // The qualifier is sealed: completion inserts only after the dot, while the qualified
        // range includes `alias.` for callers that later need to replace the whole name path.
        const sx::parser::SymbolSpan replace_at{static_cast<uint32_t>(cursor.text_offset), 0};
        const sx::parser::SymbolSpan qualified_at{alias_offset,
                                                  static_cast<uint32_t>(cursor.text_offset - alias_offset)};
        for (auto& scope_ref : cursor.name_scopes) {
            const auto table = scope_ref.get().referenced_tables_by_name.find(alias_text);
            if (table == scope_ref.get().referenced_tables_by_name.end()) continue;
            if (auto* declaration = std::get_if<std::reference_wrapper<const CatalogEntry::TableDeclaration>>(
                    &table->second.source)) {
                for (const auto& column : declaration->get().table_columns) {
                    AddLocalCandidate(column.column_name.get().text,
                                      NameTags{buffers::analyzer::NameTag::COLUMN_NAME},
                                      CandidateTags{buffers::completion::CandidateTag::DOT_RESOLUTION_COLUMN,
                                                    buffers::completion::CandidateTag::IN_NAME_SCOPE},
                                      {}, replace_at, qualified_at);
                }
            } else if (!table->second.IsUnresolvedRelation()) {
                const auto& cte = std::get<std::reference_wrapper<ResolvedCTE>>(table->second.source).get();
                forEachResolvedCTEColumn(cte, [&](const RegisteredName& name) {
                    AddLocalCandidate(name.text, NameTags{buffers::analyzer::NameTag::COLUMN_NAME},
                                      CandidateTags{buffers::completion::CandidateTag::DOT_RESOLUTION_COLUMN,
                                                    buffers::completion::CandidateTag::IN_NAME_SCOPE},
                                      {}, replace_at, qualified_at);
                });
            }
            return;
        }
        return;
    }

    // The cursor location
    auto cursor_location = target_scanner_symbol->text_offset;
    // Read the name path
    sx::parser::SymbolSpan name_path_loc;
    auto name_path_buffer = cursor.ReadCursorNamePath(name_path_loc);

    std::span<ScriptCursor::NameComponent> name_path = name_path_buffer;

    // Filter all name components in the path.
    // A name path could also contain an index indirection or a star.
    // We're only interested in the names here.
    // If the user completes a name with index or star, we'll just truncate everything.
    size_t name_count = 0;
    // Additionally find the sealed prefix.
    // If we're completing after a dot, the word before the dot is not meant to be completed.
    size_t sealed = 0;

    // Last text prefix
    std::string_view last_text_prefix;
    auto& scan = *cursor.script.scanned_script;
    auto name_path_ts = scan.ResolveTextSpan(name_path_loc);
    uint32_t truncate_at = name_path_ts.offset() + name_path_ts.length();
    for (; name_count < name_path.size(); ++name_count) {
        auto comp_ts = scan.ResolveTextSpan(name_path[name_count].loc);
        if (name_path[name_count].type == ScriptCursor::NameComponentType::TrailingDot) {
            truncate_at = comp_ts.offset() + 1;
            break;
        }
        if (name_path[name_count].type != ScriptCursor::NameComponentType::Name) {
            truncate_at = comp_ts.offset();
            break;
        }
        if ((comp_ts.offset() + comp_ts.length()) < cursor_location) {
            ++sealed;
        } else {
            // The cursor points into a name?

            // Determine the substring left of the cursor.
            // The user may write:
            //  foo.bar.something
            //              ^ if the cursor points to t, we'll complete "some"
            //
            auto last_text = scan.ReadTextAtSymbolSpan(name_path[name_count].loc);
            auto last_content =
                std::find_if(last_text.begin(), last_text.end(), is_no_double_quote) - last_text.begin();
            auto last_content_ofs = comp_ts.offset() + last_content;
            auto last_prefix_length = std::max<size_t>(cursor_location, last_content_ofs) - last_content_ofs;
            last_text_prefix = last_text.substr(last_content, last_prefix_length);

            // Truncate when replacing
            truncate_at = comp_ts.offset();
            break;
        }
    }
    name_path = name_path.subspan(0, name_count);

    // Determine text ranges to replace (text-offset-based SymbolSpans for the editor)
    const auto script_length = static_cast<uint32_t>(cursor.script.text.GetStats().text_bytes);
    const auto name_path_end = std::min<uint32_t>(name_path_ts.offset() + name_path_ts.length(), script_length);
    sx::parser::SymbolSpan replace_text_at{
        truncate_at, std::max<uint32_t>(name_path_end, truncate_at) - truncate_at};
    sx::parser::SymbolSpan name_path_text_loc{
        name_path_ts.offset(), std::max<uint32_t>(name_path_end, name_path_ts.offset()) - name_path_ts.offset()};

    // Is the path empty?
    // Nothing to complete then.
    if (name_path.size() == 0) {
        return;
    }

    /// A dot candidate
    struct DotCandidate {
        std::string_view name;
        CandidateTags candidate_tags;
        NameTags name_tags;
        QualifiedCatalogObjectID object_id;
        const CatalogObject& object;
    };
    // Collect all candidate strings
    std::vector<DotCandidate> dot_candidates;

    if (std::get_if<ScriptCursor::TableRefContext>(&cursor.context)) {
        auto& script = cursor.script;

        switch (sealed) {
            case 0:
                break;
            case 1: {
                // User gave us a._
                // "a" might be a database name or a schema name

                // Is referring to a schema in the default database?
                std::string_view a_text = name_path[0].name.value().get();
                std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>> tables;
                script.analyzed_script->ResolveSchemaTablesWithCatalog(a_text, tables);
                if (!tables.empty()) {
                    // Add the tables as candidates
                    for (auto& [table, through_catalog] : tables) {
                        // XXX Also discover tables with different schemas
                        //     We can rank entries higher that are in the default database

                        // Store the candidate
                        auto& name = table.get().table_name.table_name.get();
                        DotCandidate candidate{
                            .name = name.text,
                            .candidate_tags = {buffers::completion::CandidateTag::DOT_RESOLUTION_TABLE},
                            .name_tags = {buffers::analyzer::NameTag::TABLE_NAME},
                            .object_id = table.get().object_id,
                            .object = table.get().CastToBase()};
                        candidate.candidate_tags.AddIf(buffers::completion::CandidateTag::THROUGH_CATALOG,
                                                       through_catalog);
                        dot_candidates.push_back(std::move(candidate));
                    }
                }

                // Is referring to a database?
                std::vector<std::pair<std::reference_wrapper<const CatalogEntry::SchemaReference>, bool>> schemas;
                script.analyzed_script->ResolveDatabaseSchemasWithCatalog(a_text, schemas);
                if (!schemas.empty()) {
                    // Add the schemas name as candidates
                    for (auto& [schema, through_catalog] : schemas) {
                        // Store the candidate
                        auto& name = schema.get().schema_name;
                        DotCandidate candidate{
                            .name = name,
                            .candidate_tags = {buffers::completion::CandidateTag::DOT_RESOLUTION_SCHEMA},
                            .name_tags = NameTags{buffers::analyzer::NameTag::SCHEMA_NAME},
                            .object_id = schema.get().object_id,
                            .object = schema.get().CastToBase()};
                        candidate.candidate_tags.AddIf(buffers::completion::CandidateTag::THROUGH_CATALOG,
                                                       through_catalog);
                        dot_candidates.push_back(std::move(candidate));
                    }
                }
                break;
            }
            case 2: {
                // User gave us a.b._
                // "a" must be a database name, "b" must be a schema name.
                std::string_view a_text = name_path[0].name.value().get();
                std::string_view b_text = name_path[1].name.value().get();

                // Is a known?
                std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>> tables;
                script.analyzed_script->ResolveSchemaTablesWithCatalog(a_text, b_text, tables);
                if (!tables.empty()) {
                    // Add the tables as candidates
                    for (auto& [table, through_catalog] : tables) {
                        auto& name = table.get().table_name.table_name.get();
                        DotCandidate candidate{
                            .name = name,
                            .candidate_tags = {buffers::completion::CandidateTag::DOT_RESOLUTION_TABLE},
                            .name_tags = NameTags{buffers::analyzer::NameTag::TABLE_NAME},
                            .object_id = table.get().object_id,
                            .object = {table.get().CastToBase()}};
                        candidate.candidate_tags.AddIf(buffers::completion::CandidateTag::THROUGH_CATALOG,
                                                       through_catalog);
                        dot_candidates.push_back(std::move(candidate));
                    }
                }
                break;
            }
            case 3:
                // User gave us a.b.c._ ?
                // Don't resolve any candidates, not supported.
                break;
        }
    }

    // Are we completing a column ref?
    else if (auto* ctx = std::get_if<ScriptCursor::ColumnRefContext>(&cursor.context)) {
        (void)ctx;
        auto& script = cursor.script;
        switch (sealed) {
            case 0:
                break;
            case 1: {
                // User gave us a._
                // "a" might be a table alias
                std::string_view a_text = name_path[0].name.value().get();

                // Check all naming scopes for tables that are in scope.
                for (auto& name_scope : cursor.name_scopes) {
                    // Does the name refer to a resolved named table in the scope?
                    // This means we're dot-completing a known table alias from here on.
                    auto table_iter = name_scope.get().referenced_tables_by_name.find(a_text);
                    if (table_iter != name_scope.get().referenced_tables_by_name.end()) {
                        auto& ref_table = table_iter->second;
                        if (auto* table_ref = std::get_if<std::reference_wrapper<const CatalogEntry::TableDeclaration>>(
                                &ref_table.source)) {
                            auto& table_decl = table_ref->get();
                            for (auto& column : table_decl.table_columns) {
                                auto& name = column.column_name.get();
                                DotCandidate candidate{
                                    .name = name,
                                    .candidate_tags = {buffers::completion::CandidateTag::DOT_RESOLUTION_COLUMN},
                                    .name_tags = NameTags{buffers::analyzer::NameTag::COLUMN_NAME},
                                    .object_id = column.object_id,
                                    .object = {column.CastToBase()}};
                                candidate.candidate_tags.AddIf(
                                    buffers::completion::CandidateTag::THROUGH_CATALOG,
                                    table_decl.GetTableID().GetOrigin() != script.GetCatalogEntryId());
                                dot_candidates.push_back(std::move(candidate));
                            }
                        } else if (!ref_table.IsUnresolvedRelation()) {
                            auto& cte = std::get<std::reference_wrapper<ResolvedCTE>>(ref_table.source).get();
                            forEachResolvedCTEColumn(cte, [&](const RegisteredName& name) {
                                AddLocalCandidate(
                                    name.text, NameTags{buffers::analyzer::NameTag::COLUMN_NAME},
                                    CandidateTags{buffers::completion::CandidateTag::DOT_RESOLUTION_COLUMN,
                                                  buffers::completion::CandidateTag::IN_NAME_SCOPE},
                                    last_text_prefix, replace_text_at, name_path_text_loc);
                            });
                        }
                        break;
                    }
                    if (name_scope.get().column_correlation_barrier) break;
                }
                break;
            }
        }
    }

    for (auto& dot_candidate : dot_candidates) {
        // Did we already add the dot candidate?
        if (auto iter = candidate_objects_by_id.find(dot_candidate.object_id); iter != candidate_objects_by_id.end()) {
            // Update candidate tags and replacement target
            auto& candidate_object = iter->second.get();
            candidate_object.candidate_tags |= dot_candidate.candidate_tags;
            candidate_object.candidate.target_location = replace_text_at;
            candidate_object.candidate.target_location_qualified = name_path_text_loc;
            assert(candidate_object.candidate.completion_text == dot_candidate.name);

        } else {
            // If the user gave us a text, determine the substring match
            if (!last_text_prefix.empty()) {
                // Check if we have a prefix
                fuzzy_ci_string_view ci_name{dot_candidate.name.data(), dot_candidate.name.size()};
                if (auto pos = ci_name.find(fuzzy_ci_string_view{last_text_prefix.data(), last_text_prefix.size()});
                    pos != fuzzy_ci_string_view::npos) {
                    dot_candidate.candidate_tags |= buffers::completion::CandidateTag::SUBSTRING_MATCH;
                    if (pos == 0) {
                        dot_candidate.candidate_tags |= buffers::completion::CandidateTag::PREFIX_MATCH;
                        if (last_text_prefix.size() == dot_candidate.name.size()) {
                            dot_candidate.candidate_tags |= buffers::completion::CandidateTag::EXACT_MATCH;
                        }
                    }
                }
            }
            // No, do we know the candidate name already?
            if (auto iter = candidates_by_name.find(dot_candidate.name); iter != candidates_by_name.end()) {
                // Name is there, just not the object
                auto& existing = iter->second.get();
                // Fix text replacement
                existing.target_location = replace_text_at;
                existing.target_location_qualified = name_path_text_loc;
                // Allocate the candidate object
                auto& co = candidate_objects.PushBack(CandidateCatalogObject{
                    .candidate = existing,
                    .candidate_tags = dot_candidate.candidate_tags,
                    .catalog_object_id = dot_candidate.object_id,
                    .catalog_object = dot_candidate.object,
                });
                existing.catalog_objects.PushBack(co);
                existing.candidate_tags |= dot_candidate.candidate_tags;

                assert(!candidate_objects_by_id.contains(dot_candidate.object_id));
                candidate_objects_by_id.insert({dot_candidate.object_id, co});

            } else {
                // Allocate the candidate
                auto& c = candidates.PushBack(Candidate{
                    .completion_text = dot_candidate.name,
                    .coarse_name_tags = dot_candidate.name_tags,
                    .candidate_tags = dot_candidate.candidate_tags,
                    .target_location = replace_text_at,
                    .target_location_qualified = name_path_text_loc,
                    .catalog_objects = {},
                });
                candidates_by_name.insert({c.completion_text, c});

                // Allocate the candidate object
                auto& co = candidate_objects.PushBack(CandidateCatalogObject{
                    .candidate = c,
                    .candidate_tags = dot_candidate.candidate_tags,
                    .catalog_object_id = dot_candidate.object_id,
                    .catalog_object = dot_candidate.object,
                });
                c.catalog_objects.PushBack(co);

                assert(!candidate_objects_by_id.contains(dot_candidate.object_id));
                candidate_objects_by_id.insert({dot_candidate.object_id, co});
            }
        }
    }
}

bool Completion::computeHasPostCursorToken() const {
    if (!target_scanner_symbol.has_value()) return false;
    auto& target_symbol = target_scanner_symbol;
    auto& scanner_symbols = cursor.script.scanned_script->GetSymbols();

    // Pick the symbol id at which the candidate is fed and decide whether feeding replaces the
    // token at that id (typing on a token) or inserts before it (cursor in whitespace). The
    // post-cursor token used to test compatibility is the next real entry after the consumed
    // span (i.e. one entry past target when replacing, the target itself when inserting).
    using RelativePos = ScannedScript::LocationInfo::RelativePosition;
    auto post_id = target_symbol->symbol_id;
    bool replace_target = target_symbol->relative_pos == RelativePos::BEGIN_OF_SYMBOL ||
                          target_symbol->relative_pos == RelativePos::MID_OF_SYMBOL ||
                          target_symbol->relative_pos == RelativePos::END_OF_SYMBOL;
    if (target_symbol->relative_pos == RelativePos::AFTER_SYMBOL &&
        !scanner_symbols.IsAtEOF(target_symbol->symbol_id)) {
        post_id = scanner_symbols.GetNext(target_symbol->symbol_id);  // insert mode: displaced real token
    } else if (replace_target && !scanner_symbols.IsAtEOF(target_symbol->symbol_id)) {
        post_id = scanner_symbols.GetNext(target_symbol->symbol_id);
    }
    // There is post-cursor context only when there is at least one real token after the feed point.
    // The scanner emits an EOF token; treat the entry at-or-past EOF as no post-cursor context.
    if (scanner_symbols.IsAtEOF(post_id)) return false;
    return scanner_symbols[post_id].kind() != parser::Parser::symbol_kind_type::S_YYEOF;
}

void Completion::AddExpectedKeywordsAsCandidates(std::span<parser::Parser::ExpectedSymbol> symbols,
                                                 const parser::Parser::PrefixSnapshot& prefix) {
    auto& target_symbol = target_scanner_symbol;
    auto& scanned = *cursor.script.scanned_script;
    auto& scanner_symbols = scanned.GetSymbols();

    // Pick the symbol id at which the candidate is fed and decide whether feeding replaces the
    // token at that id (typing on a token) or inserts before it (cursor in whitespace).
    using RelativePos = ScannedScript::LocationInfo::RelativePosition;
    auto feed_id = target_symbol->symbol_id;
    bool replace_target = target_symbol->relative_pos == RelativePos::BEGIN_OF_SYMBOL ||
                          target_symbol->relative_pos == RelativePos::MID_OF_SYMBOL ||
                          target_symbol->relative_pos == RelativePos::END_OF_SYMBOL;
    if (target_symbol->relative_pos == RelativePos::AFTER_SYMBOL &&
        !scanner_symbols.IsAtEOF(target_symbol->symbol_id)) {
        feed_id = scanner_symbols.GetNext(target_symbol->symbol_id);  // insert mode
    }
    // The suffix probe is meaningful only when there is at least one real token after the feed point.
    bool have_post_cursor_token = has_post_cursor_token;

    // Helper to determine the score of a cursor symbol
    auto get_score = [&](const ScannedScript::SymbolLocationInfo& loc, parser::Parser::ExpectedSymbol expected,
                         std::string_view keyword_text) -> CandidateTags {
        fuzzy_ci_string_view ci_keyword_text{keyword_text.data(), keyword_text.size()};
        using Relative = ScannedScript::LocationInfo::RelativePosition;

        CandidateTags tags = buffers::completion::CandidateTag::EXPECTED_PARSER_SYMBOL;
        tags |= GetKeywordPrevalence(expected);

        switch (target_symbol->relative_pos) {
            case Relative::AFTER_SYMBOL:
            case Relative::BEFORE_SYMBOL:
                return tags;
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL: {
                auto symbol_ofs = target_symbol->symbol.location.offset();
                auto symbol_prefix = std::max<uint32_t>(target_symbol->text_offset, symbol_ofs) - symbol_ofs;
                auto symbol_text = cursor.script.scanned_script->ReadTextAtTextSpan(sx::parser::TextSpan(
                    target_symbol->symbol.location.offset(), target_symbol->symbol.location.length()));
                auto symbol_text_trimmed = trim_view({symbol_text.data(), symbol_prefix}, is_no_double_quote);
                fuzzy_ci_string_view ci_symbol_text{symbol_text_trimmed.data(), symbol_text_trimmed.length()};
                // Is substring? (only match when the user has actually typed something)
                if (!ci_symbol_text.empty()) {
                    if (auto pos = ci_keyword_text.find(ci_symbol_text); pos != fuzzy_ci_string_view::npos) {
                        tags |= buffers::completion::CandidateTag::SUBSTRING_MATCH;
                        if (pos == 0) {
                            tags |= buffers::completion::CandidateTag::PREFIX_MATCH;
                            if (ci_symbol_text.size() == ci_keyword_text.size()) {
                                tags |= buffers::completion::CandidateTag::EXACT_MATCH;
                            }
                        }
                    }
                }
                return tags;
            }
        }
        return tags;
    };

    // Determine target location: use cursor position with zero length when between symbols (pure insertion)
    auto target_loc = between_symbols ? sx::parser::SymbolSpan(cursor.text_offset, 0) : target_symbol->symbol.location;
    bool inside_select = false;
    if (cursor.script.parsed_script) {
        auto& nodes = cursor.script.parsed_script->nodes;
        inside_select = std::ranges::any_of(cursor.ast_path_to_root, [&](auto node_id) {
            return nodes[node_id].node_type() == buffers::parser::NodeType::OBJECT_SQL_SELECT;
        });
    }

    // First pass: collect the keyword candidates we want to probe (those with a non-empty name).
    // We also remember each one's index in the input span so we can stitch probe results back.
    std::vector<parser::Parser::symbol_kind_type> probe_kinds;
    std::vector<size_t> probe_input_idx;
    if (have_post_cursor_token) {
        probe_kinds.reserve(symbols.size());
        probe_input_idx.reserve(symbols.size());
        for (size_t i = 0; i < symbols.size(); ++i) {
            if (!parser::Keyword::GetKeywordName(symbols[i]).empty()) {
                probe_kinds.push_back(symbols[i].symbol);
                probe_input_idx.push_back(i);
            }
        }
    }

    // Reuse the prefix snapshot the caller already captured so the probe doesn't reparse.
    std::vector<parser::Parser::SuffixProbe> probes;
    if (!probe_kinds.empty()) {
        probes = parser::Parser::ProbeSuffixBatchFromSnapshot(scanned, feed_id, prefix, probe_kinds, replace_target);
    }
    auto next_probe = probes.begin();
    auto next_probe_input_idx = probe_input_idx.begin();
    auto suffix_tags = [&](size_t i) -> CandidateTags {
        CandidateTags extra;
        if (next_probe == probes.end() || *next_probe_input_idx != i) return extra;
        const auto& probe = *next_probe++;
        ++next_probe_input_idx;
        if (!probe.k1_compatible) {
            extra |= buffers::completion::CandidateTag::SUFFIX_INCOMPATIBLE;
        } else if (probe.reached_eof || probe.depth_consumed >= 2) {
            extra |= buffers::completion::CandidateTag::SUFFIX_DEPTH_MANY;
        } else if (probe.depth_consumed == 1) {
            extra |= buffers::completion::CandidateTag::SUFFIX_DEPTH_ONE;
        }
        return extra;
    };

    for (size_t i = 0; i < symbols.size(); ++i) {
        auto& expected = symbols[i];
        auto name = parser::Keyword::GetKeywordName(expected);
        if (name.empty()) continue;
        auto tags = get_score(*target_symbol, expected, name);
        // Do not surface a leading FROM as a proactive standard-SQL suggestion; users can still
        // opt in by typing a matching prefix.
        if (expected == parser::Parser::symbol_kind_type::S_FROM && !inside_select &&
            (tags & buffers::completion::CandidateTag::SUBSTRING_MATCH) == 0) {
            continue;
        }
        tags |= suffix_tags(i);
        Candidate candidate{
            .completion_text = name,
            .coarse_name_tags = {},
            .candidate_tags = tags,
            .target_location = target_loc,
            .target_location_qualified = target_loc,
            .score = computeCandidateScore(tags),
            .keyword_symbol = expected,
        };
        candidate_heap.Insert(std::move(candidate));
    }
}

void Completion::findCandidatesInIndex(const CatalogEntry::NameSearchIndex& index, bool through_catalog) {
    using Relative = ScannedScript::LocationInfo::RelativePosition;
    auto& target_symbol = target_scanner_symbol;
    auto cursor_offset = cursor.text_offset;

    // Get the current cursor prefix
    auto symbol_ofs = target_symbol->symbol.location.offset();
    auto safe_cursor_offset =
        std::min(std::max<uint32_t>(symbol_ofs, cursor_offset), symbol_ofs + target_symbol->symbol.location.length());
    auto symbol_text = cursor.script.scanned_script->ReadTextAtTextSpan(
        sx::parser::TextSpan(target_symbol->symbol.location.offset(), target_symbol->symbol.location.length()));
    auto symbol_prefix =
        std::min<uint32_t>(std::max<uint32_t>(safe_cursor_offset, symbol_ofs) - symbol_ofs, symbol_text.size());
    auto symbol_text_trimmed = trim_view({symbol_text.data(), symbol_prefix}, is_no_double_quote);
    fuzzy_ci_string_view ci_prefix_text{symbol_text_trimmed.data(), symbol_text_trimmed.size()};

    // Fall back to the full word if the cursor prefix is empty
    auto search_text = ci_prefix_text;
    if (search_text.empty()) {
        auto token_unquoted = trim_view(symbol_text, is_no_double_quote);
        search_text = {token_unquoted.data(), token_unquoted.size()};
    }

    // Find all suffixes for the cursor prefix
    for (auto iter = index.lower_bound(search_text); iter != index.end() && iter->first.starts_with(search_text);
         ++iter) {
        auto& name_info = iter->second.get();
        // Check if it's the cursor symbol
        if (!through_catalog && name_info.occurrences == 1 &&
            target_symbol->text_offset >= name_info.location.offset() &&
            target_symbol->text_offset <= (name_info.location.offset() + name_info.location.length())) {
            continue;
        }
        // Determine the candidate tags
        Completion::CandidateTags candidate_tags{buffers::completion::CandidateTag::NAME_INDEX};
        // Added through catalog?
        candidate_tags.AddIf(buffers::completion::CandidateTag::THROUGH_CATALOG, through_catalog);
        // Is a prefix?
        switch (target_symbol->relative_pos) {
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL:
                candidate_tags |= buffers::completion::CandidateTag::SUBSTRING_MATCH;
                if (fuzzy_ci_string_view{name_info.text.data(), name_info.text.size()}.starts_with(ci_prefix_text)) {
                    candidate_tags |= buffers::completion::CandidateTag::PREFIX_MATCH;
                    if (ci_prefix_text.size() == name_info.text.size()) {
                        candidate_tags |= buffers::completion::CandidateTag::EXACT_MATCH;
                    }
                }
                break;
            default:
                break;
        }

        // Do we know the candidate already?
        Candidate* candidate;
        if (auto iter = candidates_by_name.find(name_info.text); iter != candidates_by_name.end()) {
            candidate = &iter->second.get();
            candidate->coarse_name_tags |= name_info.coarse_analyzer_tags;
            candidate->candidate_tags |= candidate_tags;
        } else {
            candidate = &candidates.PushBack(Candidate{
                .completion_text = name_info.text,
                .coarse_name_tags = name_info.coarse_analyzer_tags,
                .candidate_tags = candidate_tags,
                .target_location = target_symbol->symbol.location,
                .target_location_qualified = target_symbol->symbol.location,
                .catalog_objects = {},
            });
            candidates_by_name.insert({name_info.text, *candidate});
        }

        // Add the resolved objects
        for (auto& o : name_info.resolved_objects) {
            // Already registered?
            if (auto iter = candidate_objects_by_id.find(o.object_id); iter != candidate_objects_by_id.end()) {
                // Note that this assumes that a catalog object can be added to at most a single candidate.
                assert(&iter->second.get().candidate == candidate);
                iter->second.get().candidate_tags |= candidate_tags;
                continue;
            } else {
                // Allocate the catalog object
                auto& co = candidate_objects.PushBack(CandidateCatalogObject{
                    .candidate = *candidate,
                    .candidate_tags = candidate_tags,
                    .catalog_object_id = o.object_id,
                    .catalog_object = o,
                });
                candidate->catalog_objects.PushBack(co);

                assert(!candidate_objects_by_id.contains(o.object_id));
                candidate_objects_by_id.insert({o.object_id, co});
            }
        }
    }
}

void Completion::FindCandidatesInIndexes() {
    if (auto& analyzed = cursor.script.analyzed_script) {
        // Find candidates in name dictionary of main script
        findCandidatesInIndex(analyzed->GetNameSearchIndex(), false);
        // Find candidates in name dictionary of external script
        cursor.script.catalog.IterateRanked([this, &analyzed](auto entry_id, auto& entry, size_t rank) {
            if (&entry != analyzed.get()) {
                findCandidatesInIndex(entry.GetNameSearchIndex(), true);
            }
        });
    }
}

std::string_view Completion::ReadTargetPrefix() const {
    if (!target_scanner_symbol.has_value()) return {};
    // Scanner symbols can extend beyond a mid-token cursor. Clamp to the symbol and expose only
    // the text already typed, with identifier quotes removed for fuzzy matching.
    auto& target = target_scanner_symbol.value();
    auto symbol_ofs = target.symbol.location.offset();
    auto safe_cursor_offset =
        std::min(std::max<uint32_t>(symbol_ofs, cursor.text_offset), symbol_ofs + target.symbol.location.length());
    auto symbol_text = cursor.script.scanned_script->ReadTextAtTextSpan(
        sx::parser::TextSpan(target.symbol.location.offset(), target.symbol.location.length()));
    auto symbol_prefix =
        std::min<uint32_t>(std::max<uint32_t>(safe_cursor_offset, symbol_ofs) - symbol_ofs, symbol_text.size());
    return trim_view({symbol_text.data(), symbol_prefix}, is_no_double_quote);
}

void Completion::AddLocalCandidate(std::string_view name, NameTags name_tags, CandidateTags candidate_tags,
                                   std::string_view prefix, sx::parser::SymbolSpan target_location,
                                   sx::parser::SymbolSpan target_location_qualified) {
    // Local semantic names do not have catalog IDs, but they must use the same fuzzy-match tags
    // and deduplication map as indexed catalog candidates to participate in normal scoring.
    fuzzy_ci_string_view ci_name{name.data(), name.size()};
    fuzzy_ci_string_view ci_prefix{prefix.data(), prefix.size()};
    if (!ci_prefix.empty()) {
        auto pos = ci_name.find(ci_prefix);
        if (pos == fuzzy_ci_string_view::npos) return;
        candidate_tags |= buffers::completion::CandidateTag::SUBSTRING_MATCH;
        if (pos == 0) {
            candidate_tags |= buffers::completion::CandidateTag::PREFIX_MATCH;
            if (ci_name.size() == ci_prefix.size()) {
                candidate_tags |= buffers::completion::CandidateTag::EXACT_MATCH;
            }
        }
    }

    if (auto candidate_it = candidates_by_name.find(name); candidate_it != candidates_by_name.end()) {
        auto& candidate = candidate_it->second.get();
        candidate.coarse_name_tags |= name_tags;
        candidate.candidate_tags |= candidate_tags;
        // A visible local relation shadows catalog objects with the same spelling. Keeping those
        // objects attached would qualify a CTE column as an unrelated catalog column.
        candidate.catalog_objects.Clear();
        candidate.target_location = target_location;
        candidate.target_location_qualified = target_location_qualified;
    } else {
        auto& candidate = candidates.PushBack(Candidate{
            .completion_text = name,
            .coarse_name_tags = name_tags,
            .candidate_tags = candidate_tags,
            .target_location = target_location,
            .target_location_qualified = target_location_qualified,
            .catalog_objects = {},
        });
        candidates_by_name.insert({name, candidate});
    }
}

void Completion::FindCandidatesInScope() {
    if (!target_scanner_symbol.has_value() || !cursor.script.parsed_script || !cursor.script.analyzed_script) return;

    auto prefix = ReadTargetPrefix();
    auto target_location = target_scanner_symbol->symbol.location;
    CandidateTags tags{buffers::completion::CandidateTag::NAME_INDEX,
                       buffers::completion::CandidateTag::IN_NAME_SCOPE};

    if (strategy == buffers::completion::CompletionStrategy::TABLE_REF) {
        // CTE visibility is positional for non-recursive WITH clauses: earlier siblings are
        // visible, while the current CTE and later siblings are not. Recursive WITH removes
        // both restrictions.
        auto& scanned = *cursor.script.scanned_script;
        for (auto& scope_ref : cursor.name_scopes) {
            auto& scope = scope_ref.get();
            for (auto& [_, cte] : scope.cte_definitions) {
                auto cte_node_it = scope.cte_definition_nodes.find(cte.cte_name.get().text);
                if (cte_node_it == scope.cte_definition_nodes.end()) continue;
                auto cte_text =
                    scanned.ResolveTextSpan(cursor.script.parsed_script->nodes[cte_node_it->second].symbol_span());
                if (!scope.ctes_recursive && cte_text.offset() >= cursor.text_offset) continue;
                if (!scope.ctes_recursive && !cursor.name_scopes.empty() &&
                    isScopeWithin(cursor.name_scopes.front().get(), cte.child_scope)) {
                    continue;
                }
                AddLocalCandidate(cte.cte_name.get().text, NameTags{buffers::analyzer::NameTag::TABLE_NAME}, tags,
                                  prefix, target_location, target_location);
            }
        }

        return;
    }

    if (strategy != buffers::completion::CompletionStrategy::COLUMN_REF) return;
    // Catalog columns already come from the name index. Add only CTE-backed FROM sources here,
    // since their output schema exists solely in the analyzer's semantic scopes.
    for (auto& scope_ref : cursor.name_scopes) {
        for (auto& [_, table] : scope_ref.get().referenced_tables_by_name) {
            if (table.IsUnresolvedRelation()) continue;
            auto* cte = std::get_if<std::reference_wrapper<ResolvedCTE>>(&table.source);
            if (!cte) continue;
            forEachResolvedCTEColumn(cte->get(), [&](const RegisteredName& name) {
                AddLocalCandidate(name.text, NameTags{buffers::analyzer::NameTag::COLUMN_NAME}, tags, prefix,
                                  target_location, target_location);
            });
        }
    }
}

void Completion::FindCandidatesInInlineVisualizeSource() {
    if (!target_scanner_symbol.has_value() || !cursor.script.parsed_script || !cursor.script.analyzed_script) {
        return;
    }

    auto& nodes = cursor.script.parsed_script->nodes;
    bool in_visualize_spec = std::ranges::any_of(cursor.ast_path_to_root, [&](auto node_id) {
        return nodes[node_id].attribute_key() == buffers::parser::AttributeKey::VIS_VISUALISE_SPEC;
    });
    if (!in_visualize_spec) return;
    const AnalyzedScript::NameScope* source_scope = nullptr;
    for (auto node_id : cursor.ast_path_to_root) {
        auto& node = nodes[node_id];
        if (node.node_type() != buffers::parser::NodeType::OBJECT_VIS_VISUALISE) continue;

        for (size_t i = 0; i < node.children_count(); ++i) {
            auto child_id = node.children_begin_or_value() + i;
            auto& child = nodes[child_id];
            if (child.attribute_key() != buffers::parser::AttributeKey::VIS_VISUALISE_SELECT) {
                continue;
            }
            auto scope_it = cursor.script.analyzed_script->name_scopes_by_root_node.find(child_id);
            if (scope_it != cursor.script.analyzed_script->name_scopes_by_root_node.end()) {
                source_scope = &scope_it->second.get();
            }
            break;
        }
        break;
    }
    if (!source_scope) return;

    auto& target = target_scanner_symbol.value();
    auto prefix = ReadTargetPrefix();

    for (auto& output : source_scope->output_columns) {
        auto& name = output.column_name.get();
        CandidateTags tags{buffers::completion::CandidateTag::NAME_INDEX,
                           buffers::completion::CandidateTag::IN_NAME_SCOPE};
        AddLocalCandidate(name.text, NameTags{buffers::analyzer::NameTag::COLUMN_NAME}, tags, prefix,
                          target.symbol.location, target.symbol.location);
    }
}

void Completion::PromoteIdentifiersInScope() {
    // We can be a bit more involved here since the number of entities in a scope should be small(ish)

    bool in_insert_source = std::ranges::any_of(cursor.name_scopes, [](auto scope) {
        return scope.get().column_correlation_barrier;
    });

    // Check all naming scopes for tables that are in scope.
    for (auto& name_scope : cursor.name_scopes) {
        auto& scope = name_scope.get();

        // Iterate over all table references in the scope.
        // A column name belonging to a table ref gets boosted.
        for (auto& table_ref : scope.table_references) {
            if (in_insert_source && table_ref.role == TableReference::Role::Write) continue;
            // Resolved table ref?
            auto* rel_expr = std::get_if<AnalyzedScript::TableReference::RelationExpression>(&table_ref.inner);
            if (!rel_expr || !rel_expr->resolved_table.has_value()) {
                continue;
            }

            // XXX Alternatives

            // Find the table in the catalog
            // Note that this would benefit from storing candidates in a btree::map.
            // Then we could just prefix-search with the table id without ever resolving the table column count.
            auto& resolved_table_entry = rel_expr->resolved_table.value();
            auto resolved_table_id = resolved_table_entry.catalog_table_id.UnpackTableID();
            auto* resolved_table = cursor.script.catalog.ResolveTable(resolved_table_id);
            if (!resolved_table) {
                continue;
            }

            // We can just derive the table column ids based on the column count
            for (uint32_t i = 0; i < resolved_table->table_columns.size(); ++i) {
                auto iter = candidate_objects_by_id.find(QualifiedCatalogObjectID::TableColumn(resolved_table_id, i));
                if (iter == candidate_objects_by_id.end()) {
                    continue;
                }
                // Found column reachable through the scope that is a candidate.
                auto& co = iter->second.get();
                co.candidate_tags |= buffers::completion::CandidateTag::IN_NAME_SCOPE;
                co.candidate.candidate_tags |= buffers::completion::CandidateTag::IN_NAME_SCOPE;
            }
        }

        // Iterate over all existing column references in the scope.
        // A resolved column name that has been used before gets boosted.
        for (auto& expr : scope.expressions) {
            // Resolved column ref?
            auto* colref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
            if (!colref || !colref->IsResolved()) {
                continue;
            }

            // Check directly if the the column is stored as candidate
            // Scope-column chains can be cyclic in incomplete CTEs, and local CTE candidates were
            // already added above. Only direct catalog columns need object-level promotion here.
            auto* direct_column = std::get_if<std::reference_wrapper<const CatalogEntry::TableColumn>>(
                &colref->resolved);
            if (!direct_column) {
                continue;
            }
            auto iter = candidate_objects_by_id.find(direct_column->get().object_id);
            if (iter == candidate_objects_by_id.end()) {
                continue;
            }

            // Found column reachable through the scope that is a candidate.
            auto& co = iter->second.get();
            co.candidate_tags |= buffers::completion::CandidateTag::IN_NAME_SCOPE;
            co.candidate.candidate_tags |= buffers::completion::CandidateTag::IN_NAME_SCOPE;
        }
    }
}

void Completion::PromoteTablesAndPeersForUnresolvedColumns() {
    if (!cursor.statement_id.has_value() || !cursor.script.analyzed_script) {
        return;
    }
    std::vector<CatalogEntry::TableColumn> tmp_columns;
    auto& nodes = cursor.script.parsed_script->nodes;
    bool cursor_in_visualize_source = std::ranges::any_of(cursor.ast_path_to_root, [&](auto node_id) {
        return nodes[node_id].attribute_key() == buffers::parser::AttributeKey::VIS_VISUALISE_SELECT;
    });

    // Iterate all unresolved columns in the current script
    for (auto& name_scope : cursor.name_scopes) {
        auto& scope = name_scope.get();
        if (cursor_in_visualize_source &&
            nodes[scope.ast_node_id].node_type() == buffers::parser::NodeType::OBJECT_VIS_VISUALISE) {
            continue;
        }
        for (auto& expr : scope.expressions) {
            // Is unresolved?
            if (auto* column_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&expr.inner);
                column_ref && !column_ref->IsResolved()) {
                auto& column_name = column_ref->column_name.column_name.get();
                tmp_columns.clear();
                // Resolve all table columns that would match the unresolved name?
                cursor.script.analyzed_script->ResolveTableColumnsWithCatalog(column_name, tmp_columns);
                // Register the table name
                for (auto& table_col : tmp_columns) {
                    auto& table = table_col.table->get();
                    // Boost the table name as candidate (if any)
                    if (auto iter = candidate_objects_by_id.find(table.object_id);
                        iter != candidate_objects_by_id.end()) {
                        auto& co = iter->second.get();
                        co.candidate_tags |= buffers::completion::CandidateTag::RESOLVING_TABLE;
                        co.candidate.candidate_tags |= buffers::completion::CandidateTag::RESOLVING_TABLE;
                    }
                    // Promote column names in these tables
                    for (auto& peer_col : table.table_columns) {
                        // Boost the peer name as candidate (if any)
                        if (auto iter = candidate_objects_by_id.find(peer_col.object_id);
                            iter != candidate_objects_by_id.end()) {
                            auto& co = iter->second.get();
                            co.candidate_tags |= buffers::completion::CandidateTag::UNRESOLVED_PEER;
                            co.candidate.candidate_tags |= buffers::completion::CandidateTag::UNRESOLVED_PEER;
                        }
                    }
                }
            }
        }
    }
}

static const NameScoringTable& selectNameScoringTable(buffers::completion::CompletionStrategy strategy) {
    switch (strategy) {
        case buffers::completion::CompletionStrategy::TABLE_REF_ALIAS:
        case buffers::completion::CompletionStrategy::DEFAULT:
            return NAME_SCORE_DEFAULTS;
        case buffers::completion::CompletionStrategy::TABLE_REF:
            return NAME_SCORE_TABLE_REF;
        case buffers::completion::CompletionStrategy::COLUMN_REF:
            return NAME_SCORE_COLUMN_REF;
    }
    return NAME_SCORE_DEFAULTS;
}

void Completion::SelectTopCandidates() {
    // Resolve the scoring table
    auto& base_scoring_table = selectNameScoringTable(strategy);

    /// Helper to sort catalog objects
    struct CandidateObjectRef {
        std::reference_wrapper<CandidateCatalogObject> candidate_object;
        ScoreValueType score;
        CandidateObjectRef(CandidateCatalogObject& c) : candidate_object(c), score(c.score) {}
        bool operator<(const CandidateObjectRef& other) const { return score < other.score; }
    };
    // Use a heap to collect the top catalog objects for a candidate
    TopKHeap<CandidateObjectRef> catalog_object_heap{24};

    // Insert all pending candidates into the heap
    candidates.ForEach([&](size_t i, Candidate& candidate) {
        // Derive the base score as maximum among the name tags
        Completion::ScoreValueType base_score = 0;
        for (auto [tag, tag_score] : base_scoring_table) {
            base_score = std::max(base_score, candidate.coarse_name_tags.contains(tag) ? tag_score : 0);
        }
        // Then find the top n best candidate objects.
        // Splitting off the base score ensures that we're not depending on resolving catalog objects too much.
        catalog_object_heap.Clear();
        for (auto& o : candidate.catalog_objects) {
            o.score = computeCandidateScore(o.candidate_tags);
            catalog_object_heap.Insert(CandidateObjectRef(o));
        }
        auto& candidate_objects = catalog_object_heap.Finish();

        // Store as new list
        candidate.catalog_objects.Clear();
        for (auto& co : candidate_objects) {
            candidate.catalog_objects.PushBackUnsafe(co.candidate_object.get());
        }

        // Determine overall candidate score
        Completion::ScoreValueType object_score = !candidate_objects.empty()
                                                       ? candidate_objects.back().score
                                                       : computeCandidateScore(candidate.candidate_tags);
        Completion::ScoreValueType candidate_score = base_score + object_score;
        candidate.score = candidate_score;

        // Apply all score modifiers
        // Add the scored candidate
        candidate_heap.Insert(std::move(candidate));
    });

    // Finish the heap
    candidate_heap.Finish();

    // Collect result entries
    auto& entries = candidate_heap.GetEntries();
    top_candidates = std::move(entries);
}

void Completion::DeriveKeywordContinuationsForTopCandidates(const parser::Parser::PrefixSnapshot& prefix) {
    if (!target_scanner_symbol.has_value()) return;
    auto& scanned = *cursor.script.scanned_script;
    auto& symbols = cursor.script.scanned_script->GetSymbols();
    // When between symbols, use the next symbol position so ParseUntilAfter includes the previous token
    auto target_id = (between_symbols && !symbols.IsAtEOF(target_scanner_symbol->symbol_id))
                         ? symbols.GetNext(target_scanner_symbol->symbol_id)
                         : target_scanner_symbol->symbol_id;

    // Feed point + replace/insert decision for the suffix probe. This must match the target used
    // to capture `prefix` in ParseUntilWithSnapshot (the AFTER_SYMBOL→next logic), so the probe's
    // replayed prefix lines up with the feed_id it is given.
    using RelativePos = ScannedScript::LocationInfo::RelativePosition;
    auto feed_id = target_scanner_symbol->symbol_id;
    bool replace_target = target_scanner_symbol->relative_pos == RelativePos::BEGIN_OF_SYMBOL ||
                          target_scanner_symbol->relative_pos == RelativePos::MID_OF_SYMBOL ||
                          target_scanner_symbol->relative_pos == RelativePos::END_OF_SYMBOL;
    if (target_scanner_symbol->relative_pos == RelativePos::AFTER_SYMBOL &&
        !symbols.IsAtEOF(target_scanner_symbol->symbol_id)) {
        feed_id = symbols.GetNext(target_scanner_symbol->symbol_id);  // insert mode
    }

    // Helper: given expected symbols after a feed, find the best continuation.
    // If there's exactly one keyword/operator expected, use it.
    // Otherwise, find the uniquely highest-scored continuation keyword.
    // Returns the continuation's symbol kind (S_YYUNDEF if none) so the caller can both render the
    // text and feed it to the suffix probe.
    auto find_continuation =
        [](std::vector<parser::Parser::ExpectedSymbol>& expected_after) -> parser::Parser::symbol_kind_type {
        parser::Parser::symbol_kind_type best_continuation = parser::Parser::symbol_kind_type::S_YYUNDEF;
        uint8_t best_score = 0;
        size_t best_count = 0;
        size_t keyword_count = 0;
        parser::Parser::symbol_kind_type unique_continuation = parser::Parser::symbol_kind_type::S_YYUNDEF;

        for (auto& sym : expected_after) {
            auto text = parser::Keyword::GetSymbolText(sym);
            if (text.empty()) continue;
            ++keyword_count;
            unique_continuation = sym.symbol;
            auto score = getKeywordContinuationScore(sym);
            if (score > best_score) {
                best_score = score;
                best_continuation = sym.symbol;
                best_count = 1;
            } else if (score == best_score && score > 0) {
                ++best_count;
            }
        }
        if (keyword_count == 1) return unique_continuation;
        if (best_count == 1) return best_continuation;
        return parser::Parser::symbol_kind_type::S_YYUNDEF;
    };

    // Keep a continuation only if feeding [candidate keyword, continuation] leaves the actual
    // post-cursor token stream parseable. At the write front (no post-cursor token) there is
    // nothing to conflict with, so the continuation is always kept.
    auto continuation_fits_suffix = [&](parser::Parser::symbol_kind_type candidate_symbol,
                                        parser::Parser::symbol_kind_type continuation_symbol) -> bool {
        if (!has_post_cursor_token) return true;
        std::array<parser::Parser::symbol_kind_type, 2> feed{candidate_symbol, continuation_symbol};
        auto probe = parser::Parser::ProbeSuffixSequenceFromSnapshot(scanned, feed_id, prefix, feed, replace_target);
        // The next real token must still shift after the fed sequence (or the whole suffix is
        // consumed cleanly); otherwise the continuation would collide with the trailing text.
        return probe.k1_compatible || probe.reached_eof;
    };

    // Compute identifier continuation once (for non-keyword candidates)
    parser::Parser::symbol_kind_type ident_continuation = parser::Parser::symbol_kind_type::S_YYUNDEF;
    std::string_view ident_continuation_text;
    bool ident_continuation_computed = false;

    for (auto& candidate : top_candidates) {
        if (candidate.keyword_symbol.has_value()) {
            // Keyword candidate: feed its specific symbol
            auto expected_after = parser::Parser::ParseUntilAfter(scanned, target_id, candidate.keyword_symbol.value());
            auto continuation = find_continuation(expected_after);
            if (continuation == parser::Parser::symbol_kind_type::S_YYUNDEF) continue;
            if (!continuation_fits_suffix(candidate.keyword_symbol.value(), continuation)) continue;
            auto& stored =
                keyword_continuation_strings.PushBack(std::string{parser::Keyword::GetSymbolText(continuation)});
            candidate.keyword_continuation = stored;
        } else {
            // Identifier candidate: feed IDENT
            if (!ident_continuation_computed) {
                ident_continuation_computed = true;
                auto expected_after =
                    parser::Parser::ParseUntilAfter(scanned, target_id, parser::Parser::symbol_kind_type::S_IDENT);
                ident_continuation = find_continuation(expected_after);
                if (ident_continuation != parser::Parser::symbol_kind_type::S_YYUNDEF &&
                    continuation_fits_suffix(parser::Parser::symbol_kind_type::S_IDENT, ident_continuation)) {
                    auto& stored = keyword_continuation_strings.PushBack(
                        std::string{parser::Keyword::GetSymbolText(ident_continuation)});
                    ident_continuation_text = stored;
                }
            }
            if (!ident_continuation_text.empty()) {
                candidate.keyword_continuation = ident_continuation_text;
            }
        }
    }
}

void Completion::QualifyTopCandidates() {
    // Remember the column candidates by the table that defines them.
    // We later probe this map with all tables in the the current scope to find table refs with aliases.
    std::unordered_multimap<QualifiedCatalogObjectID, std::pair<std::reference_wrapper<Candidate>,
                                                                std::reference_wrapper<CandidateCatalogObject>>>
        column_candidates_by_table_id;

    // Any ambiguities among the candidate objects?
    for (auto& top_candidate : top_candidates) {
        size_t column_count_in_scope = 0;
        size_t table_count = 0;
        for (auto& co : top_candidate.catalog_objects) {
            auto in_scope = (co.candidate_tags & buffers::completion::CandidateTag::IN_NAME_SCOPE) != 0;
            column_count_in_scope +=
                (co.catalog_object_id.GetType() == CatalogObjectType::ColumnDeclaration) && in_scope;
            table_count += co.catalog_object_id.GetType() == CatalogObjectType::TableDeclaration;

            switch (co.catalog_object_id.GetType()) {
                case CatalogObjectType::ColumnDeclaration: {
                    auto& column = co.catalog_object.CastUnsafe<CatalogEntry::TableColumn>();
                    auto table_id = QualifiedCatalogObjectID::Table(co.catalog_object_id.UnpackTableColumnID().first);
                    column_candidates_by_table_id.insert({table_id, {top_candidate, co}});

                    // Derive default column name
                    if (column.table.has_value()) {
                        co.qualified_name =
                            GetQualifiedColumnName(column.table->get().table_name, column.column_name.get());
                        co.qualified_name_target_idx = co.qualified_name.size() - 1;
                    } else {
                        auto& text = column.column_name.get().text;
                        co.qualified_name = std::span<std::string_view>{&text, 1};
                        co.qualified_name_target_idx = 0;
                    }
                    break;
                }
                case CatalogObjectType::TableDeclaration: {
                    auto& table = co.catalog_object.CastUnsafe<CatalogEntry::TableDeclaration>();

                    // Derive qualified table name
                    co.qualified_name = GetQualifiedTableName(table.table_name);
                    co.qualified_name_target_idx = co.qualified_name.size() - 1;
                    break;
                }
                case CatalogObjectType::FunctionDeclaration: {
                    auto& func = co.catalog_object.CastUnsafe<CatalogEntry::FunctionDeclaration>();

                    // Derive qualified function name
                    co.qualified_name = GetQualifiedFunctionName(func.function_name);
                    co.qualified_name_target_idx = co.qualified_name.size() - 1;
                    break;
                }
                default:
                    break;
            }
        }

        // Store preference in all the objects
        bool prefer_qualified_columns = column_count_in_scope > 1;
        bool prefer_qualified_tables = table_count > 1;
        for (auto& co : top_candidate.catalog_objects) {
            switch (co.catalog_object_id.GetType()) {
                case CatalogObjectType::ColumnDeclaration:
                    co.prefer_qualified = prefer_qualified_columns;
                    break;
                case CatalogObjectType::TableDeclaration:
                    co.prefer_qualified = prefer_qualified_tables;
                    break;
                default:
                    break;
            }
        }
    }

    // Iterate over all cursor name scopes
    for (auto& name_scope : cursor.name_scopes) {
        auto& scope = name_scope.get();
        for (auto& table_ref : scope.table_references) {
            // Read the relation expression
            auto* rel_expr = std::get_if<AnalyzedScript::TableReference::RelationExpression>(&table_ref.inner);
            if (!rel_expr || !rel_expr->resolved_table.has_value()) {
                continue;
            }

            // We found a resolved table in the name scope.
            // Check if any of the column candidates is referencing this table.
            // If yes, check if that table ref has an alias.
            // If yes, qualify the column candidate with that alias.
            auto& resolved = rel_expr->resolved_table.value();
            auto [matches_begin, matches_end] = column_candidates_by_table_id.equal_range(resolved.catalog_table_id);
            bool has_match = matches_begin != matches_end;

            for (auto iter = matches_begin; iter != matches_end; ++iter) {
                auto& [candidate, candidate_object] = iter->second;
                auto& co = candidate_object.get();

                // Table ref has an alias?
                // Store the qualified name.
                if (table_ref.alias.has_value()) {
                    auto& alias = table_ref.alias.value().first.get();
                    auto column = co.catalog_object.CastUnsafe<CatalogEntry::TableColumn>();
                    auto& column_name = column.column_name.get();
                    co.qualified_name = GetQualifiedColumnName(alias, column_name);
                    co.qualified_name_target_idx = co.qualified_name.size() - 1;
                    co.prefer_qualified = true;
                } else {
                    auto column = co.catalog_object.CastUnsafe<CatalogEntry::TableColumn>();
                    auto& column_name = column.column_name.get();
                    co.qualified_name = GetQualifiedColumnName(resolved.table_name, column_name);
                    co.qualified_name_target_idx = co.qualified_name.size() - 1;
                }
            }
            if (has_match) {
                column_candidates_by_table_id.erase(resolved.catalog_table_id);
            }
        }
    }
}

static buffers::completion::CompletionStrategy selectStrategy(const ScriptCursor& cursor) {
    return std::visit(
        [](const auto& ctx) -> buffers::completion::CompletionStrategy {
            using T = std::decay_t<decltype(ctx)>;
            if constexpr (std::is_same_v<T, ScriptCursor::TableRefContext>) {
                if (ctx.at_alias) {
                    return buffers::completion::CompletionStrategy::TABLE_REF_ALIAS;
                } else {
                    return buffers::completion::CompletionStrategy::TABLE_REF;
                }
            } else if constexpr (std::is_same_v<T, ScriptCursor::ColumnRefContext>) {
                return buffers::completion::CompletionStrategy::COLUMN_REF;
            } else {
                return buffers::completion::CompletionStrategy::DEFAULT;
            }
        },
        cursor.context);
}

Completion::Completion(const ScriptCursor& cursor, size_t k)
    : cursor(cursor), strategy(selectStrategy(cursor)), target_scanner_symbol(), candidate_heap(k) {}

std::unique_ptr<Completion> Completion::Compute(const ScriptCursor& cursor, size_t k) {
    using RelativePosition = dashql::buffers::cursor::RelativeSymbolPosition;

    auto completion = std::make_unique<Completion>(cursor, k);

    // Cannot complete without scanner location
    if (!cursor.scanner_location.has_value()) {
        return completion;
    }

    // Don't complete inside comments.
    // Comments live outside the symbol stream, so the scanner location snaps to an adjacent token;
    // completing there would suggest code inside a comment and skip the cursor to the token after it.
    if (cursor.script.scanned_script->IsInsideComment(cursor.text_offset)) {
        return completion;
    }

    // Maintain target and previous symbols
    auto& target_symbol = completion->target_scanner_symbol;
    auto& symbols = cursor.script.scanned_script->GetSymbols();
    auto& scanner_location = cursor.scanner_location.value();
    target_symbol.emplace(scanner_location.current);
    std::optional<ScannedScript::SymbolLocationInfo> previous_symbol{scanner_location.previous};

    // Cursor is after a symbol (whitespace after a token)?
    // Produce expected-keyword-only completions for passive inline hints.
    // Also treat BEFORE_SYMBOL as between-symbols when there's no previous symbol (start of statement).
    if (scanner_location.current.relative_pos == buffers::cursor::RelativeSymbolPosition::AFTER_SYMBOL ||
        (scanner_location.current.relative_pos == buffers::cursor::RelativeSymbolPosition::BEFORE_SYMBOL &&
         !previous_symbol.has_value())) {
        completion->between_symbols = true;
    }
    bool between_symbols = completion->between_symbols;

    auto usePreviousSymbolIfAtEnd = [&]() {
        if (previous_symbol.has_value() && previous_symbol.value().relative_pos == RelativePosition::END_OF_SYMBOL) {
            target_symbol.emplace(previous_symbol.value());
            previous_symbol.reset();
            return true;
        } else {
            return false;
        }
    };

    // XXX Always read name path for qualified location?

    // Is the current symbol an inner dot?
    completion->dot_completion = false;
    if (!between_symbols && completion->target_scanner_symbol->symbolIsDot()) {
        using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
        switch (completion->target_scanner_symbol->relative_pos) {
            case RelativePosition::AFTER_SYMBOL:
            case RelativePosition::END_OF_SYMBOL:
                completion->dot_completion = true;
                break;
            case RelativePosition::BEGIN_OF_SYMBOL:
                // Don't complete the dot itself
                if (!usePreviousSymbolIfAtEnd()) {
                    return completion;
                }
            case RelativePosition::MID_OF_SYMBOL:
            case RelativePosition::BEFORE_SYMBOL:
                // Don't complete the dot itself
                return completion;
        }
    }

    // Is the current symbol a trailing dot?
    else if (!between_symbols && completion->target_scanner_symbol->symbolIsTrailingDot()) {
        using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
        switch (completion->target_scanner_symbol->relative_pos) {
            case RelativePosition::AFTER_SYMBOL:
            case RelativePosition::END_OF_SYMBOL:
                completion->dot_completion = true;
                break;
            case RelativePosition::BEGIN_OF_SYMBOL:
                // Don't complete the dot itself
                if (!usePreviousSymbolIfAtEnd()) {
                    return completion;
                }
                break;
            case RelativePosition::MID_OF_SYMBOL:
            case RelativePosition::BEFORE_SYMBOL: {
                // Don't complete the dot itself
                return completion;
            }
        }
    }

    // Skip completion for the current symbol
    if (!between_symbols && doNotCompleteSymbol(target_symbol->symbol)) {
        // Is the cursor at the end of the previous symbol?
        // This happens for commas.
        if (!usePreviousSymbolIfAtEnd()) {
            return completion;
        }
        // Also skip completion of previous symbol?
        if (doNotCompleteSymbol(target_symbol->symbol)) {
            return completion;
        }
    }

    // When not dot-completing, find the expected symbols at this location.
    // We capture a parser-state snapshot here so the suffix probe (run later inside
    // AddExpectedKeywordsAsCandidates) can replay the suffix without re-parsing the prefix.
    bool expects_identifier = false;
    parser::Parser::ExpectedAtCursor expected_at_cursor;
    if (!completion->dot_completion) {
        auto parse_until_target =
            (target_symbol->relative_pos == ScannedScript::LocationInfo::RelativePosition::AFTER_SYMBOL &&
             !symbols.IsAtEOF(target_symbol->symbol_id))
                ? symbols.GetNext(target_symbol->symbol_id)
                : target_symbol->symbol_id;
        expected_at_cursor = parser::Parser::ParseUntilWithSnapshot(*cursor.script.scanned_script, parse_until_target);
        for (auto& expected : expected_at_cursor.expected) {
            if (expected == parser::Parser::symbol_kind_type::S_IDENT) {
                expects_identifier = true;
                break;
            }
        }
    }
    auto expected_symbols = std::span<parser::Parser::ExpectedSymbol>(expected_at_cursor.expected);

    // Check if cursor is at a "definition" position (where a name is being defined, not referenced).
    // We suppress identifier completion at these positions since the user is naming something new.
    if (cursor.script.parsed_script && !cursor.ast_path_to_root.empty()) {
        auto& nodes = cursor.script.parsed_script->nodes;
        for (auto node_id : cursor.ast_path_to_root) {
            switch (nodes[node_id].attribute_key()) {
                case sx::parser::AttributeKey::SQL_CREATE_TABLE_NAME:
                case sx::parser::AttributeKey::SQL_CREATE_AS_NAME:
                case sx::parser::AttributeKey::SQL_VIEW_NAME:
                case sx::parser::AttributeKey::SQL_COLUMN_DEF_NAME:
                case sx::parser::AttributeKey::SQL_RESULT_TARGET_NAME:
                case sx::parser::AttributeKey::SQL_CTE_NAME:
                case sx::parser::AttributeKey::SQL_WINDOW_DEF_NAME:
                case sx::parser::AttributeKey::SQL_CREATE_FUNCTION_NAME:
                case sx::parser::AttributeKey::SQL_FUNCTION_PARAM_NAME:
                    completion->at_definition = true;
                    break;
                default:
                    break;
            }
            if (completion->at_definition) break;
        }
    }

    // Is the previous symbol an inner dot?
    // Then we check if we're currently pointing at the successor symbol.
    // If we do, we do a normal dot completion.
    //
    // Note that this is building around the existence of the trailing dot.
    // We're checking here if the previous symbol is an inner dot.
    // If there was a whitespace after the previous dot, we'd mark as at trailing.
    // Since the previous symbol is a normal dot, it must be an inner.
    if (previous_symbol.has_value() && previous_symbol->symbolIsDot() && expects_identifier) {
        using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
        switch (target_symbol->relative_pos) {
            case RelativePosition::END_OF_SYMBOL:
            case RelativePosition::BEGIN_OF_SYMBOL:
            case RelativePosition::MID_OF_SYMBOL:
                completion->dot_completion = true;
                break;
            case RelativePosition::AFTER_SYMBOL:
            case RelativePosition::BEFORE_SYMBOL:
                /// NEW_SYMBOL_BEFORE should be unreachable, the previous symbol would have been a trailing dot...
                /// NEW_SYMBOL_AFTER is not qualifying for dot completion

                // Proceed with normal completion...
                break;
        }
    }

    // Is the cursor at the write front (nothing but EOF follows)?
    // Multi-step suggestions are only offered there, and the keyword suffix probe reuses this.
    completion->has_post_cursor_token = completion->computeHasPostCursorToken();

    // Dot completion?
    if (completion->dot_completion) {
        // Restricting candidates to the dot context
        completion->FindCandidatesForNamePath();
    } else if (between_symbols) {
        // Between symbols: only add expected keywords with zero-length target location.
        // This produces candidates for passive inline hints (e.g. "BY" after "GROUP ").
        // Suppress hints entirely after tokens where the user will type an identifier/expression.
        if (suppressPassiveHint(target_symbol->symbol.kind_)) {
            // No candidates, no passive hint
        } else {
            completion->AddExpectedKeywordsAsCandidates(expected_symbols, expected_at_cursor.prefix);
        }
    } else {
        // Add expected grammar symbols to the heap and score them
        completion->AddExpectedKeywordsAsCandidates(expected_symbols, expected_at_cursor.prefix);
        // Insert an identity candidate matching the user's text when on an identifier.
        // Score depends on context: at definitions it dominates, at references it yields to strong matches.
        if (expects_identifier && completion->target_scanner_symbol.has_value()) {
            auto& sym = completion->target_scanner_symbol->symbol;
            auto symbol_text = cursor.script.scanned_script->ReadTextAtTextSpan(
                sx::parser::TextSpan(sym.location.offset(), sym.location.length()));
            // A delimited identifier with a missing closing quote runs to the next quote
            // anywhere downstream, producing a giant token. Cap the identity candidate length
            // to avoid surfacing the entire script suffix as a candidate.
            if (symbol_text.size() > MAX_IDENTITY_LENGTH) {
                symbol_text = {};
            }
            if (!symbol_text.empty()) {
                ScoreValueType identity_score;
                if (completion->at_definition) {
                    identity_score = std::numeric_limits<ScoreValueType>::max();
                } else if (completion->strategy == sx::completion::CompletionStrategy::TABLE_REF) {
                    identity_score = IDENTITY_SCORE_TABLE_REF;
                } else if (completion->strategy == sx::completion::CompletionStrategy::COLUMN_REF) {
                    identity_score = IDENTITY_SCORE_COLUMN_REF;
                } else if (completion->strategy == sx::completion::CompletionStrategy::TABLE_REF_ALIAS) {
                    identity_score = IDENTITY_SCORE_TABLE_REF_ALIAS;
                } else {
                    identity_score = std::numeric_limits<ScoreValueType>::max();
                }
                Candidate identity{
                    .completion_text = symbol_text,
                    .completion_text_is_verbatim = true,
                    .coarse_name_tags = {},
                    .candidate_tags = buffers::completion::CandidateTag::IDENTITY,
                    .target_location = sym.location,
                    .target_location_qualified = sym.location,
                    .score = identity_score,
                };
                completion->candidate_heap.Insert(std::move(identity));
            }
        }
        // Also check the name indexes when expecting an identifier.
        // For definitions and aliases, we stop searching for candidates since these are user-provided names.
        if (expects_identifier && !completion->at_definition &&
            completion->strategy != sx::completion::CompletionStrategy::TABLE_REF_ALIAS) {
            // Just find all candidates in the name index
            completion->FindCandidatesInIndexes();
            completion->FindCandidatesInScope();
            completion->FindCandidatesInInlineVisualizeSource();
            // Promote names of all tables that could resolve an unresolved column
            completion->PromoteTablesAndPeersForUnresolvedColumns();
        }
    }
    // Promote names that are in scope
    if (!between_symbols) {
        completion->PromoteIdentifiersInScope();
    }
    // Add all candidates to the result heap
    completion->SelectTopCandidates();
    // Get qualified names for the top candidate objects
    if (!between_symbols) {
        completion->QualifyTopCandidates();
    }

    // Derive keyword continuations for all keyword candidates. Suffix-aware: at the write
    // front every continuation is kept, but mid-statement each is probed against the actual
    // post-cursor tokens and dropped only if it would conflict (e.g. completing at `... group| by x`
    // must not offer a `group by` continuation, but `select a from tbl gro|up a` keeps `by`).
    completion->DeriveKeywordContinuationsForTopCandidates(expected_at_cursor.prefix);

    // Register as normal completion
    return completion;
}

flatbuffers::Offset<buffers::completion::Completion> Completion::Pack(
    flatbuffers::FlatBufferBuilder& builder, buffers::formatting::KeywordCase keyword_case) {
    auto& entries = top_candidates;

    // Reservie for packed candidates
    std::vector<flatbuffers::Offset<buffers::completion::CompletionCandidate>> candidates;
    candidates.reserve(entries.size());

    // Pack candidates
    for (auto iter_entry = entries.begin(); iter_entry != entries.end(); ++iter_entry) {
        // Do we have to quote the completion text?
        // Verbatim candidates (identity) reproduce exactly what the user typed, so we never
        // re-quote them. Otherwise a quoted lower-case identifier `"year"` would be re-emitted
        // unquoted, and a quoted upper-case one `"Year"` would be quoted twice (`"""Year"""`).
        std::string keyword_text;
        const bool upper_keyword = keyword_case == buffers::formatting::KeywordCase::UPPER &&
                                   iter_entry->keyword_symbol.has_value();
        if (upper_keyword) {
            keyword_text = std::string{iter_entry->completion_text};
            for (char& ch : keyword_text) {
                if (ch >= 'a' && ch <= 'z') ch += 'A' - 'a';
            }
        }
        auto display_text_offset = builder.CreateString(upper_keyword ? std::string_view{keyword_text}
                                                                      : iter_entry->completion_text);
        std::string quoted;
        std::string_view completion_text = upper_keyword ? std::string_view{keyword_text} : iter_entry->completion_text;
        if (!upper_keyword && !iter_entry->completion_text_is_verbatim) {
            completion_text = quote_anyupper_fuzzy(completion_text, quoted);
        }

        // Resolve the catalog objects
        size_t catalog_object_count = iter_entry->catalog_objects.GetSize();
        std::vector<flatbuffers::Offset<buffers::completion::CompletionCandidateObject>> catalog_objects;
        catalog_objects.reserve(catalog_object_count);

        // Pack the catalog objects
        std::vector<flatbuffers::Offset<flatbuffers::String>> qualified_name_offsets;
        std::string qualified_name_buffer;
        for (auto& co : iter_entry->catalog_objects) {
            auto& o = co.catalog_object;

            // Pack qualified name
            qualified_name_offsets.clear();
            for (auto& n : co.qualified_name) {
                auto ofs = builder.CreateString(quote_anyupper_fuzzy(n, qualified_name_buffer));
                qualified_name_offsets.push_back(ofs);
            }
            auto qualified_names_ofs = builder.CreateVector(qualified_name_offsets);

            // Pack candidate object
            buffers::completion::CompletionCandidateObjectBuilder obj{builder};
            obj.add_object_type(static_cast<buffers::completion::CompletionCandidateObjectType>(o.GetObjectType()));
            obj.add_candidate_tags(co.candidate_tags);
            obj.add_score(co.score);
            obj.add_qualified_name(qualified_names_ofs);
            obj.add_qualified_name_target_idx(co.qualified_name_target_idx);
            obj.add_prefer_qualified(co.prefer_qualified);
            switch (o.GetObjectType()) {
                case CatalogObjectType::DatabaseReference: {
                    auto& db = o.CastUnsafe<CatalogEntry::DatabaseReference>();
                    obj.add_catalog_database_id(db.GetDatabaseID());
                    break;
                }
                case CatalogObjectType::SchemaReference: {
                    auto& schema = o.CastUnsafe<CatalogEntry::SchemaReference>();
                    obj.add_catalog_database_id(schema.GetDatabaseID());
                    obj.add_catalog_schema_id(schema.GetSchemaID());
                    break;
                }
                case CatalogObjectType::TableDeclaration: {
                    auto& table = o.CastUnsafe<CatalogEntry::TableDeclaration>();
                    auto [db_id, schema_id] = table.catalog_schema_id.UnpackSchemaID();
                    obj.add_catalog_database_id(db_id);
                    obj.add_catalog_schema_id(schema_id);
                    obj.add_catalog_table_id(table.object_id.UnpackTableID().Pack());
                    obj.add_referenced_catalog_version(table.catalog_version);
                    break;
                }
                case CatalogObjectType::ColumnDeclaration: {
                    auto& column = o.CastUnsafe<CatalogEntry::TableColumn>();
                    auto& table = column.table->get();
                    auto [db_id, schema_id] = table.catalog_schema_id.UnpackSchemaID();
                    auto [table_id, column_idx] = column.object_id.UnpackTableColumnID();
                    obj.add_catalog_database_id(db_id);
                    obj.add_catalog_schema_id(schema_id);
                    obj.add_catalog_table_id(table_id.Pack());
                    obj.add_table_column_id(column_idx);
                    obj.add_referenced_catalog_version(table.catalog_version);
                    break;
                }
                case CatalogObjectType::FunctionDeclaration: {
                    auto& func = o.CastUnsafe<CatalogEntry::FunctionDeclaration>();
                    auto [db_id, schema_id] = func.catalog_schema_id.UnpackSchemaID();
                    obj.add_catalog_database_id(db_id);
                    obj.add_catalog_schema_id(schema_id);
                    break;
                }
                case CatalogObjectType::Deferred: {
                    assert(false);
                    break;
                }
            }
            catalog_objects.push_back(obj.Finish());
        }

        auto catalog_objects_ofs = builder.CreateVector(catalog_objects);
        bool is_function = false;
        for (auto& co : iter_entry->catalog_objects) {
            is_function |= co.catalog_object.GetObjectType() == CatalogObjectType::FunctionDeclaration;
        }
        std::string function_completion;
        if (is_function) {
            function_completion = completion_text;
            function_completion.append("()");
            completion_text = function_completion;
        }
        auto completion_text_ofs = builder.CreateString(completion_text);
        flatbuffers::Offset<flatbuffers::String> keyword_continuation_ofs;
        if (!iter_entry->keyword_continuation.empty()) {
            std::string continuation{iter_entry->keyword_continuation};
            if (keyword_case == buffers::formatting::KeywordCase::UPPER) {
                for (char& ch : continuation) {
                    if (ch >= 'a' && ch <= 'z') ch += 'A' - 'a';
                }
            }
            keyword_continuation_ofs = builder.CreateString(continuation);
        }
        buffers::completion::CompletionCandidateBuilder candidate_builder{builder};
        candidate_builder.add_display_text(display_text_offset);
        candidate_builder.add_completion_text(completion_text_ofs);
        candidate_builder.add_candidate_tags(iter_entry->candidate_tags);
        candidate_builder.add_name_tags(iter_entry->coarse_name_tags);
        candidate_builder.add_catalog_objects(catalog_objects_ofs);
        candidate_builder.add_score(iter_entry->score);
        candidate_builder.add_target_location(&iter_entry->target_location);
        candidate_builder.add_target_location_qualified(&iter_entry->target_location_qualified);
        candidate_builder.add_completion_cursor_offset(
            static_cast<uint32_t>(completion_text.size() - (is_function ? 1 : 0)));
        if (!iter_entry->keyword_continuation.empty()) {
            candidate_builder.add_keyword_continuation(keyword_continuation_ofs);
        }
        candidates.push_back(candidate_builder.Finish());
    }
    auto candidatesOfs = builder.CreateVector(candidates);

    // Pack completion table
    buffers::completion::CompletionBuilder completion_builder{builder};
    completion_builder.add_cursor_offset(cursor.text_offset);
    completion_builder.add_dot_completion(dot_completion);
    completion_builder.add_strategy(strategy);
    completion_builder.add_candidates(candidatesOfs);
    return completion_builder.Finish();
}

}  // namespace dashql
