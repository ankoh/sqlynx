# Standalone Shell Format Command

## Goal

Add a `.format` command to the standalone shell. Running the command opens a large overlay card for editing and formatting SQL.

The card contains:

- A `SQL Formatter` header.
- A close button on the right.
- A `Raw / Compact / Pretty` segmented control immediately left of the close button.
- A warning or error indicator immediately left of the segmented control when parsing or formatting fails.
- A CodeMirror editor with an empty Raw input state.

## Behavior

The format modes are reversible views:

- `Raw` is the editable source of truth.
- `Compact` and `Pretty` are read-only views derived from the latest Raw SQL.
- Returning to `Raw` restores the exact latest user-authored SQL.
- Editing Raw invalidates previously derived formatting output.
- Selecting `Compact` or `Pretty` parses and formats the current Raw SQL.
- Compact formatting uses the existing width-sensitive compact configuration.
- Pretty formatting uses the existing Hyper defaults of width 80 and indentation 4.

If parsing or formatting fails:

- Keep or return the selected mode to `Raw`.
- Disable `Compact` and `Pretty`.
- Show a warning or error indicator left of the segmented control.
- Expose the diagnostic as accessible text or an accessible tooltip/status.
- Re-enable both derived modes when subsequent Raw edits become valid.
- Treat an empty editor as a valid Raw state without an error.

Closing the card discards its contents. Clicking outside the card does not close it, avoiding accidental loss of pasted or edited SQL.

## Implementation Plan

### 1. Register the command

Add `packages/dashql-app/src/shell/commands/format.ts`.

- Register the command under the name `format`, without the leading dot.
- Reject arguments with `usage: .format`.
- Open the format dialog through a promise-based controller, following the existing `.login` command pattern.
- Resolve without terminal output when the dialog closes or the shell operation is aborted.
- Register the command in `ShellPage` so it appears automatically in `.help` and command completion.

No changes to the Rust shell are required because standalone shell commands are registered dynamically in TypeScript.

### 2. Build the dialog

Add:

- `packages/dashql-app/src/shell/format_dialog.tsx`
- `packages/dashql-app/src/shell/format_dialog.module.css`

Use the standard centered `Overlay` and usual overlay-card styling. The dialog should be a large, responsive card containing the header controls and a full-height CodeMirror body.

Interaction and accessibility requirements:

- Use `role="dialog"` and `aria-modal="true"`.
- Associate the dialog with its `SQL Formatter` heading.
- Trap focus inside the dialog.
- Initially focus CodeMirror.
- Restore focus to the shell after closing.
- Support both Escape and the close button.
- Prevent outside-click dismissal.
- Give the close button an accessible name.
- Give the segmented control an accessible label such as `Format mode`.
- Make diagnostics perceivable without relying on icon color alone.

### 3. Integrate CodeMirror

Reuse the lower-level CodeMirror wrapper from the session editor rather than the session-specific `ScriptEditor`.

Configure an isolated SQL editor with:

- The existing editor theme.
- Line numbers and selection rendering.
- History and standard editing key bindings.
- No placeholder text in the empty editor.
- Standalone DashQL syntax highlighting.
- An update listener that stores Raw text and refreshes parse/format availability.

Raw mode remains editable. Compact and Pretty views should set the editor to read-only and non-editable while displaying derived text.

### 4. Parse and format SQL

Reuse the active standalone shell's existing `DashQL` core and catalog instead of loading a second WASM instance.

For the latest Raw text:

1. Create temporary script/session resources associated with the shell catalog.
2. Parse the SQL.
3. Inspect both scanner and parser diagnostics.
4. Check `isFullyFormattable` before displaying formatter output.
5. Format using the requested Compact or Pretty configuration.
6. Project syntax highlighting for the displayed text.
7. Destroy temporary scripts, sessions, and FlatBuffer pointers after every operation.

Formatting failures include:

- Scanner errors.
- Parser errors.
- Unsupported or unformattable syntax nodes.
- Exceptions from the WASM formatter.

### 5. Connect the dialog to `ShellPage`

Create the dialog controller in `ShellPage`, alongside the Salesforce login dialog controller.

- Pass its request function to `createFormatCommand`.
- Give each request access to the initialized shell's `core` and `catalog`.
- Render the dialog alongside the query-result and login overlays.
- Ensure command abort closes the dialog and settles the pending request.

## Tests

### Command tests

Add focused tests for `createFormatCommand`:

- Rejects arguments before opening the dialog.
- Opens the dialog exactly once.
- Passes the command abort signal.
- Resolves without terminal output when the dialog closes.
- Resolves without terminal output when the command is cancelled.

### Dialog tests

Add tests covering:

- Accessible dialog name and modal semantics.
- Accessible close action.
- Empty Raw editor without placeholder text.
- Initial editor focus and focus restoration.
- Raw text remains editable.
- Compact and Pretty display expected derived text.
- Switching back to Raw restores the exact authored text.
- Formatted views are read-only.
- Parser and formatter failures show an accessible diagnostic.
- Parser and formatter failures disable both derived modes.
- Correcting invalid SQL clears the diagnostic and re-enables both modes.
- Empty input does not show an error.
- Escape, close, and command abort dismiss the dialog.
- Clicking outside does not dismiss the dialog.

## Verification

Run all build and test verification through Bazel:

```bash
bazel test //packages/dashql-app:tsc_typecheck_test
bazel test //packages/dashql-app:test_chromium //packages/dashql-app:test_firefox
bazel build //packages/dashql-app:pages
```

No Bazel dependency changes are expected. The application source globs already include new TypeScript, TSX, CSS module, and test files, and the required CodeMirror and formatter dependencies are already available.

## Open Implementation Details

- Raw is a UI mode, not a native formatter mode. Only Compact and Pretty map to native formatting modes.
- Compact width should be measured from the editor viewport using the existing preview-width utility, with the repository's current fallback width.
- Diagnostics should distinguish parser/scanner errors from unsupported formatting where practical, but both conditions disable Compact and Pretty.
- The formatter card is intentionally paste-oriented and does not initially import text from the shell prompt or write formatted SQL back to it.
