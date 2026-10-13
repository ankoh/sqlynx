#include "dashql/script_session.h"

#include <flatbuffers/flatbuffer_builder.h>

#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "dashql/api.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "gtest/gtest.h"

namespace dashql {
namespace {

using ScriptSession = ScriptSession;

using buffers::editor::EditorCursorSemanticKind;
using buffers::editor::EditorDiagnosticSource;
using buffers::editor::EditorEventAction;
using buffers::editor::EditorEventIntent;
using buffers::editor::EditorEventOrigin;
using buffers::editor::EditorSemanticReferenceKind;
using buffers::editor::EditorSemanticResolution;
using buffers::editor::EditorUpdateStatus;

std::unique_ptr<buffers::editor::EditorTextChangeT> Change(uint64_t from, uint64_t to, std::string_view insert) {
    auto change = std::make_unique<buffers::editor::EditorTextChangeT>();
    change->from = from;
    change->to = to;
    change->insert = insert;
    return change;
}

const char* CopyText(std::string_view text) {
    auto* buffer = dashql_malloc(text.size());
    std::memcpy(buffer, text.data(), text.size());
    return reinterpret_cast<const char*>(buffer);
}

std::vector<uint8_t> TakeBuffer(FFIResult& result) {
    auto* begin = static_cast<const uint8_t*>(result.data_ptr);
    std::vector<uint8_t> data(begin, begin + result.data_length);
    dashql_delete_owner(result.owner_ptr, result.owner_deleter);
    return data;
}

template <typename T> const T* ReadBuffer(const std::vector<uint8_t>& data) {
    return flatbuffers::GetRoot<T>(data.data());
}

ScriptSession::EditorUpdate Analyze(ScriptSession& session, std::string_view text) {
    ScriptSession::EditorEvent event;
    event.expected_text_version = session.GetTextVersion();
    event.analyze = true;
    event.changes.push_back(Change(0, session.GetText().size(), text));
    return session.Apply(event);
}

std::string_view ReadSpan(std::string_view text, const buffers::editor::EditorTextSpan* span) {
    if (span == nullptr) return {};
    return text.substr(span->offset(), span->length());
}

const buffers::editor::EditorSemanticSpanT* FindSemanticSpan(const ScriptSession::EditorUpdate& update,
                                                             std::string_view text,
                                                             buffers::editor::EditorSemanticReferenceKind kind,
                                                             std::string_view source) {
    for (auto& span : update.semantic_spans) {
        if (span->kind == kind && ReadSpan(text, span->text_span.get()) == source) return span.get();
    }
    return nullptr;
}

TEST(ScriptSessionTest, AppliesAtomicBatchInPreChangeOffsets) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_EQ(session.ReplaceText(0, "abcdef").status, EditorUpdateStatus::OK);

    ScriptSession::EditorEvent event;
    event.expected_text_version = 1;
    event.origin = EditorEventOrigin::USER;
    event.intent = EditorEventIntent::EDIT;
    event.action = EditorEventAction::TYPE;
    event.changes.push_back(Change(1, 2, "X"));
    event.changes.push_back(Change(4, 6, "YZ"));
    event.primary_selection = std::make_unique<ScriptSession::EditorSelection>();
    event.primary_selection->anchor = 6;
    event.primary_selection->head = 6;

    auto update = session.Apply(event);
    EXPECT_EQ(update.status, EditorUpdateStatus::OK);
    EXPECT_EQ(session.GetText(), "aXcdYZ");
    EXPECT_EQ(update.text_version, 2);
    EXPECT_EQ(session.GetScript().text_version, 2);
    EXPECT_EQ(update.state_revision, 2);
    ASSERT_NE(update.primary_selection, nullptr);
    EXPECT_EQ(update.primary_selection->head, 6);
}

TEST(ScriptSessionTest, PreservesInputOrderForInsertionsAtSameOffset) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_EQ(session.ReplaceText(0, "ab").status, EditorUpdateStatus::OK);

    ScriptSession::EditorEvent event;
    event.expected_text_version = 1;
    event.changes.push_back(Change(1, 1, "X"));
    event.changes.push_back(Change(1, 1, "Y"));

    EXPECT_EQ(session.Apply(event).status, EditorUpdateStatus::OK);
    EXPECT_EQ(session.GetText(), "aXYb");
}

TEST(ScriptSessionTest, NoOpAndRejectedEditsPreserveTextVersion) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_EQ(session.ReplaceText(0, "abc").status, EditorUpdateStatus::OK);
    auto unchanged = session.ReplaceText(1, "abc");
    EXPECT_FALSE(unchanged.text_changed);
    EXPECT_EQ(unchanged.text_version, 1);

    ScriptSession::EditorEvent event;
    event.expected_text_version = 1;
    event.changes.push_back(Change(0, 1, "a"));
    event.changes.push_back(Change(100, 100, ""));
    auto update = session.Apply(event);
    EXPECT_EQ(update.status, EditorUpdateStatus::OK);
    EXPECT_FALSE(update.text_changed);
    EXPECT_EQ(update.text_version, 1);
    EXPECT_EQ(update.state_revision, 1);

    event.changes.push_back(Change(2, 2, "\xFF"));
    EXPECT_EQ(session.Apply(event).status, EditorUpdateStatus::INVALID_UTF8);
    EXPECT_EQ(session.GetTextVersion(), 1);
    EXPECT_EQ(session.GetScript().text_version, 1);
    EXPECT_EQ(session.GetText(), "abc");
}

TEST(ScriptSessionTest, DirectScriptEditsShareVersionAndRefreshAnalysis) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_TRUE(Analyze(session, "select 1").analysis_available);
    ASSERT_EQ(session.SetPrimaryCursor(1, 7).status, EditorUpdateStatus::OK);
    auto first_analysis = session.GetScript().GetAnalyzedScript();
    session.GetScript().InsertTextAt(0, "-- comment\n");
    EXPECT_EQ(session.GetTextVersion(), 2);

    auto stale = session.ReplaceText(1, "select 2");
    EXPECT_EQ(stale.status, EditorUpdateStatus::STALE_TEXT_VERSION);
    EXPECT_EQ(stale.text_version, 2);
    EXPECT_FALSE(stale.analysis_available);
    EXPECT_TRUE(stale.syntax_spans.empty());

    auto update = session.Analyze();
    EXPECT_EQ(update.text_version, 2);
    EXPECT_TRUE(update.analysis_updated);
    EXPECT_TRUE(update.analysis_available);
    EXPECT_NE(session.GetScript().GetAnalyzedScript(), first_analysis);
    EXPECT_EQ(session.GetScript().GetAnalyzedScript()->parsed_script->scanned_script->text_version, 2);

    // A direct parse can invalidate snapshot identity without changing the text version.
    session.GetScript().Parse();
    auto reparsed = session.Analyze();
    EXPECT_TRUE(reparsed.analysis_updated);
    EXPECT_TRUE(reparsed.analysis_available);
    ASSERT_NE(reparsed.primary_cursor_state, nullptr);
    EXPECT_EQ(reparsed.primary_cursor_state->text_offset, 7);
    EXPECT_EQ(session.GetTextVersion(), 2);

    // Restoring an older native snapshot must not fool the session's captured version.
    session.GetScript().analyzed_script = first_analysis;
    session.GetScript().parsed_script = first_analysis->parsed_script;
    session.GetScript().scanned_script = first_analysis->parsed_script->scanned_script;
    auto restored = session.Analyze();
    EXPECT_TRUE(restored.analysis_updated);
    EXPECT_TRUE(restored.analysis_available);
    EXPECT_EQ(session.GetScript().GetAnalyzedScript()->parsed_script->scanned_script->text_version, 2);
    EXPECT_EQ(session.GetTextVersion(), 2);
}

TEST(ScriptSessionTest, ClampsInsertionPastDocumentEnd) {
    Catalog catalog;
    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
    ASSERT_EQ(session.ReplaceText(0, "a\xF0\x9F\x98\x80").status, EditorUpdateStatus::OK);

    ScriptSession::EditorEvent event;
    event.expected_text_version = 1;
    event.changes.push_back(Change(100, 100, "!"));

    EXPECT_EQ(session.Apply(event).status, EditorUpdateStatus::OK);
    EXPECT_EQ(session.GetText(), "a\xF0\x9F\x98\x80!");
}

TEST(ScriptSessionTest, RejectsWholeOverlappingOrStaleBatch) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_EQ(session.ReplaceText(0, "abcdef").status, EditorUpdateStatus::OK);

    ScriptSession::EditorEvent overlap;
    overlap.expected_text_version = 1;
    overlap.changes.push_back(Change(1, 4, "x"));
    overlap.changes.push_back(Change(3, 5, "y"));
    auto overlap_update = session.Apply(overlap);
    EXPECT_EQ(overlap_update.status, EditorUpdateStatus::OVERLAPPING_CHANGES);
    EXPECT_EQ(session.GetText(), "abcdef");
    EXPECT_EQ(session.GetTextVersion(), 1);
    EXPECT_EQ(session.GetScript().text_version, 1);

    ScriptSession::EditorEvent stale;
    stale.expected_text_version = 0;
    stale.changes.push_back(Change(0, 1, "z"));
    auto stale_update = session.Apply(stale);
    EXPECT_EQ(stale_update.status, EditorUpdateStatus::STALE_TEXT_VERSION);
    EXPECT_EQ(session.GetTextVersion(), 1);
    EXPECT_EQ(session.GetText(), "abcdef");
    EXPECT_EQ(session.GetStateRevision(), 1);
}

TEST(ScriptSessionTest, ConvertsUtf8ByteOffsetsAndRejectsSplitCodepoints) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_EQ(session.ReplaceText(0, "a\xC3\xA9z").status, EditorUpdateStatus::OK);

    ScriptSession::EditorEvent valid;
    valid.expected_text_version = 1;
    valid.changes.push_back(Change(1, 3, "\xE2\x98\x83"));
    auto valid_update = session.Apply(valid);
    EXPECT_EQ(valid_update.status, EditorUpdateStatus::OK);
    EXPECT_EQ(session.GetText(), "a\xE2\x98\x83z");

    ScriptSession::EditorEvent split;
    split.expected_text_version = 2;
    split.changes.push_back(Change(2, 3, "x"));
    auto split_update = session.Apply(split);
    EXPECT_EQ(split_update.status, EditorUpdateStatus::INVALID_RANGE);
    EXPECT_EQ(session.GetText(), "a\xE2\x98\x83z");
    EXPECT_EQ(session.GetTextVersion(), 2);
}

TEST(ScriptSessionTest, UsesUtf16OffsetsForEventsSelectionsAndProjections) {
    constexpr std::string_view text = "select '\xF0\x9F\x98\x80' from missing";
    Catalog catalog;
    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};

    auto update = Analyze(session, text);
    ASSERT_EQ(update.status, EditorUpdateStatus::OK);
    EXPECT_EQ(update.offset_unit, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS);
    auto missing = std::find_if(update.semantic_spans.begin(), update.semantic_spans.end(), [](const auto& span) {
        return span->kind == EditorSemanticReferenceKind::TABLE &&
               span->resolution == EditorSemanticResolution::UNRESOLVED;
    });
    ASSERT_NE(missing, update.semantic_spans.end());
    EXPECT_EQ((*missing)->text_span->offset(), 17u);

    ScriptSession::EditorEvent event;
    event.expected_text_version = 1;
    event.changes.push_back(Change(8, 10, "x"));
    event.primary_selection = std::make_unique<ScriptSession::EditorSelection>();
    event.primary_selection->anchor = 9;
    event.primary_selection->head = 9;
    update = session.Apply(event);
    EXPECT_EQ(update.status, EditorUpdateStatus::OK);
    EXPECT_EQ(session.GetText(), "select 'x' from missing");
    ASSERT_NE(update.primary_selection, nullptr);
    EXPECT_EQ(update.primary_selection->head, 9u);

    ScriptSession::EditorEvent split_surrogate;
    split_surrogate.expected_text_version = 2;
    split_surrogate.changes.push_back(Change(0, 0, "\xF0\x9F\x98\x80"));
    split_surrogate.primary_selection = std::make_unique<ScriptSession::EditorSelection>();
    split_surrogate.primary_selection->anchor = 1;
    split_surrogate.primary_selection->head = 1;
    EXPECT_EQ(session.Apply(split_surrogate).status, EditorUpdateStatus::INVALID_RANGE);
}

TEST(ScriptSessionTest, ProjectsCompletionAndDiffAsUtf16) {
    Catalog catalog;
    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
    ASSERT_EQ(session.ReplaceText(0, "-- \xF0\x9F\x98\x80\ns").status, EditorUpdateStatus::OK);
    ASSERT_EQ(session.SetPrimaryCursor(1, 7).status, EditorUpdateStatus::OK);
    ASSERT_EQ(session.Analyze().status, EditorUpdateStatus::OK);

    flatbuffers::FlatBufferBuilder completion_builder;
    completion_builder.Finish(session.PackCompletion(completion_builder, 10, buffers::formatting::KeywordCase::LOWER));
    auto* completion = flatbuffers::GetRoot<buffers::completion::Completion>(completion_builder.GetBufferPointer());
    ASSERT_NE(completion->candidates(), nullptr);
    ASSERT_FALSE(completion->candidates()->empty());
    EXPECT_EQ(completion->cursor_offset(), 7u);
    auto* candidate = completion->candidates()->Get(0);
    ASSERT_NE(candidate->target_location(), nullptr);
    EXPECT_EQ(candidate->target_location()->offset(), 6u);

    Script target{catalog};
    target.ReplaceText("-- \xF0\x9F\x98\x80\nselect 2");
    target.Parse();
    flatbuffers::FlatBufferBuilder diff_builder;
    diff_builder.Finish(session.PackDiff(diff_builder, target));
    auto* diff = flatbuffers::GetRoot<buffers::diff::ScriptDiff>(diff_builder.GetBufferPointer());
    ASSERT_NE(diff->ops(), nullptr);
    ASSERT_FALSE(diff->ops()->empty());
    auto* target_span = diff->ops()->Get(0)->target_span();
    ASSERT_NE(target_span, nullptr);
    EXPECT_EQ(target_span->offset(), 6u);
}

TEST(ScriptSessionTest, AnalyzesAtCatalogRevision) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_EQ(session.ReplaceText(0, "create table items (id int); select * from items;").status,
              EditorUpdateStatus::OK);
    EXPECT_FALSE(catalog.Contains(session.GetCatalogEntryId()));

    auto update = session.Analyze();
    EXPECT_EQ(update.status, EditorUpdateStatus::OK);
    EXPECT_TRUE(update.analysis_updated);
    EXPECT_TRUE(update.analysis_available);
    EXPECT_NE(session.GetScript().GetAnalyzedScript(), nullptr);
    EXPECT_FALSE(catalog.Contains(session.GetCatalogEntryId()));
    EXPECT_EQ(update.catalog_revision, catalog.GetVersion());
    EXPECT_EQ(update.state_revision, 2);

    auto no_op = session.Analyze();
    EXPECT_FALSE(no_op.analysis_updated);
    EXPECT_EQ(no_op.state_revision, 2);

    catalog.Clear();
    auto catalog_refresh = session.Analyze();
    EXPECT_TRUE(catalog_refresh.analysis_updated);
    EXPECT_TRUE(catalog_refresh.analysis_available);
    EXPECT_EQ(catalog_refresh.catalog_revision, catalog.GetVersion());
    EXPECT_EQ(catalog_refresh.state_revision, 3);

    auto edit = session.ReplaceText(1, "select 1");
    EXPECT_EQ(edit.status, EditorUpdateStatus::OK);
    EXPECT_FALSE(edit.analysis_available);
    EXPECT_NE(session.GetScript().GetAnalyzedScript(), nullptr);
}

TEST(ScriptSessionTest, CursorMoveRefreshesAnalysisAfterCatalogRevision) {
    Catalog catalog;
    ScriptSession source{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
    auto initial = Analyze(source, "select value from items");
    ASSERT_TRUE(initial.analysis_available);
    ASSERT_FALSE(initial.syntax_spans.empty());

    ScriptSession schema{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
    ASSERT_TRUE(Analyze(schema, "create table items (value int)").analysis_available);
    schema.LoadIntoCatalog(0);

    auto moved = source.SetPrimaryCursor(source.GetTextVersion(), 7);
    EXPECT_EQ(moved.status, EditorUpdateStatus::OK);
    EXPECT_TRUE(moved.analysis_available);
    EXPECT_TRUE(moved.analysis_updated);
    EXPECT_FALSE(moved.syntax_spans.empty());
}

TEST(ScriptSessionTest, EditingPublishedScriptDropsStaleCatalogEntry) {
    Catalog catalog;
    ScriptSession session{catalog};
    ASSERT_TRUE(Analyze(session, "create table items (id int)").analysis_available);
    session.LoadIntoCatalog(0);
    ASSERT_TRUE(catalog.Contains(session.GetCatalogEntryId()));

    auto no_op = session.ReplaceText(session.GetTextVersion(), "create table items (id int)");
    EXPECT_FALSE(no_op.text_changed);
    EXPECT_TRUE(no_op.analysis_available);
    EXPECT_TRUE(catalog.Contains(session.GetCatalogEntryId()));
    EXPECT_FALSE(session.Analyze().analysis_updated);

    auto update = session.ReplaceText(session.GetTextVersion(), "create table updated (id int)");

    EXPECT_EQ(update.status, EditorUpdateStatus::OK);
    EXPECT_FALSE(catalog.Contains(session.GetCatalogEntryId()));
}

TEST(ScriptSessionTest, EditCanSynchronouslyAnalyzeAndPlaceCursor) {
    Catalog catalog;
    ScriptSession session{catalog};

    ScriptSession::EditorEvent event;
    event.expected_text_version = 0;
    event.analyze = true;
    event.changes.push_back(Change(0, 0, "select 1"));
    event.primary_selection = std::make_unique<ScriptSession::EditorSelection>();
    event.primary_selection->anchor = 8;
    event.primary_selection->head = 8;

    auto update = session.Apply(event);
    EXPECT_EQ(update.status, EditorUpdateStatus::OK);
    EXPECT_TRUE(update.analysis_updated);
    EXPECT_TRUE(update.analysis_available);
    ASSERT_NE(session.GetScript().cursor, nullptr);
    EXPECT_EQ(session.GetScript().cursor->text_offset, 8);
    ASSERT_NE(update.primary_cursor_state, nullptr);
    EXPECT_EQ(update.primary_cursor_state->text_offset, 8u);
    EXPECT_EQ(update.primary_cursor_state->scanner_relative_position,
              buffers::cursor::RelativeSymbolPosition::END_OF_SYMBOL);
    EXPECT_FALSE(update.primary_cursor_state->scanner_symbol_completable);
    EXPECT_EQ(update.text_version, 1);
    EXPECT_EQ(update.state_revision, 1);
}

TEST(ScriptSessionTest, ProjectsUnicodeSyntaxCommentsAndDiagnosticsAsUtf8Bytes) {
    constexpr std::string_view text = "-- caf\xC3\xA9\nselect '\xC3\xA9' from missing";
    Catalog catalog;
    ScriptSession session{catalog};
    auto update = Analyze(session, text);

    ASSERT_EQ(update.status, EditorUpdateStatus::OK);
    ASSERT_TRUE(update.analysis_available);
    bool saw_comment = false;
    bool saw_literal = false;
    for (auto& span : update.syntax_spans) {
        if (span->token_type == buffers::parser::ScannerTokenType::COMMENT) {
            EXPECT_EQ(ReadSpan(text, span->text_span.get()), "-- caf\xC3\xA9");
            EXPECT_EQ(span->text_span->length(), 8u);
            saw_comment = true;
        }
        if (span->token_type == buffers::parser::ScannerTokenType::LITERAL_STRING) {
            EXPECT_EQ(ReadSpan(text, span->text_span.get()), "'\xC3\xA9'");
            EXPECT_EQ(span->text_span->length(), 4u);
            saw_literal = true;
        }
    }
    EXPECT_TRUE(saw_comment);
    EXPECT_TRUE(saw_literal);
    auto* missing = FindSemanticSpan(update, text, EditorSemanticReferenceKind::TABLE, "missing");
    ASSERT_NE(missing, nullptr);
    EXPECT_EQ(missing->resolution, EditorSemanticResolution::UNRESOLVED);
    EXPECT_EQ(missing->text_span->offset(), text.find("missing"));

    ScriptSession scanner_session{catalog};
    constexpr std::string_view scanner_text = "select '\xC3\xA9";
    auto scanner_update = Analyze(scanner_session, scanner_text);
    ASSERT_FALSE(scanner_update.diagnostics.empty());
    auto scanner = std::find_if(scanner_update.diagnostics.begin(), scanner_update.diagnostics.end(),
                                [](auto& d) { return d->source == EditorDiagnosticSource::SCANNER; });
    ASSERT_NE(scanner, scanner_update.diagnostics.end());
    EXPECT_EQ((*scanner)->message, "unterminated quoted string");
    EXPECT_EQ(ReadSpan(scanner_text, (*scanner)->text_span.get()), "'\xC3\xA9");

    ScriptSession parser_session{catalog};
    constexpr std::string_view parser_text = "select 1 'alias'";
    auto parser_update = Analyze(parser_session, parser_text);
    auto parser = std::find_if(parser_update.diagnostics.begin(), parser_update.diagnostics.end(),
                               [](auto& d) { return d->source == EditorDiagnosticSource::PARSER; });
    ASSERT_NE(parser, parser_update.diagnostics.end());
    EXPECT_FALSE((*parser)->message.empty());
    EXPECT_FALSE(ReadSpan(parser_text, (*parser)->text_span.get()).empty());
}

TEST(ScriptSessionTest, ProjectsAnalyzerErrorsAndResolvedAndUnresolvedReferences) {
    Catalog catalog;
    Script schema{catalog};
    schema.ReplaceText("create table items (id int); create table other (id int)");
    schema.Analyze();
    catalog.LoadScript(schema, 0);

    ScriptSession ambiguous_session{catalog};
    constexpr std::string_view ambiguous_text = "select id from items, other";
    auto ambiguous_update = Analyze(ambiguous_session, ambiguous_text);
    auto analyzer = std::find_if(ambiguous_update.diagnostics.begin(), ambiguous_update.diagnostics.end(),
                                 [](auto& d) { return d->source == EditorDiagnosticSource::ANALYZER; });
    ASSERT_NE(analyzer, ambiguous_update.diagnostics.end());
    EXPECT_NE((*analyzer)->message.find("ambiguous"), std::string::npos);
    EXPECT_EQ(ReadSpan(ambiguous_text, (*analyzer)->text_span.get()), "id");

    ScriptSession session{catalog};
    constexpr std::string_view text = "select id, missing from items, absent";
    auto update = Analyze(session, text);
    auto* items = FindSemanticSpan(update, text, EditorSemanticReferenceKind::TABLE, "items");
    auto* absent = FindSemanticSpan(update, text, EditorSemanticReferenceKind::TABLE, "absent");
    auto* id = FindSemanticSpan(update, text, EditorSemanticReferenceKind::COLUMN, "id");
    auto* missing = FindSemanticSpan(update, text, EditorSemanticReferenceKind::COLUMN, "missing");
    ASSERT_NE(items, nullptr);
    ASSERT_NE(absent, nullptr);
    ASSERT_NE(id, nullptr);
    ASSERT_NE(missing, nullptr);
    EXPECT_EQ(items->resolution, EditorSemanticResolution::RESOLVED);
    EXPECT_NE(items->catalog_table_id, 0u);
    EXPECT_EQ(absent->resolution, EditorSemanticResolution::UNRESOLVED);
    EXPECT_EQ(id->resolution, EditorSemanticResolution::RESOLVED);
    EXPECT_EQ(id->catalog_table_id, items->catalog_table_id);
    EXPECT_EQ(missing->resolution, EditorSemanticResolution::UNRESOLVED);
}

TEST(ScriptSessionTest, ProjectsFunctionReferenceSpans) {
    Catalog catalog;
    Script schema{catalog};
    schema.ReplaceText("create table items (id int)");
    schema.Analyze();
    catalog.LoadScript(schema, 0);

    ScriptSession session{catalog};
    constexpr std::string_view text = "select count(id) from items";
    auto update = Analyze(session, text);
    auto* function = FindSemanticSpan(update, text, EditorSemanticReferenceKind::FUNCTION, "count");
    auto* table = FindSemanticSpan(update, text, EditorSemanticReferenceKind::TABLE, "items");
    ASSERT_NE(function, nullptr);
    ASSERT_NE(table, nullptr);
}

TEST(ScriptSessionTest, ProjectsPrimaryCursorSemanticContextAndRelatedReferences) {
    Catalog catalog;
    Script schema{catalog};
    schema.ReplaceText("create table items (id int)");
    schema.Analyze();
    catalog.LoadScript(schema, 0);

    ScriptSession session{catalog};
    constexpr std::string_view text = "select id from items where id = 1 and items.id > 0";
    auto update = Analyze(session, text);
    ASSERT_EQ(update.status, EditorUpdateStatus::OK);

    auto column_update = session.SetPrimaryCursor(session.GetTextVersion(), 8);
    ASSERT_NE(column_update.primary_cursor_context, nullptr);
    EXPECT_EQ(column_update.primary_cursor_context->kind, EditorCursorSemanticKind::COLUMN_REFERENCE);
    EXPECT_TRUE(column_update.primary_cursor_context->resolved);
    EXPECT_EQ(column_update.primary_cursor_context->related_table_reference_ids.size(), 1u);
    EXPECT_EQ(column_update.primary_cursor_context->related_column_reference_ids.size(), 3u);
    EXPECT_EQ(column_update.primary_cursor_context->catalog_column_id, 0u);

    const auto table_offset = text.find("items") + 2;
    auto table_update = session.SetPrimaryCursor(session.GetTextVersion(), table_offset);
    ASSERT_NE(table_update.primary_cursor_context, nullptr);
    EXPECT_EQ(table_update.primary_cursor_context->kind, EditorCursorSemanticKind::TABLE_REFERENCE);
    EXPECT_TRUE(table_update.primary_cursor_context->resolved);
    EXPECT_EQ(table_update.primary_cursor_context->related_table_reference_ids.size(), 1u);
    EXPECT_EQ(table_update.primary_cursor_context->related_column_reference_ids.size(), 3u);
}

TEST(ScriptSessionTest, ProjectsScriptAnnotationsAndPlainProcessingStatistics) {
    Catalog catalog;
    ScriptSession session{catalog};
    constexpr std::string_view text = "create table result (id int); select id from result";
    auto update = Analyze(session, text);

    ASSERT_NE(update.script_annotations, nullptr);
    ASSERT_EQ(update.script_annotations->table_definitions.size(), 1u);
    EXPECT_EQ(update.script_annotations->table_definitions[0]->name, "result");
    EXPECT_EQ(update.script_annotations->table_definitions[0]->statement_id, 0u);
    ASSERT_EQ(update.script_annotations->referenced_table_names.size(), 1u);
    EXPECT_EQ(update.script_annotations->referenced_table_names[0], "result");
    EXPECT_FALSE(update.script_annotations->has_visualization_compilation);
    ASSERT_EQ(update.script_annotations->statements.size(), 2u);
    EXPECT_EQ(update.script_annotations->statements[0]->statement_id, 0u);
    EXPECT_EQ(update.script_annotations->statements[0]->statement_type, buffers::parser::StatementType::CREATE_TABLE);
    EXPECT_EQ(update.script_annotations->statements[1]->statement_id, 1u);
    EXPECT_EQ(update.script_annotations->statements[1]->statement_type, buffers::parser::StatementType::SELECT);
    ASSERT_NE(update.processing_statistics, nullptr);
    EXPECT_GT(update.processing_statistics->rope_bytes, 0u);
    EXPECT_EQ(update.processing_statistics->scanner_input_bytes, text.size());
    EXPECT_GT(update.processing_statistics->scanner_symbol_bytes, 0u);
    EXPECT_GT(update.processing_statistics->parser_ast_bytes, 0u);
    EXPECT_GT(update.processing_statistics->analyzer_description_bytes, 0u);
    EXPECT_GE(update.processing_statistics->scanner_last_elapsed_ns, 0.0);
    EXPECT_GE(update.processing_statistics->parser_last_elapsed_ns, 0.0);
    EXPECT_GE(update.processing_statistics->analyzer_last_elapsed_ns, 0.0);
}

TEST(ScriptSessionTest, ProjectsStatementDescriptionsAsUtf16) {
    Catalog catalog;
    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
    auto update = Analyze(session, "-- \xF0\x9F\x98\x80 summary\nselect 1;");

    ASSERT_NE(update.script_annotations, nullptr);
    ASSERT_EQ(update.script_annotations->statements.size(), 1u);
    ASSERT_NE(update.script_annotations->statements[0]->text_span, nullptr);
    EXPECT_EQ(update.script_annotations->statements[0]->text_span->offset(), 14u);
    EXPECT_EQ(update.script_annotations->statements[0]->text_span->length(), 8u);
    ASSERT_EQ(update.script_annotations->statement_descriptions.size(), 1u);
    auto& description = update.script_annotations->statement_descriptions[0];
    EXPECT_EQ(description->statement_id, 0u);
    EXPECT_EQ(description->statement_type, buffers::parser::StatementType::SELECT);
    ASSERT_NE(description->text_span, nullptr);
    EXPECT_EQ(description->text_span->offset(), 14u);
    EXPECT_EQ(description->text_span->length(), 8u);
}

TEST(ScriptSessionTest, ProjectsIncompleteWithPrefixAsUtf16) {
    Catalog catalog;
    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};

    EXPECT_NO_THROW({
        auto update = Analyze(session, "wit");
        EXPECT_EQ(update.status, EditorUpdateStatus::OK);
        EXPECT_TRUE(update.analysis_available);
    });
}

TEST(ScriptSessionTest, ProjectsIncrementallyTypedWithPrefixAsUtf16) {
    Catalog catalog;
    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};

    for (std::string_view character : {"w", "i", "t"}) {
        ScriptSession::EditorEvent event;
        event.expected_text_version = session.GetTextVersion();
        event.analyze = true;
        const auto offset = session.GetText().size();
        event.changes.push_back(Change(offset, offset, character));
        event.primary_selection = std::make_unique<ScriptSession::EditorSelection>();
        event.primary_selection->anchor = offset + 1;
        event.primary_selection->head = offset + 1;
        EXPECT_NO_THROW({
            auto update = session.Apply(event);
            EXPECT_EQ(update.status, EditorUpdateStatus::OK);
            EXPECT_TRUE(update.analysis_available);
        });
    }
    EXPECT_EQ(session.GetText(), "wit");
}

TEST(ScriptSessionTest, ProjectsIncompleteWithPrefixAfterUtf8AsUtf16) {
    for (std::string_view text : {
             "\xC3\xA9 wit",
             "'\xC3\xA9' wit",
             "-- \xF0\x9F\x98\x80\nwit",
             "select '\xC3\xA9'; wit",
             "select caf\xC3\xA9\nwit",
         }) {
        SCOPED_TRACE(text);
        Catalog catalog;
        ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
        EXPECT_NO_THROW({
            auto update = Analyze(session, text);
            EXPECT_EQ(update.status, EditorUpdateStatus::OK);
            EXPECT_TRUE(update.analysis_available);
        });
    }
}

TEST(ScriptSessionTest, CAbiOwnsSessionAndDetachedUpdateBuffers) {
    Catalog catalog;
    const auto initial_catalog_revision = catalog.GetVersion();
    uint32_t entry_id = 0;
    {
        FFIResult session_result;
        dashql_script_session_new(&session_result, &catalog,
                                  static_cast<size_t>(buffers::editor::EditorOffsetUnit::UTF8_BYTES));
        auto* session = session_result.CastOwnerPtr<ScriptSession>();
        ASSERT_NE(session, nullptr);
        entry_id = dashql_script_session_get_catalog_entry_id(session);

        FFIResult replace_result;
        constexpr std::string_view text = "select 42";
        dashql_script_session_replace_text(&replace_result, session, 0, CopyText(text), text.size());
        ASSERT_NE(replace_result.data_ptr, nullptr);
        auto* update = flatbuffers::GetRoot<buffers::editor::EditorUpdate>(replace_result.data_ptr);
        EXPECT_EQ(update->status(), EditorUpdateStatus::OK);
        EXPECT_EQ(update->offset_unit(), buffers::editor::EditorOffsetUnit::UTF8_BYTES);
        EXPECT_EQ(update->text_version(), 1);
        dashql_delete_owner(replace_result.owner_ptr, replace_result.owner_deleter);

        flatbuffers::FlatBufferBuilder event_builder;
        auto insert = event_builder.CreateString("!");
        auto change = buffers::editor::CreateEditorTextChange(event_builder, 9, 9, insert);
        auto changes = event_builder.CreateVector(&change, 1);
        auto event = buffers::editor::CreateEditorEvent(event_builder, 1, changes);
        event_builder.Finish(event);

        FFIResult apply_result;
        dashql_script_session_apply(&apply_result, session, event_builder.GetBufferPointer(), event_builder.GetSize());
        update = flatbuffers::GetRoot<buffers::editor::EditorUpdate>(apply_result.data_ptr);
        EXPECT_EQ(update->status(), EditorUpdateStatus::OK);
        EXPECT_EQ(update->text_version(), 2);
        dashql_delete_owner(apply_result.owner_ptr, apply_result.owner_deleter);

        FFIResult text_result;
        dashql_script_session_get_text(&text_result, session);
        EXPECT_EQ(std::string_view(static_cast<const char*>(text_result.data_ptr), text_result.data_length),
                  "select 42!");
        dashql_delete_owner(text_result.owner_ptr, text_result.owner_deleter);

        FFIResult cursor_result;
        dashql_script_session_set_primary_cursor(&cursor_result, session, 2, 10);
        update = flatbuffers::GetRoot<buffers::editor::EditorUpdate>(cursor_result.data_ptr);
        EXPECT_EQ(update->status(), EditorUpdateStatus::OK);
        ASSERT_NE(update->primary_selection(), nullptr);
        EXPECT_EQ(update->primary_selection()->head(), 10);
        dashql_delete_owner(cursor_result.owner_ptr, cursor_result.owner_deleter);

        FFIResult analysis_result;
        dashql_script_session_analyze(&analysis_result, session);
        update = flatbuffers::GetRoot<buffers::editor::EditorUpdate>(analysis_result.data_ptr);
        EXPECT_EQ(update->status(), EditorUpdateStatus::OK);
        EXPECT_TRUE(update->analysis_available());
        ASSERT_NE(update->syntax_spans(), nullptr);
        EXPECT_FALSE(update->syntax_spans()->empty());
        ASSERT_NE(update->processing_statistics(), nullptr);
        EXPECT_GT(update->processing_statistics()->scanner_input_bytes(), 0u);
        EXPECT_FALSE(catalog.Contains(entry_id));
        dashql_delete_owner(analysis_result.owner_ptr, analysis_result.owner_deleter);

        dashql_delete_owner(session_result.owner_ptr, session_result.owner_deleter);
    }
    EXPECT_FALSE(catalog.Contains(entry_id));
    EXPECT_EQ(catalog.GetVersion(), initial_catalog_revision);

    FFIResult session_result;
    dashql_script_session_new(&session_result, &catalog,
                              static_cast<size_t>(buffers::editor::EditorOffsetUnit::UTF8_BYTES));
    dashql_script_session_destroy(session_result.CastOwnerPtr<ScriptSession>());
}

TEST(ScriptSessionTest, CompletionApiMatchesNormalScript) {
    constexpr std::string_view text = "select caf\xC3\xA9 from items";
    const size_t cursor_offset = text.size();

    Catalog script_catalog;
    Script script{script_catalog};
    script.ReplaceText(text);
    script.Analyze();
    script.MoveCursor(cursor_offset);

    Catalog session_catalog;
    FFIResult session_owner;
    dashql_script_session_new(&session_owner, &session_catalog,
                              static_cast<size_t>(buffers::editor::EditorOffsetUnit::UTF8_BYTES));
    auto* session = session_owner.CastOwnerPtr<ScriptSession>();

    FFIResult update_result;
    dashql_script_session_replace_text(&update_result, session, 0, CopyText(text), text.size());
    dashql_delete_owner(update_result.owner_ptr, update_result.owner_deleter);
    dashql_script_session_set_primary_cursor(&update_result, session, 1, cursor_offset);
    dashql_delete_owner(update_result.owner_ptr, update_result.owner_deleter);
    dashql_script_session_analyze(&update_result, session);
    dashql_delete_owner(update_result.owner_ptr, update_result.owner_deleter);

    FFIResult expected_result;
    FFIResult actual_result;
    dashql_script_complete_at_cursor(&expected_result, &script, 10, 0);
    dashql_script_session_complete_at_cursor(&actual_result, session, 10, 0);
    EXPECT_EQ(TakeBuffer(expected_result), TakeBuffer(actual_result));

    dashql_delete_owner(session_owner.owner_ptr, session_owner.owner_deleter);
}

TEST(ScriptSessionTest, CompatibilityQueryFormattingAndDiffApis) {
    Catalog catalog;
    FFIResult session_owner;
    dashql_script_session_new(&session_owner, &catalog,
                              static_cast<size_t>(buffers::editor::EditorOffsetUnit::UTF8_BYTES));
    auto* session = session_owner.CastOwnerPtr<ScriptSession>();

    constexpr std::string_view source_text = "select 1 as value";
    FFIResult update_result;
    dashql_script_session_replace_text(&update_result, session, 0, CopyText(source_text), source_text.size());
    dashql_delete_owner(update_result.owner_ptr, update_result.owner_deleter);
    dashql_script_session_analyze(&update_result, session);
    dashql_delete_owner(update_result.owner_ptr, update_result.owner_deleter);

    constexpr auto dialect = static_cast<size_t>(buffers::formatting::FormattingDialect::HYPER);
    constexpr auto mode = static_cast<size_t>(buffers::formatting::FormattingMode::INLINE);
    FFIResult compilation_result;
    dashql_script_session_compile_query(&compilation_result, session, dialect, mode, 80, 4, true, true);
    auto compilation = TakeBuffer(compilation_result);
    auto* compiled = ReadBuffer<buffers::execution::ScriptCompilationResult>(compilation);
    ASSERT_NE(compiled->sql(), nullptr);
    EXPECT_EQ(compiled->sql()->string_view(), source_text);
    ASSERT_NE(compiled->errors(), nullptr);
    EXPECT_TRUE(compiled->errors()->empty());

    EXPECT_EQ(dashql_script_session_is_fully_formattable(session, dialect, mode, 80, 4, false, true), 1);
    FFIResult formatted_result;
    dashql_script_session_format(&formatted_result, session, dialect, mode, 80, 4, false, 0, true, nullptr);
    auto* formatted = formatted_result.CastOwnerPtr<Script>();
    ASSERT_NE(formatted, nullptr);
    EXPECT_EQ(formatted->ToString(), "select 1 as value;");

    Script target{catalog};
    target.ReplaceText("select 2 as value");
    target.Parse();
    FFIResult diff_result;
    dashql_script_session_compute_diff(&diff_result, session, &target);
    auto diff = TakeBuffer(diff_result);
    auto* packed_diff = ReadBuffer<buffers::diff::ScriptDiff>(diff);
    ASSERT_NE(packed_diff->ops(), nullptr);
    ASSERT_EQ(packed_diff->ops()->size(), 1);
    EXPECT_EQ(packed_diff->ops()->Get(0)->code(), buffers::diff::ScriptDiffOpCode::UPDATE);

    dashql_delete_owner(formatted_result.owner_ptr, formatted_result.owner_deleter);
    dashql_delete_owner(session_owner.owner_ptr, session_owner.owner_deleter);
}

TEST(ScriptSessionTest, RewritesDashboardThroughParsedAst) {
    Catalog catalog;
    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
    constexpr std::string_view source =
        "select '\xF0\x9F\x93\x8A dashboard => (ignored)' as label "
        "visualize using table (dashboard => (row => 1, width => 4))";
    auto update = session.ReplaceText(0, source);
    ASSERT_EQ(update.status, EditorUpdateStatus::OK);

    EXPECT_EQ(session.RewriteDashboard(2, 5, 6, 4),
              "select '\xF0\x9F\x93\x8A dashboard => (ignored)' as label "
              "visualize using table (dashboard => (row => 2, column => 5, width => 6, height => 4))");
    EXPECT_EQ(session.RewriteDashboard(std::nullopt, std::nullopt, 6, 3),
              "select '\xF0\x9F\x93\x8A dashboard => (ignored)' as label "
              "visualize using table (dashboard => (width => 6, height => 3))");
}

TEST(ScriptSessionTest, InsertsDashboardIntoTerminalVisualization) {
    Catalog catalog;
    ScriptSession session{catalog};
    auto update = session.ReplaceText(0, "select 1 visualize using table ()");
    ASSERT_EQ(update.status, EditorUpdateStatus::OK);

    EXPECT_EQ(session.RewriteDashboard(0, 0, 6, 3),
              "select 1 visualize using table (dashboard => (row => 0, column => 0, width => 6, height => 3))");
}

TEST(ScriptSessionTest, CatalogLoadAndDropUseSessionOwnedScriptAndRank) {
    Catalog catalog;
    FFIResult session_owner;
    dashql_script_session_new(&session_owner, &catalog,
                              static_cast<size_t>(buffers::editor::EditorOffsetUnit::UTF8_BYTES));
    auto* session = session_owner.CastOwnerPtr<ScriptSession>();
    const auto entry_id = session->GetCatalogEntryId();

    constexpr std::string_view text = "create table items (id int)";
    FFIResult update_result;
    dashql_script_session_replace_text(&update_result, session, 0, CopyText(text), text.size());
    dashql_delete_owner(update_result.owner_ptr, update_result.owner_deleter);
    dashql_script_session_analyze(&update_result, session);
    dashql_delete_owner(update_result.owner_ptr, update_result.owner_deleter);

    dashql_script_session_load_into_catalog(session, 17);
    EXPECT_TRUE(catalog.Contains(entry_id));
    size_t entries = 0;
    catalog.IterateRanked([&](CatalogEntryID id, const CatalogEntry&, CatalogEntry::Rank rank) {
        ++entries;
        EXPECT_EQ(id, entry_id);
        EXPECT_EQ(rank, 17);
    });
    EXPECT_EQ(entries, 1);

    dashql_script_session_drop_from_catalog(session);
    EXPECT_FALSE(catalog.Contains(entry_id));

    dashql_script_session_load_into_catalog(session, 23);
    EXPECT_TRUE(catalog.Contains(entry_id));
    dashql_delete_owner(session_owner.owner_ptr, session_owner.owner_deleter);
    EXPECT_FALSE(catalog.Contains(entry_id));
}

}  // namespace
}  // namespace dashql
