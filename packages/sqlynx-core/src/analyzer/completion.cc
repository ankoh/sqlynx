#include "sqlynx/analyzer/completion.h"

#include <flatbuffers/buffer.h>

#include <variant>

#include "sqlynx/external.h"
#include "sqlynx/parser/grammar/keywords.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/text/names.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/string_trimming.h"

namespace sqlynx {

namespace {

using NameScoringTable = std::array<std::pair<proto::NameTag, Completion::ScoreValueType>, 8>;

static constexpr NameScoringTable NAME_SCORE_DEFAULTS{{
    {proto::NameTag::NONE, Completion::NAME_TAG_IGNORE},
    {proto::NameTag::SCHEMA_NAME, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::DATABASE_NAME, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::TABLE_NAME, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::TABLE_ALIAS, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::COLUMN_NAME, Completion::NAME_TAG_LIKELY},
}};

static constexpr NameScoringTable NAME_SCORE_TABLE_REF{{
    {proto::NameTag::NONE, Completion::NAME_TAG_IGNORE},
    {proto::NameTag::SCHEMA_NAME, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::DATABASE_NAME, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::TABLE_NAME, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::TABLE_ALIAS, Completion::NAME_TAG_UNLIKELY},
    {proto::NameTag::COLUMN_NAME, Completion::NAME_TAG_UNLIKELY},
}};

static constexpr NameScoringTable NAME_SCORE_COLUMN_REF{{
    {proto::NameTag::NONE, Completion::NAME_TAG_IGNORE},
    {proto::NameTag::SCHEMA_NAME, Completion::NAME_TAG_UNLIKELY},
    {proto::NameTag::DATABASE_NAME, Completion::NAME_TAG_UNLIKELY},
    {proto::NameTag::TABLE_NAME, Completion::NAME_TAG_UNLIKELY},
    {proto::NameTag::TABLE_ALIAS, Completion::NAME_TAG_LIKELY},
    {proto::NameTag::COLUMN_NAME, Completion::NAME_TAG_LIKELY},
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

bool doNotCompleteSymbol(parser::Parser::symbol_type& sym) {
    switch (sym.kind_) {
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

std::vector<Completion::NameComponent> Completion::ReadCursorNamePath(sx::Location& name_path_loc) const {
    auto& nodes = cursor.script.parsed_script->nodes;

    std::optional<uint32_t> name_ast_node_id;
    switch (cursor.context.index()) {
        case 1: {
            assert(std::holds_alternative<ScriptCursor::TableRefContext>(cursor.context));
            auto& ctx = std::get<ScriptCursor::TableRefContext>(cursor.context);
            auto& tableref = cursor.script.analyzed_script->table_references[ctx.table_reference_id];
            switch (tableref.inner.index()) {
                case 1: {
                    assert(std::holds_alternative<AnalyzedScript::TableReference::UnresolvedRelationExpression>(
                        tableref.inner));
                    auto& unresolved =
                        std::get<AnalyzedScript::TableReference::UnresolvedRelationExpression>(tableref.inner);
                    name_ast_node_id = unresolved.table_name_ast_node_id;
                    break;
                }
                case 2: {
                    assert(std::holds_alternative<AnalyzedScript::TableReference::ResolvedRelationExpression>(
                        tableref.inner));
                    auto& resolved =
                        std::get<AnalyzedScript::TableReference::ResolvedRelationExpression>(tableref.inner);
                    name_ast_node_id = resolved.table_name_ast_node_id;
                    break;
                }
            }
            break;
        }
        case 2: {
            assert(std::holds_alternative<ScriptCursor::ColumnRefContext>(cursor.context));
            auto& ctx = std::get<ScriptCursor::ColumnRefContext>(cursor.context);
            auto& expr = cursor.script.analyzed_script->expressions[ctx.expression_id];
            switch (expr.inner.index()) {
                case 1: {
                    assert(std::holds_alternative<AnalyzedScript::Expression::UnresolvedColumnRef>(expr.inner));
                    auto& unresolved = std::get<AnalyzedScript::Expression::UnresolvedColumnRef>(expr.inner);
                    name_ast_node_id = unresolved.column_name_ast_node_id;
                    break;
                }
                case 2: {
                    assert(std::holds_alternative<AnalyzedScript::Expression::ResolvedColumnRef>(expr.inner));
                    auto& resolved = std::get<AnalyzedScript::Expression::ResolvedColumnRef>(expr.inner);
                    name_ast_node_id = resolved.column_name_ast_node_id;
                    break;
                }
            }
            break;
        }
    }

    // Couldn't find an ast name path?
    if (!name_ast_node_id.has_value()) {
        return {};
    }
    // Is not an array?
    auto& node = nodes[*name_ast_node_id];
    if (node.node_type() != proto::NodeType::ARRAY) {
        return {};
    }
    name_path_loc = node.location();

    // Get the child nodes
    auto children = std::span<proto::Node>{nodes}.subspan(node.children_begin_or_value(), node.children_count());

    // Collect the name path
    std::vector<NameComponent> components;
    for (size_t i = 0; i != children.size(); ++i) {
        // A child is either a name, an index or a *.
        auto& child = children[i];
        switch (child.node_type()) {
            case proto::NodeType::NAME: {
                auto& name = cursor.script.scanned_script->GetNames().At(child.children_begin_or_value());
                components.push_back(NameComponent{
                    .loc = child.location(),
                    .type = NameComponentType::Name,
                    .name = name,
                });
                break;
            }
            case proto::NodeType::OBJECT_SQL_INDIRECTION_STAR:
                components.push_back(NameComponent{
                    .loc = child.location(),
                    .type = NameComponentType::Star,
                    .name = std::nullopt,
                });
                break;
            case proto::NodeType::OBJECT_SQL_INDIRECTION_INDEX:
                components.push_back(NameComponent{
                    .loc = child.location(),
                    .type = NameComponentType::Index,
                    .name = std::nullopt,
                });
                break;
            case proto::NodeType::OBJECT_EXT_TRAILING_DOT:
                components.push_back(NameComponent{
                    .loc = child.location(),
                    .type = NameComponentType::TrailingDot,
                    .name = std::nullopt,
                });
                return components;
            default:
                // XXX Bail out
                return {};
        }
    }
    return components;
}

void Completion::FindCandidatesForNamePath() {
    // The cursor location
    auto cursor_location = cursor.scanner_location->text_offset;
    // Read the name path
    sx::Location name_path_loc;
    auto name_path_buffer = ReadCursorNamePath(name_path_loc);
    std::span<Completion::NameComponent> name_path = name_path_buffer;

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
    uint32_t truncate_at = name_path_loc.offset() + name_path_loc.length();
    for (; name_count < name_path.size(); ++name_count) {
        if (name_path[name_count].type == NameComponentType::TrailingDot) {
            truncate_at = name_path[name_count].loc.offset() + 1;
            break;
        }
        if (name_path[name_count].type != NameComponentType::Name) {
            truncate_at = name_path[name_count].loc.offset();
            break;
        }
        if ((name_path[name_count].loc.offset() + name_path[name_count].loc.length()) < cursor_location) {
            ++sealed;
        } else {
            // The cursor points into a name?

            // Determine the substring left of the cursor.
            // The user may write:
            //  foo.bar.something
            //              ^ if the cursor points to t, we'll complete "some"
            //
            auto last_loc = name_path[name_count].loc;
            auto last_text = cursor.script.scanned_script->ReadTextAtLocation(last_loc);
            auto last_content =
                std::find_if(last_text.begin(), last_text.end(), is_no_double_quote) - last_text.begin();
            auto last_content_ofs = last_loc.offset() + last_content;
            auto last_prefix_length = std::max<size_t>(cursor_location, last_content_ofs) - last_content_ofs;
            last_text_prefix = last_text.substr(last_content, last_prefix_length);

            // Truncate whn replacing
            truncate_at = last_loc.offset();
            break;
        }
    }
    name_path = name_path.subspan(0, name_count);

    // Determine text to replace
    sx::Location replace_text_at{
        truncate_at, std::max<uint32_t>(name_path_loc.offset() + name_path_loc.length(), truncate_at) - truncate_at};

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
        const CatalogObject& object;
        sx::Location replace_text_at;
    };
    // Collect all candidate strings
    std::vector<DotCandidate> candidates;

    // Are we completing a table ref?
    if (auto* ctx = std::get_if<ScriptCursor::TableRefContext>(&cursor.context)) {
        auto& script = cursor.script;
        auto& catalog = cursor.script.catalog;

        switch (sealed) {
            case 0:
                break;
            case 1: {
                // User gave us a._
                // "a" might be a database name or a schema name

                // Is referring to a schema in the default database?
                auto& a_text = name_path[0].name.value().get().text;
                std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>> tables;
                script.analyzed_script->ResolveSchemaTablesWithCatalog(catalog.GetDefaultDatabaseName(), a_text,
                                                                       tables);
                if (!tables.empty()) {
                    // Add the tables as candidates
                    for (auto& [table, through_catalog] : tables) {
                        // Store the candidate
                        auto& name = table.get().table_name.table_name.get();
                        DotCandidate candidate{.name = name.text,
                                               .candidate_tags = {proto::CandidateTag::DOT_RESOLUTION_TABLE},
                                               .name_tags = {proto::NameTag::TABLE_NAME},
                                               .object = table.get().CastToBase(),
                                               .replace_text_at = replace_text_at};
                        candidate.candidate_tags.AddIf(proto::CandidateTag::THROUGH_CATALOG, through_catalog);
                        candidates.push_back(std::move(candidate));
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
                        DotCandidate candidate{.name = name,
                                               .candidate_tags = {proto::CandidateTag::DOT_RESOLUTION_SCHEMA},
                                               .name_tags = NameTags{proto::NameTag::SCHEMA_NAME},
                                               .object = schema.get().CastToBase(),
                                               .replace_text_at = replace_text_at};
                        candidate.candidate_tags.AddIf(proto::CandidateTag::THROUGH_CATALOG, through_catalog);
                        candidates.push_back(std::move(candidate));
                    }
                }
                break;
            }
            case 2: {
                // User gave us a.b._
                // "a" must be a database name, "b" must be a schema name.
                auto& a_text = name_path[0].name.value().get().text;
                auto& b_text = name_path[1].name.value().get().text;

                // Is a known?
                std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>> tables;
                script.analyzed_script->ResolveSchemaTablesWithCatalog(a_text, b_text, tables);
                if (!tables.empty()) {
                    // Add the tables as candidates
                    for (auto& [table, through_catalog] : tables) {
                        auto& name = table.get().table_name.table_name.get();
                        DotCandidate candidate{.name = name,
                                               .candidate_tags = {proto::CandidateTag::DOT_RESOLUTION_TABLE},
                                               .name_tags = NameTags{proto::NameTag::TABLE_NAME},
                                               .object = {table.get().CastToBase()},
                                               .replace_text_at = replace_text_at};
                        candidate.candidate_tags.AddIf(proto::CandidateTag::THROUGH_CATALOG, through_catalog);
                        candidates.push_back(std::move(candidate));
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
        auto& script = cursor.script;
        switch (sealed) {
            case 0:
                break;
            case 1: {
                // User gave us a._
                // "a" might be a table alias
                auto& a_text = name_path[0].name.value().get().text;

                // Check all naming scopes for tables that are in scope.
                for (auto& name_scope : cursor.name_scopes) {
                    // Does the name refer to a resolved named table in the scope?
                    // This means we're dot-completing a known table alias from here on.
                    auto table_iter = name_scope.get().referenced_tables_by_name.find(a_text);
                    if (table_iter != name_scope.get().referenced_tables_by_name.end()) {
                        // Found a table declaration with that alias
                        auto& table_decl = table_iter->second.get();
                        // Register all column names as alias
                        for (auto& column : table_decl.table_columns) {
                            auto& name = column.column_name.get();
                            DotCandidate candidate{.name = name,
                                                   .candidate_tags = {proto::CandidateTag::DOT_RESOLUTION_COLUMN},
                                                   .name_tags = NameTags{proto::NameTag::COLUMN_NAME},
                                                   .object = {column.CastToBase()},
                                                   .replace_text_at = replace_text_at};
                            candidate.candidate_tags.AddIf(
                                proto::CandidateTag::THROUGH_CATALOG,
                                table_decl.catalog_table_id.GetExternalId() != script.GetCatalogEntryId());
                            candidates.push_back(std::move(candidate));
                        }
                        break;
                    }
                }
                break;
            }
        }
    }

    // Now we need to score the candidates based on the cursor prefix (if there is any)
    if (!last_text_prefix.empty()) {
        for (auto& candidate : candidates) {
            auto iter = pending_candidates.find(candidate.name);
            if (iter != pending_candidates.end()) {
                auto& existing = iter->second;
                existing.replace_text_at = replace_text_at;
                existing.catalog_objects.push_back(candidate.object);
            } else {
                fuzzy_ci_string_view ci_name{candidate.name.data(), candidate.name.size()};
                if (ci_name.starts_with(fuzzy_ci_string_view{last_text_prefix.data(), last_text_prefix.size()})) {
                    candidate.candidate_tags |= proto::CandidateTag::PREFIX_MATCH;
                } else if (ci_name.find(fuzzy_ci_string_view{last_text_prefix.data(), last_text_prefix.size()}) !=
                           fuzzy_ci_string_view::npos) {
                    candidate.candidate_tags |= proto::CandidateTag::SUBSTRING_MATCH;
                }
                Candidate c{
                    .name = candidate.name,
                    .coarse_name_tags = candidate.name_tags,
                    .candidate_tags = candidate.candidate_tags,
                    .catalog_objects = {candidate.object},
                    .replace_text_at = replace_text_at,
                };
                pending_candidates.insert({candidate.name, std::move(c)});
            }
        }
    } else {
        for (auto& candidate : candidates) {
            auto iter = pending_candidates.find(candidate.name);
            if (iter != pending_candidates.end()) {
                auto& existing = iter->second;
                existing.replace_text_at = replace_text_at;
                existing.catalog_objects.push_back(candidate.object);
            } else {
                Candidate c{
                    .name = candidate.name,
                    .coarse_name_tags = candidate.name_tags,
                    .candidate_tags = candidate.candidate_tags,
                    .catalog_objects = {candidate.object},
                    .replace_text_at = replace_text_at,
                };
                pending_candidates.insert({candidate.name, std::move(c)});
            }
        }
    }
}

void Completion::AddExpectedKeywordsAsCandidates(std::span<parser::Parser::ExpectedSymbol> symbols) {
    auto& location = cursor.scanner_location;

    // Helper to determine the score of a cursor symbol
    auto get_score = [&](const ScannedScript::LocationInfo& loc, parser::Parser::ExpectedSymbol expected,
                         std::string_view keyword_text) -> std::pair<CandidateTags, uint32_t> {
        fuzzy_ci_string_view ci_keyword_text{keyword_text.data(), keyword_text.size()};
        using Relative = ScannedScript::LocationInfo::RelativePosition;
        CandidateTags tags = proto::CandidateTag::EXPECTED_PARSER_SYMBOL;

        auto score = GetKeywordPrevalenceScore(expected);

        switch (location->relative_pos) {
            case Relative::NEW_SYMBOL_AFTER:
            case Relative::NEW_SYMBOL_BEFORE:
                return {tags, score};
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL: {
                auto symbol_ofs = location->symbol.location.offset();
                auto symbol_prefix = std::max<uint32_t>(location->text_offset, symbol_ofs) - symbol_ofs;
                fuzzy_ci_string_view ci_symbol_text{cursor.text.data(), symbol_prefix};
                // Is substring?
                if (auto pos = ci_keyword_text.find(ci_symbol_text, 0); pos != fuzzy_ci_string_view::npos) {
                    if (pos == 0) {
                        tags |= proto::CandidateTag::PREFIX_MATCH;
                        score += PREFIX_SCORE_MODIFIER;
                    } else {
                        tags |= proto::CandidateTag::SUBSTRING_MATCH;
                        score += SUBSTRING_SCORE_MODIFIER;
                    }
                }
                return {tags, score};
            }
        }
    };

    // Add all expected symbols to the result heap
    for (auto& expected : symbols) {
        auto name = parser::Keyword::GetKeywordName(expected);
        if (!name.empty()) {
            auto [tags, score] = get_score(*location, expected, name);
            CandidateWithScore scored_candidate{
                Candidate{
                    .name = name,
                    .coarse_name_tags = {},
                    .candidate_tags = tags,
                    .replace_text_at = location->symbol.location,
                },
                score,
            };
            result_heap.Insert(scored_candidate);
        }
    }
}

void findCandidatesInIndex(Completion& completion, const CatalogEntry::NameSearchIndex& index, bool through_catalog) {
    using Relative = ScannedScript::LocationInfo::RelativePosition;
    auto& cursor = completion.GetCursor();
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
        // Check if it's the cursor symbol
        if (!through_catalog && name_info.occurrences == 1 && location->text_offset >= name_info.location.offset() &&
            location->text_offset <= (name_info.location.offset() + name_info.location.length())) {
            continue;
        }
        // Determine the candidate tags
        Completion::CandidateTags candidate_tags{proto::CandidateTag::NAME_INDEX};
        // Added through catalog?
        candidate_tags.AddIf(proto::CandidateTag::THROUGH_CATALOG, through_catalog);

        // Is a prefix?
        switch (location->relative_pos) {
            case Relative::BEGIN_OF_SYMBOL:
            case Relative::MID_OF_SYMBOL:
            case Relative::END_OF_SYMBOL:
                if (fuzzy_ci_string_view{name_info.text.data(), name_info.text.size()}.starts_with(ci_prefix_text)) {
                    candidate_tags |= proto::CandidateTag::PREFIX_MATCH;
                } else {
                    candidate_tags |= proto::CandidateTag::SUBSTRING_MATCH;
                }
                break;
            default:
                break;
        }
        // Do we know the candidate already?
        if (auto iter = pending_candidates.find(name_info.text); iter != pending_candidates.end()) {
            // Update the score if it is higher
            iter->second.candidate_tags |= candidate_tags;
            iter->second.coarse_name_tags |= name_info.coarse_analyzer_tags;
            iter->second.catalog_objects.reserve(iter->second.catalog_objects.size() +
                                                 name_info.resolved_objects.GetSize());
            for (auto& o : name_info.resolved_objects) {
                iter->second.catalog_objects.push_back(o);
            }
        } else {
            // Otherwise store as new candidate
            Completion::Candidate candidate{.name = name_info.text,
                                            .coarse_name_tags = name_info.coarse_analyzer_tags,
                                            .candidate_tags = candidate_tags,
                                            .catalog_objects = {},
                                            .replace_text_at = location->symbol.location};
            candidate.catalog_objects.reserve(name_info.resolved_objects.GetSize());
            for (auto& o : name_info.resolved_objects) {
                candidate.catalog_objects.push_back(o);
            }
            pending_candidates.insert({name_info.text, candidate});
        }
    }
}

void Completion::FindCandidatesInIndexes() {
    if (auto& analyzed = cursor.script.analyzed_script) {
        // Find candidates in name dictionary of main script
        findCandidatesInIndex(*this, analyzed->GetNameSearchIndex(), false);
        // Find candidates in name dictionary of external script
        cursor.script.catalog.IterateRanked([this, &analyzed](auto entry_id, auto& entry, size_t rank) {
            if (&entry != analyzed.get()) {
                findCandidatesInIndex(*this, entry.GetNameSearchIndex(), true);
            }
        });
    }
}

void Completion::PromoteTablesAndPeersForUnresolvedColumns() {
    if (!cursor.statement_id.has_value() || !cursor.script.analyzed_script) {
        return;
    }
    auto& analyzed_script = *cursor.script.analyzed_script;
    auto& catalog = cursor.script.catalog;
    std::vector<CatalogEntry::TableColumn> tmp_columns;

    // Iterate all unresolved columns in the current script
    // XXX Don't search all unresolved expressions but only the unresolved ones in the current statement
    analyzed_script.expressions.ForEach([&](size_t i, AnalyzedScript::Expression& expr) {
        // Is unresolved?
        if (auto* unresolved = std::get_if<AnalyzedScript::Expression::UnresolvedColumnRef>(&expr.inner)) {
            auto& column_name = unresolved->column_name.column_name.get();
            tmp_columns.clear();
            // Resolve all table columns that would match the unresolved name?
            cursor.script.analyzed_script->ResolveTableColumnsWithCatalog(column_name, tmp_columns);
            // Register the table name
            for (auto& table_col : tmp_columns) {
                auto& table = table_col.table->get();
                auto& table_name = table.table_name.table_name.get();
                // Boost the table name as candidate (if any)
                if (auto pending_iter = pending_candidates.find(table_name.text);
                    pending_iter != pending_candidates.end() &&
                    !pending_iter->second.candidate_tags.contains(proto::CandidateTag::RESOLVING_TABLE)) {
                    pending_iter->second.candidate_tags |= proto::CandidateTag::RESOLVING_TABLE;
                }
                // Promote column names in these tables
                for (auto& peer_col : table.table_columns) {
                    // Boost the peer name as candidate (if any)
                    if (auto pending_iter = pending_candidates.find(peer_col.column_name.get().text);
                        pending_iter != pending_candidates.end() &&
                        !pending_iter->second.candidate_tags.contains(proto::CandidateTag::UNRESOLVED_PEER)) {
                        pending_iter->second.candidate_tags |= proto::CandidateTag::UNRESOLVED_PEER;
                    }
                }
            }
        }
    });
}

static const NameScoringTable& selectScoringTable(proto::CompletionStrategy strategy) {
    switch (strategy) {
        case proto::CompletionStrategy::DEFAULT:
            return NAME_SCORE_DEFAULTS;
        case proto::CompletionStrategy::TABLE_REF:
            return NAME_SCORE_TABLE_REF;
        case proto::CompletionStrategy::COLUMN_REF:
            return NAME_SCORE_COLUMN_REF;
    }
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

    // Resolve the scoring table
    auto& base_scoring_table = selectScoringTable(strategy);

    // Insert all pending candidates into the heap
    for (auto& [key, candidate] : pending_candidates) {
        // Score the candidate
        Completion::ScoreValueType score = 0;
        // Derive the base score as maximum among the name tags
        for (auto [tag, tag_score] : base_scoring_table) {
            score = std::max(score, candidate.coarse_name_tags.contains(tag) ? tag_score : 0);
        }
        // Apply all score modifiers
        score += ((candidate.candidate_tags & proto::CandidateTag::SUBSTRING_MATCH) != 0) * SUBSTRING_SCORE_MODIFIER;
        score += ((candidate.candidate_tags & proto::CandidateTag::PREFIX_MATCH) != 0) * PREFIX_SCORE_MODIFIER;
        score +=
            ((candidate.candidate_tags & proto::CandidateTag::RESOLVING_TABLE) != 0) * RESOLVING_TABLE_SCORE_MODIFIER;
        score +=
            ((candidate.candidate_tags & proto::CandidateTag::UNRESOLVED_PEER) != 0) * UNRESOLVED_PEER_SCORE_MODIFIER;
        score +=
            ((candidate.candidate_tags & proto::CandidateTag::DOT_RESOLUTION_TABLE) != 0) * DOT_TABLE_SCORE_MODIFIER;
        score +=
            ((candidate.candidate_tags & proto::CandidateTag::DOT_RESOLUTION_SCHEMA) != 0) * DOT_SCHEMA_SCORE_MODIFIER;
        score +=
            ((candidate.candidate_tags & proto::CandidateTag::DOT_RESOLUTION_COLUMN) != 0) * DOT_COLUMN_SCORE_MODIFIER;

        // Add the scored candidate
        result_heap.Insert(CandidateWithScore{std::move(candidate), score});
    }
    pending_candidates.clear();

    // Finish the heap
    result_heap.Finish();
}

static proto::CompletionStrategy selectStrategy(const ScriptCursor& cursor) {
    switch (cursor.context.index()) {
        case 1:
            assert(std::holds_alternative<ScriptCursor::TableRefContext>(cursor.context));
            return proto::CompletionStrategy::TABLE_REF;
        case 2:
            assert(std::holds_alternative<ScriptCursor::ColumnRefContext>(cursor.context));
            return proto::CompletionStrategy::COLUMN_REF;
        default:
            return proto::CompletionStrategy::DEFAULT;
    }
}

Completion::Completion(const ScriptCursor& cursor, size_t k)
    : cursor(cursor), strategy(selectStrategy(cursor)), result_heap(k) {}

std::pair<std::unique_ptr<Completion>, proto::StatusCode> Completion::Compute(const ScriptCursor& cursor, size_t k) {
    auto completion = std::make_unique<Completion>(cursor, k);

    // Skip completion for the current symbol?
    if (doNotCompleteSymbol(cursor.scanner_location->symbol)) {
        return {std::move(completion), proto::StatusCode::OK};
    }

    // Is the current symbol an inner dot?
    if (cursor.scanner_location->currentSymbolIsDot()) {
        using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
        switch (cursor.scanner_location->relative_pos) {
            case RelativePosition::NEW_SYMBOL_AFTER:
            case RelativePosition::END_OF_SYMBOL: {
                completion->FindCandidatesForNamePath();
                completion->FlushCandidatesAndFinish();
                return {std::move(completion), proto::StatusCode::OK};
            }

            case RelativePosition::BEGIN_OF_SYMBOL:
            case RelativePosition::MID_OF_SYMBOL:
            case RelativePosition::NEW_SYMBOL_BEFORE:
                // Don't complete the dot itself
                return {std::move(completion), proto::StatusCode::OK};
        }
    }

    // Is the current symbol a trailing dot?
    else if (cursor.scanner_location->currentSymbolIsTrailingDot()) {
        using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
        switch (cursor.scanner_location->relative_pos) {
            case RelativePosition::NEW_SYMBOL_AFTER:
            case RelativePosition::END_OF_SYMBOL: {
                completion->FindCandidatesForNamePath();
                completion->FlushCandidatesAndFinish();
                return {std::move(completion), proto::StatusCode::OK};
            }
            case RelativePosition::BEGIN_OF_SYMBOL:
            case RelativePosition::MID_OF_SYMBOL:
            case RelativePosition::NEW_SYMBOL_BEFORE: {
                // Don't complete the dot itself
                return {std::move(completion), proto::StatusCode::OK};
            }
        }
    }

    // Find the expected symbols at this location
    std::vector<parser::Parser::ExpectedSymbol> expected_symbols;
    if (cursor.scanner_location->relative_pos == ScannedScript::LocationInfo::RelativePosition::NEW_SYMBOL_AFTER &&
        !cursor.scanner_location->at_eof) {
        expected_symbols =
            parser::Parser::ParseUntil(*cursor.script.scanned_script, cursor.scanner_location->symbol_id + 1);
    } else {
        expected_symbols =
            parser::Parser::ParseUntil(*cursor.script.scanned_script, cursor.scanner_location->symbol_id);
    }
    bool expects_identifier = false;
    for (auto& expected : expected_symbols) {
        if (expected == parser::Parser::symbol_kind_type::S_IDENT) {
            expects_identifier = true;
            break;
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
    if (cursor.scanner_location->previousSymbolIsDot() && expects_identifier) {
        using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
        switch (cursor.scanner_location->relative_pos) {
            case RelativePosition::END_OF_SYMBOL:
            case RelativePosition::BEGIN_OF_SYMBOL:
            case RelativePosition::MID_OF_SYMBOL: {
                completion->FindCandidatesForNamePath();
                completion->FlushCandidatesAndFinish();
                return {std::move(completion), proto::StatusCode::OK};
            }
            case RelativePosition::NEW_SYMBOL_AFTER:
            case RelativePosition::NEW_SYMBOL_BEFORE:
                /// NEW_SYMBOL_BEFORE should be unreachable, the previous symbol would have been a trailing dot...
                /// NEW_SYMBOL_AFTER is not qualifying for dot completion

                // Proceed with normal completion...
                break;
        }
    }

    // Add expected grammar symbols to the heap and score them
    completion->AddExpectedKeywordsAsCandidates(expected_symbols);
    // Also check the name indexes when expecting an identifier
    if (expects_identifier) {
        // Just find all candidates in the name index
        completion->FindCandidatesInIndexes();
        // Promote names of all tables that could resolve an unresolved column
        completion->PromoteTablesAndPeersForUnresolvedColumns();
    }
    completion->FlushCandidatesAndFinish();

    // Register as normal completion
    return {std::move(completion), proto::StatusCode::OK};
}

flatbuffers::Offset<proto::Completion> Completion::Pack(flatbuffers::FlatBufferBuilder& builder) {
    auto& entries = result_heap.GetEntries();

    // Pack candidates
    std::vector<flatbuffers::Offset<proto::CompletionCandidate>> candidates;
    candidates.reserve(entries.size());
    for (auto iter_entry = entries.rbegin(); iter_entry != entries.rend(); ++iter_entry) {
        auto display_text_offset = builder.CreateString(iter_entry->name);
        std::string quoted;
        std::string_view completion_text = iter_entry->name;
        completion_text = quote_anyupper_fuzzy(completion_text, quoted);
        size_t catalog_object_count = iter_entry->catalog_objects.size();
        std::vector<flatbuffers::Offset<proto::CompletionCandidateObject>> catalog_objects;
        catalog_objects.reserve(catalog_object_count);
        for (auto iter_obj = iter_entry->catalog_objects.begin(); iter_obj != iter_entry->catalog_objects.end();
             ++iter_obj) {
            auto& o = iter_obj->get();
            proto::CompletionCandidateObjectBuilder obj{builder};
            obj.add_object_type(static_cast<proto::CompletionCandidateObjectType>(o.object_type));
            switch (o.object_type) {
                case CatalogObjectType::DatabaseReference: {
                    auto& db = o.CastUnsafe<CatalogEntry::DatabaseReference>();
                    obj.add_catalog_database_id(db.catalog_database_id);
                    break;
                }
                case CatalogObjectType::SchemaReference: {
                    auto& schema = o.CastUnsafe<CatalogEntry::SchemaReference>();
                    obj.add_catalog_database_id(schema.catalog_database_id);
                    obj.add_catalog_schema_id(schema.catalog_schema_id);
                    break;
                }
                case CatalogObjectType::TableDeclaration: {
                    auto& table = o.CastUnsafe<CatalogEntry::TableDeclaration>();
                    obj.add_catalog_database_id(table.catalog_database_id);
                    obj.add_catalog_schema_id(table.catalog_schema_id);
                    obj.add_catalog_table_id(table.catalog_table_id.Pack());
                    break;
                }
                case CatalogObjectType::ColumnDeclaration: {
                    auto& column = o.CastUnsafe<CatalogEntry::TableColumn>();
                    auto& table = column.table->get();
                    obj.add_catalog_database_id(table.catalog_database_id);
                    obj.add_catalog_schema_id(table.catalog_schema_id);
                    obj.add_catalog_table_id(table.catalog_table_id.Pack());
                    obj.add_table_column_id(column.column_index);
                    break;
                }
            }
            catalog_objects.push_back(obj.Finish());
        }
        auto catalog_objects_ofs = builder.CreateVector(catalog_objects);
        auto completion_text_ofs = builder.CreateString(completion_text);
        proto::CompletionCandidateBuilder candidateBuilder{builder};
        candidateBuilder.add_display_text(display_text_offset);
        candidateBuilder.add_completion_text(completion_text_ofs);
        candidateBuilder.add_candidate_tags(iter_entry->candidate_tags);
        candidateBuilder.add_name_tags(iter_entry->coarse_name_tags);
        candidateBuilder.add_catalog_objects(catalog_objects_ofs);
        candidateBuilder.add_score(iter_entry->score);
        candidateBuilder.add_replace_text_at(&iter_entry->replace_text_at);
        candidates.push_back(candidateBuilder.Finish());
    }
    auto candidatesOfs = builder.CreateVector(candidates);

    // Pack completion table
    proto::CompletionBuilder completionBuilder{builder};
    completionBuilder.add_text_offset(cursor.text_offset);
    completionBuilder.add_strategy(strategy);
    completionBuilder.add_candidates(candidatesOfs);
    return completionBuilder.Finish();
}

}  // namespace sqlynx
