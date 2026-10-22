# Lazy Session Script Analysis

## Context

Session loading currently analyzes every restored session script eagerly. This behavior was added
when analyzed scripts were registered in the core script registry so completion could use collected
restrictions and constant expressions. The script registry has since been removed, so eagerly
analyzing every session script during startup is no longer necessary.

Ordinary session scripts should instead remain unanalyzed after restoration and be analyzed lazily
when an operation needs analysis. The exception is the connection-owned catalog scripts:

- `dashql-catalog-relations.sql`
- `dashql-catalog-functions.sql`

These schema scripts define the catalog used by session scripts and must still be analyzed and
loaded when the session opens. Ordinary session entries containing DDL are not schema scripts for
the purpose of this change and should remain lazy.

## Current Behavior

Opening a session currently performs these phases:

1. Restore the connection.
2. Restore, analyze, and load the catalog relation and function scripts.
3. Restore ordinary session scripts and the draft as outdated scripts.
4. Run `analyzeAllScripts` across every restored session script.

The fourth phase populates analysis buffers and derived annotations before the user interacts with a
script. It also adds an `Analyze Scripts` phase to application loading progress.

Native file reconciliation has similar eager behavior. Any session-content or catalog change marks
all scripts outdated and immediately calls `analyzeAllScripts`.

## Desired Behavior

When a session opens:

- Analyze and load `dashql-catalog-relations.sql` and `dashql-catalog-functions.sql` eagerly.
- Restore ordinary session scripts and the draft with `outdated: true` and null analysis buffers.
- Do not analyze ordinary scripts until an explicit operation needs their analysis.
- Do not trigger hidden analysis from passive rendering or cache-status checks.

The same policy applies to sessions restored incrementally through `restoreSingleSession` and to
scripts changed through native file synchronization.

## Implementation Plan

### 1. Remove Eager Session Analysis During Restoration

Update `packages/dashql-app/src/app/session/persistence/app_state_loader.ts`:

- Remove Phase 4 and its call to `analyzeAllScripts`.
- Register restored session scripts immediately after reconstruction.
- Keep restored ordinary scripts and the draft outdated with null analysis buffers.
- Preserve the existing eager analysis and catalog loading of `catalogRelationScript` and
  `catalogFunctionScript`.
- Apply the same behavior to `restoreSingleSession`, which uses the shared restoration path.
- Update comments that currently state restored scripts are analyzed and registered during Phase 4.

### 2. Define Explicit Lazy Analysis Boundaries

Keep `ANALYZE_OUTDATED_SCRIPT` as the state transition that synchronizes a script's core analysis,
application analysis buffers, derived annotations, and catalog entry.

Ensure an outdated script is analyzed before operations that require those results:

- Mounting the editable script editor. This boundary already exists in `script_editor.tsx`.
- Executing or rerunning a script.
- Opening diagnostics or details that consume parsed or analyzed buffers.
- Any explicit request for visualization metadata.

Execution must not rely only on `compileQuery`. The core compiler can parse lazily and analyze a
`VISUALIZE` statement internally, but that does not update the React session state, derived
annotations, visualization projection, or catalog invalidation state.

Use one shared analysis-before-use path where possible so execute, rerun, and details flows do
not implement subtly different behavior.

### 3. Avoid Analysis From Passive Rendering

`SessionFeedRow` currently compiles every visible script to compute its query cache key. Core
compilation can analyze a `VISUALIZE` script internally, which would make merely rendering the feed
perform hidden analysis outside session state management.

Change the cache-status effect to avoid compiling an outdated script. An unanalyzed row can render
without a cache indicator or visualization classification until an explicit action analyzes it.

Other passive consumers, such as file-tree visualization icons, should tolerate absent annotations
without forcing analysis.

### 4. Make Native Reload Invalidate Lazily

Update `replaceSessionScriptsFromStorage` in
`packages/dashql-app/src/app/session/scripts/session_scripts.ts`:

- Preserve valid analysis for unchanged scripts when neither their content nor the catalog changed.
- Mark changed and newly added scripts outdated.
- When a catalog change can affect cross-script resolution, mark ordinary scripts outdated but do not
  analyze them immediately.
- Remove the full-session `analyzeAllScripts` call.
- Continue detaching and destroying removed scripts safely.

Update `docs/design/native_file_sync.md` to state that session or catalog changes invalidate
affected analysis and that scripts are reanalyzed on demand.

### 5. Remove Obsolete Bulk-Analysis Infrastructure

After all call sites have migrated:

- Remove `analyzeAllScripts`.
- Remove `AnalyzeAllScriptsProgress`.
- Remove `getScriptKeysInFeedOrder` if it has no remaining purpose.
- Remove the `analyzeScripts` application-loading progress counter.
- Remove the `Analyze Scripts` row from the loading page.
- Update stale comments describing eager startup analysis.

Analysis performed in response to direct edits, renames, or newly created
scripts should remain eager where it is required to keep the edited script and its catalog entry
coherent. This change targets bulk analysis during restoration and reconciliation, not all analysis
following user mutations.

## Correctness Considerations

### Visualization Execution

The first execution of a restored `VISUALIZE` script must still:

- Send the resolved source SQL rather than raw `VISUALIZE` syntax to the backend.
- Populate `annotations.visualizeQuery` in session state.
- Apply the correct visualization projection, including UMAP projection.
- Leave the script marked up to date after analysis.

The core compiler's lazy `VISUALIZE` analysis remains a safety net, but application execution should
first synchronize analysis through session state.

### Catalog Dependencies

The relation and function catalog scripts must be analyzed before ordinary scripts are available for
lazy analysis. A catalog update must invalidate ordinary scripts so their next analysis resolves
against the new catalog.

### Analysis Failures

An ordinary script analysis failure must not prevent session restoration. The session should open
with that script outdated, and the failure should surface when an operation requests its analysis.
Catalog-script restoration remains non-critical and should retain the existing failure handling.

## Test Plan

### Restoration

Update `app_state_loader.test.ts` to verify:

- Catalog relation and function scripts are analyzed during restoration.
- Ordinary restored scripts remain outdated with null analyzed buffers.
- The restored draft remains outdated and unanalyzed.
- A script that would fail analysis does not fail session restoration because no ordinary script is
  analyzed at load time.
- `restoreSingleSession` follows the same policy.
- Loading progress no longer reports an ordinary-script analysis phase.

### Lazy Analysis

Update `session_scripts.test.ts` and relevant UI tests to verify:

- Opening an editor analyzes only the displayed outdated script.
- Executing an outdated plain SQL script analyzes it before execution.
- Executing an outdated `VISUALIZE` script derives visualization metadata and projection before
  execution.
- Rerun paths use the same behavior.
- Passive feed rendering and cache checks do not analyze outdated scripts.

### Native Synchronization

Verify that:

- Unchanged scripts retain valid analysis when possible.
- Changed and added scripts become outdated without immediate analysis.
- Catalog changes invalidate ordinary scripts without bulk analysis.
- Removed scripts are still detached and destroyed correctly.

## Verification

All build and test verification must run through Bazel:

```bash
bazel test //packages/dashql-app:test_chromium //packages/dashql-app:test_firefox
bazel test //packages/dashql-app:tsc_typecheck_test
bazel test //packages/dashql-app:tsc_transitive_typecheck_test
```

## Completion Criteria

The change is complete when opening a session analyzes only its relation and function catalog
scripts, ordinary scripts remain lazy until an analysis-dependent operation requests them, native
reload no longer bulk-analyzes session scripts, and all lazy execution and visualization regression
tests pass.
