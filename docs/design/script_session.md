# Native Editor Session

`dashql::editor::ScriptSession` is the native owner of one editable `Script`. It borrows a `Catalog`,
which must outlive the session. Synchronous analysis reads that catalog. The session can explicitly load
its owned script into the catalog with an application-defined rank and drop it again; destruction also
drops it through the normal `Script` lifecycle.

Editor-facing analysis is returned as portable `EditorUpdate` data. Operations with inherently structured
results still return detached FlatBuffers for completion, query compilation, and semantic diffs. Formatting
returns a separately owned normal `Script`; parsed and analyzed snapshots remain available only on that
explicit `Script` API, not on `ScriptSession`.

## Portable Projection

When `analysis_available` is true, every `EditorUpdate` contains a complete plain-data projection of the
current analyzed `Script`. Native and mobile editor clients can therefore render CodeMirror-equivalent
state without exposing parsed, analyzed, or cursor FlatBuffers to React:

- Diagnostics combine scanner, parser, and analyzer messages with source, severity, and text spans in the
  session's selected offset unit.
- Syntax spans carry the scanner token class and a span in the selected offset unit. Scanner trivia is merged into this list
  as `COMMENT` spans, matching the existing editor highlighter.
- Semantic spans identify table and column references, their analyzer reference id, resolved state,
  span, and catalog ids when resolution produced them.
- The optional primary cursor context identifies the table or column reference under a collapsed primary
  selection, its resolved catalog target, and related table and column reference ids in the same script.
- The optional primary cursor state carries the selected-unit text offset and scanner-relative facts needed for
  completion triggers without exposing the internal `ScriptCursor` model.
- Script annotations summarize analyzed table definitions, referenced table names, and whether visualization
  compilation data is present.
- Processing statistics copy scanner, parser, and analyzer timings and memory counters into scalar fields.

These collections are full snapshots rather than deltas. They are empty or absent when analysis is not
current for the text version and catalog revision. `analysis_updated` remains the change flag indicating that
the operation reran analysis; consumers do not need it to merge projection data.

The session does not expose parsed, analyzed, cursor, or statistics snapshots. Consumers retrieve the
individual editor-facing facts from `EditorUpdate`; workflows that deliberately need the complete internal
models create a separate normal `Script`. The portable fields intentionally duplicate only editor-facing
data and do not contain nested `ParsedScript`, `AnalyzedScript`, or `ScriptCursor` objects.

Portable text inputs passed to the C ABI are copied into session-owned state before the call returns.
`dashql_script_session_replace_text` consumes its `dashql_malloc` text buffer, matching the existing
normal `Script` text APIs. `dashql_script_session_apply` only borrows its serialized event buffer for
the duration of the call and unpacks all strings before returning.

## Offset Unit

An `ScriptSession` selects either UTF-8 bytes or UTF-16 code units at construction. Every portable
`EditorEvent`, `EditorUpdate`, completion result, and session-owned diff uses that unit for the lifetime
of the session. The rope's mutation API uses Unicode codepoint offsets, so `ScriptSession` resolves and
validates selected-unit boundaries before applying the complete batch atomically. Invalid UTF-8,
split-codepoint or split-surrogate ranges, overlapping ranges, and stale text versions leave the
document unchanged. Web sessions select UTF-16 so CodeMirror can consume native projections directly;
native clients may retain UTF-8.

## Revisions

- `text_version` is the owned `Script`'s unsigned 64-bit text mutation counter, exposed as `bigint` in
  TypeScript. The session has no independent document revision counter.
- `state_revision` increments once when an accepted operation changes text or selection, or refreshes analysis.
- `catalog_revision` is the borrowed catalog's current revision and can also change outside the session.

Every `EditorEvent` carries `expected_text_version`. A mismatch returns
`STALE_TEXT_VERSION` without changing text, selection, analysis, or revisions. All edits in one
event address the same pre-change document; the optional primary selection addresses the resulting
document.
