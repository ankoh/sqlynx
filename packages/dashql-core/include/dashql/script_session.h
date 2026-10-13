#pragma once

#include <flatbuffers/flatbuffer_builder.h>

#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"

namespace dashql {

struct ScriptCompilationResult;

/// Owns the native state for one editor document. The borrowed catalog must outlive the session.
///
/// Portable offsets use the unit selected at construction. Script's rope edits use Unicode codepoint
/// offsets, so edit boundaries are validated and converted before a batch is committed atomically.
class ScriptSession {
   public:
    using EditorEvent = buffers::editor::EditorEventT;
    using EditorSelection = buffers::editor::EditorSelectionT;
    using EditorUpdate = buffers::editor::EditorUpdateT;

    /// Create an empty editable script backed by `catalog`, using `offset_unit` at every API boundary.
    explicit ScriptSession(Catalog& catalog,
                           buffers::editor::EditorOffsetUnit offset_unit =
                               buffers::editor::EditorOffsetUnit::UTF8_BYTES);
    /// Destroy the owned script state; the borrowed catalog remains owned by the caller.
    ~ScriptSession() = default;
    /// Sessions have stable script identity and therefore cannot be copied.
    ScriptSession(const ScriptSession&) = delete;
    /// Sessions have stable script identity and therefore cannot be copy-assigned.
    ScriptSession& operator=(const ScriptSession&) = delete;

    /// Return the catalog identity assigned to the session's owned script.
    CatalogEntryID GetCatalogEntryId() const { return script_.GetCatalogEntryId(); }
    /// Materialize and return the current script text.
    std::string GetText() { return script_.ToString(); }
    /// Return the owned script's version, incremented by each committed text change.
    TextVersion GetTextVersion() const { return script_.text_version; }
    /// Return the revision incremented by any committed text or selection-state change.
    uint64_t GetStateRevision() const { return state_revision_; }
    /// Return the current version of the catalog used to analyze this script.
    uint64_t GetCatalogRevision() const { return catalog_.GetVersion(); }
    /// Return the portable offset representation selected when the session was created.
    buffers::editor::EditorOffsetUnit GetOffsetUnit() const { return offset_unit_; }
    /// Return the current primary editor selection, if the host has supplied one.
    const std::optional<EditorSelection>& GetPrimarySelection() const { return primary_selection_; }
    /// Provide mutable access to the owned script for core workflows such as compilation and execution.
    Script& GetScript() { return script_; }
    /// Provide read-only access to the owned script without materializing its text.
    const Script& GetScript() const { return script_; }

    /// Atomically replace all text when `expected_text_version` still matches the script.
    EditorUpdate ReplaceText(TextVersion expected_text_version, std::string_view text);
    /// Validate and atomically apply one editor event, returning a projection of the resulting state.
    EditorUpdate Apply(const EditorEvent& event);
    /// Move the primary cursor without changing text when the expected text version matches.
    EditorUpdate SetPrimaryCursor(TextVersion expected_text_version, uint64_t offset);
    /// Bring parsing and analysis up to date with both the document and catalog, then project an update.
    EditorUpdate Analyze();
    /// Compute completion candidates and pack them for embedding in the caller's active builder.
    flatbuffers::Offset<buffers::completion::Completion> PackCompletion(flatbuffers::FlatBufferBuilder& builder,
                                                                          size_t limit,
                                                                          buffers::formatting::KeywordCase keyword_case);
    /// Compile the current revision into a native executable statement plan.
    ScriptCompilationResult CompileQuery(const buffers::formatting::FormattingConfigT& config,
                                         bool allow_extensions, bool parse_if_outdated);
    /// Format the current script into a new independent Script associated with the selected catalog.
    std::unique_ptr<Script> Format(const buffers::formatting::FormattingConfigT& config, bool parse_if_outdated,
                                   Catalog* catalog = nullptr);
    /// Return source with the terminal VISUALIZE statement's dashboard clause rewritten.
    std::string RewriteDashboard(std::optional<int32_t> row, std::optional<int32_t> column, int32_t width,
                                 int32_t height, bool parse_if_outdated = true);
    /// Return whether formatting can represent every parsed node without placeholders.
    bool IsFullyFormattable(const buffers::formatting::FormattingConfigT& config, bool parse_if_outdated);
    /// Compute and pack a statement-level semantic diff for embedding in the caller's active builder.
    flatbuffers::Offset<buffers::diff::ScriptDiff> PackDiff(flatbuffers::FlatBufferBuilder& builder, Script& target);
    /// Publish the session's analyzed script into its catalog at the supplied ordering rank.
    void LoadIntoCatalog(CatalogEntry::Rank rank);
    /// Remove the session's currently published script definition from its catalog.
    void DropFromCatalog();

   private:
    Catalog& catalog_;
    Script script_;
    const buffers::editor::EditorOffsetUnit offset_unit_;
    uint64_t state_revision_ = 0;
    TextVersion analyzed_text_version_ = std::numeric_limits<TextVersion>::max();
    uint64_t analyzed_catalog_revision_ = std::numeric_limits<uint64_t>::max();
    TextVersion cursor_text_version_ = std::numeric_limits<TextVersion>::max();
    uint64_t cursor_catalog_revision_ = std::numeric_limits<uint64_t>::max();
    std::optional<EditorSelection> primary_selection_;

    /// Build the revision and selection portion of an update before expensive editor projections are added.
    EditorUpdate MakeUpdate(buffers::editor::EditorUpdateStatus status = buffers::editor::EditorUpdateStatus::OK,
                             std::string_view message = {});
    /// Add syntax, semantic, diagnostic, annotation, and statistics projections to an update when available.
    EditorUpdate FinalizeUpdate(EditorUpdate update);
    /// Validate a portable offset and resolve it to byte, codepoint, and UTF-16 coordinates in `text`.
    std::optional<rope::Rope::TextPosition> ResolveOffset(const rope::Rope& text, uint64_t offset) const;
    /// Convert an internal UTF-8 byte offset to the session's portable unit, returning null at invalid boundaries.
    std::optional<uint64_t> TryProjectByteOffset(uint64_t offset) const;
    /// Convert an internal byte offset to the portable unit or throw if core state contains an invalid boundary.
    uint64_t ProjectByteOffset(uint64_t offset) const;
    /// Convert an internal UTF-8 text span to the session's portable offset representation.
    std::unique_ptr<buffers::editor::EditorTextSpan> ProjectTextSpan(buffers::parser::TextSpan span) const;
    /// Populate all editor-facing projections that depend on a current analyzed script.
    void ProjectEditorState(EditorUpdate& update);
    /// Check both session bookkeeping and the script's actual analyzed snapshot.
    bool IsAnalysisCurrent() const;
    /// Refresh analysis when its text version or catalog revision is stale and record the outcome in `update`.
    bool Analyze(EditorUpdate& update);
};

}  // namespace dashql
