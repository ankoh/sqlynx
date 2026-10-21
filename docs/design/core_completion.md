# Core Completion

The completion system provides context-aware suggestions as the user types SQL in the editor.
It spans two layers: a Rust core that computes and scores candidates, and a TypeScript frontend that renders inline hints and handles keyboard interaction.
The core is `packages/dashql-core/src/completion.rs` and `cursor.rs`, with the LR probes in `packages/dashql-parser/src/parser/probe.rs`.
It was ported from C++; the names below are those of the C++ original, the Rust functions are their snake_case equivalents (`Completion::compute`, `parse_until_with_snapshot`, ...).

## Compute pipeline summary

```
Completion::Compute(cursor, k)
│
├─ Validate cursor has scanner location
├─ Select target symbol (current vs. previous)
├─ Detect dot-completion context
├─ Skip non-completable symbols (constants, operators, punctuation)
├─ Parser::ParseUntilWithSnapshot() → expected symbols + LALR state snapshot
├─ Detect definition position (AST attribute keys)
│
├─ [dot-completion]
│  └─ FindCandidatesForNamePath()
│
├─ [between symbols — passive hints]
│  ├─ Check suppressPassiveHint() → return empty if suppressed
│  └─ AddExpectedKeywordsAsCandidates(prefix snapshot) (keywords only)
│
├─ [normal completion]
│  ├─ AddExpectedKeywordsAsCandidates(prefix snapshot)
│  │   └─ ProbeSuffixBatchFromSnapshot() — replay suffix per candidate (mid-statement only)
│  ├─ Insert identity candidate (score varies by context)
│  └─ FindCandidatesInIndexes()   (if expects_identifier && !at_definition)
│     └─ PromoteTablesAndPeersForUnresolvedColumns()
│
├─ PromoteIdentifiersInScope()
├─ SelectTopCandidates()          → top-k heap
├─ QualifyTopCandidates()         → derive qualified names
│
├─ DeriveKeywordContinuationsForTopCandidates(prefix snapshot)
│   └─ ProbeSuffixSequenceFromSnapshot() — keep continuation if suffix still parses (mid-statement)
│
└─ Pack() → FlatBuffer result to frontend
```

The sections below walk through each stage of this pipeline.

## Cursor interaction

### ScriptCursor

The `ScriptCursor` is the bridge between the editor and the completion engine.
It encodes:

- **text_offset** — the byte position of the cursor in the script text.
- **scanner_location** — resolved to the current and previous scanner symbols, including the cursor's relative position within a symbol (begin, mid, end, before, after).
- **context** — a variant of `TableRefContext`, `ColumnRefContext`, or `monostate`, determined by the AST node the cursor sits inside.
- **statement_id / ast_node_id / ast_path_to_root** — structural position in the AST.
- **name_scopes** — the stack of naming scopes reachable from the cursor, innermost first.

### Target symbol selection

The completion engine picks a *target symbol* — the symbol whose text the user is currently typing:

1. If the cursor is **inside** a symbol, that symbol is the target.
2. If the cursor is **between** two symbols (e.g. right after a comma), it checks whether the previous symbol ends exactly at the cursor. If so, the previous symbol becomes the target.
3. Constants, operators, and punctuation are never completed — if the cursor lands on one, the engine falls back to the previous symbol or returns empty.

### Dot detection

Dot-completion activates when:
- The current symbol is a `.` (inner dot) and the cursor is at or past its end.
- The current symbol is a trailing dot (dot followed by whitespace).
- The previous symbol is an inner dot and the current symbol is an identifier the parser expects.

When dot-completion is active, the engine restricts candidates to those reachable through the qualified name path.

### Name path reading

`ScriptCursor::ReadCursorNamePath` reads the sequence of name components around the cursor (e.g. `schema.table.col`).
Each component is classified as `Name`, `Star`, `TrailingDot`, or `Index`.
The engine determines how many components are *sealed* (fully typed, before a dot) and uses the sealed prefix to resolve the dot context.

## Completion strategies

The cursor's AST context determines the active strategy:

| Strategy          | When                                          | Effect on scoring                        |
|-------------------|-----------------------------------------------|------------------------------------------|
| `DEFAULT`         | No special context                            | All name types equally likely (base 20)  |
| `TABLE_REF`       | Cursor is inside a table reference            | Tables/schemas boosted, columns demoted  |
| `TABLE_REF_ALIAS` | Cursor is at a table alias position           | Skips name-index search entirely         |
| `COLUMN_REF`      | Cursor is inside a column reference           | Columns/aliases boosted, tables demoted  |

## Expected symbols (ParseUntilWithSnapshot)

Expected grammar symbols at the cursor position are extracted by `Parser::ParseUntilWithSnapshot`, which runs the parser up to the cursor's symbol and collects all valid next tokens via Bison's LAC (look-ahead correction).
The same call also returns a `PrefixSnapshot` of the LALR state stack (state numbers only — reduction actions are no-ops in this skeleton, so semantic values aren't needed); the suffix probe reuses that snapshot to avoid re-parsing the prefix.
Keywords bypass the candidate registration and enter the result heap directly.
They receive a +20 keyword-substring bonus when both `EXPECTED_PARSER_SYMBOL` and `SUBSTRING_MATCH` are set on the candidate, plus a prevalence modifier for common keywords (e.g. `SELECT` +4, `AS` +2).

### Suffix probe

LAC is one-sided: it tells you what tokens the grammar would accept at the cursor, but it ignores everything after the cursor.
This is fine at the write front (no post-cursor stream) but produces noisy mid-statement suggestions: a keyword like `FROM` is "expected" after `select * | , b from tbl`, but actually inserting it would yield `select * FROM , b from tbl` — broken.

`Parser::ProbeSuffixBatchFromSnapshot(scanned, feed_id, prefix, candidates, replace_target)` complements LAC for keyword scoring.
For each candidate keyword `K`, it restores the prefix snapshot into a fresh parser, feeds `K` (either replacing the typed token or inserting before the next real token, depending on cursor relative position), and continues consuming real post-cursor tokens until shift fails or accept happens.
The result captures three signals:

- `k1_compatible` — the next real post-cursor token shifts cleanly after `K`.
- `depth_consumed` — how many real post-cursor tokens were shifted before erroring.
- `reached_eof` — parsing accepted the suffix.

The completion engine threads these into scoring via three `CandidateTag` flags: `SUFFIX_INCOMPATIBLE` (penalty), `SUFFIX_DEPTH_ONE` / `SUFFIX_DEPTH_MANY` (small positive bonuses).
See [core_completion_ranking.md](core_completion_ranking.md) for the magnitudes.

The probe is skipped when there is no real post-cursor token (cursor at EOF, or only the synthetic EOF token follows), and only applied to keyword candidates — identifier candidates from the name index are not probed.

`Completion::has_post_cursor_token` (computed by `computeHasPostCursorToken`, using the same feed-point / replace-vs-insert logic) records whether a real token follows the cursor. It gates the batch probe above and — via the sequence probe below — the suffix-aware filtering of keyword continuations.

#### Sequence probe (continuations)

`ProbeSuffixBatchFromSnapshot` feeds a *single* symbol. Keyword continuations need to feed *two* symbols — the candidate keyword followed by its continuation (e.g. `group` + `by`) — before letting the real suffix flow, because the continuation is what actually gets inserted. `Parser::ProbeSuffixSequenceFromSnapshot(scanned, feed_id, prefix, feed_symbols, replace_target)` generalizes the probe to a feed *sequence*: in replace mode only the first fed symbol stands in for the typed token, and every symbol after it is an insertion (the scanner rewinds so no real token is consumed); the `SuffixProbe` signals then describe only the real suffix shifted *after* the whole fed sequence.

This lets continuation derivation stay suffix-aware rather than blanket-gated. At the write front every continuation is kept; mid-statement, a continuation is kept only if feeding `[candidate, continuation]` leaves the actual post-cursor stream parseable (`k1_compatible || reached_eof`). So `select a from tbl gro| a` keeps `group by` (the bare `group` candidate may itself be `SUFFIX_INCOMPATIBLE`, but `group by a` parses cleanly), while `select bar as ba| from foo` drops the `into` continuation (`background into from` is broken) and `select a from tbl gro| where b = 1` drops `by` (`group by where` can't parse).

## Candidate sources

### Candidate types

Each candidate carries a coarse type used for visual identification:

| Type       | Symbol | Description                                      |
|------------|--------|--------------------------------------------------|
| KEYWORD    | SQL    | SQL keyword from the grammar                     |
| DATABASE   | DB     | Database name                                    |
| SCHEMA     | NS     | Schema name                                      |
| TABLE      | TBL    | Table name                                       |
| COLUMN     | COL    | Column name                                      |
| FUNCTION   | FN     | Function name                                    |
| IDENTITY   | ID     | Identity candidate (matches what the user typed) |

### Name-index candidates

Identifiers (tables, columns, functions, schemas, databases) come from the `NameSearchIndex`, a suffix-indexed btree over all registered names in the catalog.
The search walks the index with a case-insensitive prefix of the text under the cursor.
These candidates receive a base score from the strategy-specific scoring table.

### Semantic scope candidates

CTEs and script-local relations are not catalog objects, so completion also enumerates them directly
from the cursor's name scopes. In table-reference contexts, visible CTEs and preceding top-level
CTE relations are added as local table candidates. In column-reference contexts, output
columns from CTE-backed sources in `FROM` are added as local column candidates. These candidates
carry `IN_NAME_SCOPE` without requiring synthetic catalog object IDs.

Non-recursive CTE completion follows declaration order: a CTE suggests earlier siblings but not itself
or later siblings. Recursive CTEs also suggest themselves. Script-local relations are visible only to
later statements.

### Keyword candidates

Keywords enter the candidate set via `AddExpectedKeywordsAsCandidates()`.
They are extracted from the parser state and get a +20 keyword-substring bonus (in `computeCandidateScore`) when both `EXPECTED_PARSER_SYMBOL` and `SUBSTRING_MATCH` are set, plus prevalence modifiers for common keywords.

## Dot-completion resolution

Given a name path like `a.b._`, the resolution depends on the strategy:

**TABLE_REF context:**
- 1 sealed name (`a._`): resolves `a` as either a schema name (yielding tables) or a database name (yielding schemas).
- 2 sealed names (`a.b._`): resolves `a` as database, `b` as schema, yielding tables.

**COLUMN_REF context:**
- 1 sealed name (`a._`): resolves `a` as a table alias in the current naming scope, yielding its columns.
- 2 sealed names (`a.b._`): resolves `a.b` as a qualified table, yielding columns.

The one-name alias case supports both catalog tables and CTE-backed relations, including script-local
relations. CTE column lists such as `WITH t(a, b) AS (...)` override the source query's output names.

The cursor text after the last dot acts as a prefix filter on the resolved candidates.

## Passive inline hints

When the cursor is positioned *between* symbols (whitespace after a token), the completion engine produces **passive hints** — lightweight, single-keyword suggestions shown as ghost text without requiring any user typing.

### Triggering

Passive hints activate when `scanner_location.current.relative_pos == AFTER_SYMBOL` (cursor is in whitespace after a token), or at the very beginning of a statement with no previous symbol.

### Suppression

Certain tokens suppress passive hints entirely because the user is about to type an identifier or expression, not a keyword:

| Token | Reason |
|-------|--------|
| `SELECT` | User will type column expressions |
| `FROM` | User will type a table name |
| `JOIN` | User will type a table name |
| `WHERE` | User will type a filter expression |
| `ON` | User will type a join condition |
| `AND` | User will type an expression |
| `OR` | User will type an expression |
| `BY` | User will type a column reference |
| `VISUALISE` / `VISUALIZE` | In the trailing `source VISUALIZE` form, passive hints remain suppressed; explicit completion can offer `USING` |

When the previous token is in this list, no passive hint is shown.
This is the sole mechanism for controlling passive hint visibility — keyword prevalence scoring naturally ensures that high-value keywords (FROM, WHERE, etc.) outrank noise when hints are not suppressed.

### Visual behavior

Passive hints suppress the control widgets (Tab/Enter key icons) — they appear as faint ghost text only.
Accepting a passive hint is not interactive; the user simply starts typing the suggested keyword or ignores it.

## Promotion passes

After initial candidate collection, two promotion passes tag candidates with additional context:

1. **PromoteTablesAndPeersForUnresolvedColumns** — If the current statement has unresolved column references, tables containing those columns get `RESOLVING_TABLE` (+5). Sibling columns of unresolved ones get `UNRESOLVED_PEER` (+1).

2. **PromoteIdentifiersInScope** — Walks the cursor's naming scopes (innermost first) and tags reachable candidates with `IN_NAME_SCOPE` (+10).

## Scoring and ranking

See [core_completion_ranking.md](core_completion_ranking.md) for the full scoring system.

In brief: each candidate accumulates `CandidateTag` flags during collection and promotion passes.
The final score is `base_score + sum(tag_modifiers)`.
Ties are broken lexicographically (case-insensitive, smaller name wins).

## Top-k selection and qualification

`SelectTopCandidates()` extracts the top-k candidates from the scored heap.
`QualifyTopCandidates()` derives qualified names for the winners (e.g. `schema.table` instead of just `table`) when the catalog object prefers qualification.

## Keyword continuations

When a keyword candidate is selected, the engine computes a *continuation* — the most likely keyword that follows it.
For example, `group` gets continuation `by`, `order` gets `by`, `inner` gets `join`.

`DeriveKeywordContinuationsForTopCandidates` runs `Parser::ParseUntilAfter` to simulate feeding the candidate keyword and inspecting what the grammar expects next.
The `find_continuation` heuristic picks a continuation when:
- Exactly one keyword/operator is expected after the feed, OR
- One keyword has a uniquely highest `getKeywordContinuationScore` (a hardcoded priority for keywords like BY, AS, ON, TABLE, SET).

When many unreserved keywords are expected (because IDENT is valid and all unreserved keywords can serve as identifiers), the continuation score disambiguates: only a keyword with a uniquely highest score is selected. Keywords that follow their predecessor in nearly all contexts (such as BY after GROUP/ORDER) have score 10; context-specific continuations (ASC, DESC, NULLS, etc.) have score 6; everything else has 0. After the trailing `VISUALISE` token, `USING` is selected because it is the grammar's sole keyword continuation, not because it has a special score. Completion does not expose standalone or prefix `VISUALIZE` forms.

Identifier candidates also receive a continuation: the engine feeds `IDENT` once and finds the best keyword continuation for the generic identifier case (e.g. identifiers in CTE position get `as`).

A chosen continuation is then validated against the post-cursor stream. At the write front it is always kept; mid-statement, `DeriveKeywordContinuationsForTopCandidates` runs the [sequence probe](#sequence-probe-continuations) on `[candidate, continuation]` and keeps the continuation only if the real suffix still parses. This drops continuations that would collide with trailing text (e.g. `into` before `from`, or a `by` that a reserved `where` follows) while keeping valid mid-statement ones. Note the probe uses the parser's k=1 test, so an unreserved keyword that follows (e.g. a column literally named `by`) leaves the continuation compatible.

The frontend renders the continuation as additional ghost text after the candidate insertion (e.g. typing `gro` shows `group by` as the inline hint).

## Multi-step completion

A completion can progress through candidate selection and catalog-object qualification, each activated by a keypress.

### Completion status progression

```
AVAILABLE → SELECTED_CANDIDATE → SELECTED_CATALOG_OBJECT
```

### Step 1: Candidate selection (Tab)

The user sees inline hints showing the top candidate's text diff.
Pressing **Tab** applies the candidate patch — replacing the target text with the candidate's completion text.
The status advances to `SELECTED_CANDIDATE`.

### Step 2: Catalog object qualification (Tab)

If the selected candidate has multiple catalog objects (e.g. a column name that exists in multiple tables), the user can cycle through them with **Left/Right arrows** while in `AVAILABLE` status.

After accepting a candidate, if the winning catalog object prefers qualification (e.g. `schema.table` instead of just `table`), **Tab** applies the qualification patch — inserting the prefix/suffix around the already-inserted name.
The status advances to `SELECTED_CATALOG_OBJECT`.

### Keyboard bindings

| Key        | AVAILABLE state                | SELECTED_CANDIDATE          | SELECTED_CATALOG_OBJECT     |
|------------|-------------------------------|-----------------------------|-----------------------------|
| Enter      | Insert newline                 | Insert newline              | Insert newline              |
| Tab        | Accept candidate (+ continue) | Apply qualification         | —                           |
| Arrow Up   | Previous candidate            | —                           | —                           |
| Arrow Down | Next candidate                | —                           | —                           |
| Arrow Left | Previous catalog object       | —                           | —                           |
| Arrow Right| Next catalog object           | —                           | —                           |
| Escape     | Dismiss completion            | —                           | —                           |

### Visual hints

The editor renders inline decorations for pending patches:
- **Candidate hints** — ghost text showing what Tab will insert or delete.
- **Catalog object hints** — ghost text showing the qualification prefix/suffix that the next Tab will add.

At a zero-length completion target, the editor and shell show only the best candidate as an inline hint. The candidate list appears after the user enters the first character of the prefix.

Each hint category has a distinct visual style (color-coded CSS classes) and a key icon widget indicating which key activates it.

## SelectCandidate / SelectQualifiedCandidate

After the user accepts a candidate, the frontend calls back into the core via `SelectCandidate`.
This re-resolves the cursor's name path at the new text state to produce updated target locations for qualification.
If the user accepted a specific catalog object (e.g. picked a particular table for an ambiguous column), `SelectQualifiedCandidate` narrows the result to that single object.

## Frontend rendering

The TypeScript layer is split into four CodeMirror plugins:

| Plugin                         | Role                                                        |
|--------------------------------|-------------------------------------------------------------|
| `DashQLProcessorPlugin`        | State field holding completion buffer, cursor, patch state  |
| `DashQLCompletionHintPlugin`   | Renders inline ghost-text decorations from computed patches |
| `DashQLCompletionListPlugin`   | Virtualized dropdown list of candidates (no React)          |
| `DashQLCompletionListenerPlugin` | Keyboard bindings and scroll/abort handling               |

### Patch computation

`computePatches` derives text operations (insert/delete) from the FlatBuffer completion result:
- `candidatePatch` — diff between current text at target location and the candidate's completion text.
- `catalogObjectPatch` — diff for the qualification prefix/suffix.

The `completionDiff(at, have, want)` function produces minimal patches: if `have` is a substring of `want`, it emits targeted inserts before/after; otherwise it emits a delete + insert.
