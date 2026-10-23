# Native File Synchronization

DashQL native sessions live in user-owned directories. DashQL writes scripts and attachments to
those directories through a debounced `StorageWriter`; users and external tools may also edit the
same files. Native file synchronization detects those external changes and offers to reload them into
the running application without reopening the session.

This feature is intentionally narrow. Filesystem watching, conflict handling, and reload coordination
are contained behind one native synchronization boundary. Storage backends remain request/response
readers and writers, while connection and session state retain ownership of their domain-specific
WASM and catalog lifecycles.

## Goals

- Detect externally changed native scripts and attachments.
- Reload added, removed, renamed, and edited scripts.
- Preserve active connection state, query history, focus, and script identity where possible.
- Prevent delayed events from DashQL's own writes from appearing as external changes.
- Avoid silently discarding local debounced edits.
- Keep native watcher concepts out of generic storage backends and session reducers.
- Behave consistently across macOS, Linux, and Windows path formats.

## Non-Goals

- Synchronizing OPFS sessions. Browser-private storage has no supported external editor workflow.
- Watching or reloading `dashql-session.json`. Connection identity and parameters require a complete
  connection lifecycle and are not safe to replace in place.
- Watching query cache files, `.gitignore`, or other generated and unrelated files.
- Automatic text merging. A conflict is resolved by keeping the current application state or loading
  the complete external snapshot.
- Treating filesystem events as a reliable change log. Events are only invalidation signals.
- Coordinating simultaneous DashQL processes editing the same native directory as a distributed
  transactional system.

## Persisted Layout

The synchronization boundary recognizes these session-relative paths:

```text
dashql-session.json
scripts/
  <script>.sql
attachments/
```

It deliberately ignores:

```text
cache/
.gitignore
<any other file>
```

Sessions don't hold a catalog. The catalog belongs to the connection and lives in the app storage
(`connections/<id>/`); session format version 7 removed the catalog copies from session folders.

The native session directory is resolved through `StorageReader.getSessionLocation`. Only locations
with `StorageBackendType.Native` and a `nativePath` receive a watcher.

## Architecture

```mermaid
flowchart TD
    FS[Native session directory] --> WS[NativeSessionSyncService]
    WS -->|session invalidated| RC[NativeSessionSync React coordinator]
    RC --> SW[StorageWriter coordination]
    RC --> SB[StorageBackend snapshot reads]
    RC --> NS[Session scripts reconciliation]
    NS --> UI[Live application state]
```

### Watch Service

`NativeSessionSyncService` in
`packages/dashql-app/src/platform/storage/native_session_sync.ts` is the platform adapter. It:

- Creates recursive watchers through the Electron preload bridge.
- Reconciles the desired session-to-directory set with currently active watchers.
- Debounces native events by 200 ms.
- Normalizes Windows separators before matching relative paths.
- Ignores access-only events and paths outside the reloadable layout.
- Emits only a session id to its consumer.
- Uses a generation counter to close watchers created by an obsolete asynchronous reconciliation.

No application state or storage reads occur in this service. A native event says only that a session
may have changed; it is not trusted to describe which operation happened.

### React Coordinator

`NativeSessionSync` in
`packages/dashql-app/src/platform/storage/native_session_sync_react.tsx` is mounted once inside the
connection and session registry providers. It owns:

- Watcher setup and teardown as native sessions enter, leave, or change location.
- Per-session event coalescing and serialized reload processing.
- Writer pause, pending-write inspection, and conflict decisions.
- Stable snapshot reads through the existing `StorageBackend` interface.
- Self-write suppression and prompt revalidation.
- Dispatch to the connection and session reconciliation functions.

This is the only component that knows about watchers, storage coordination, native dialogs, and both
state registries. That concentration is deliberate: the rest of the application continues to use the
same storage and state APIs as before.

### Domain Reconciliation

Session scripts reconciliation stays in
`packages/dashql-app/src/scripts/session_scripts.ts`:

- `SessionScriptsStorageSnapshot` is the storage-shaped boundary type.
- `sessionScriptsMatchStorageSnapshot` detects content and page-structure differences.
- `replaceSessionScriptsFromStorage` applies a complete snapshot without persistence side effects.
- Scripts at unchanged page/file paths retain their WASM script identity and query history.
- Added scripts allocate new WASM state; removed scripts are detached from the catalog before destruction.
- Changed script text clears stale completion and pending-diff buffers.
- Existing page/script focus is retained when that path still exists; otherwise focus falls back to
  the first sorted entry.
- Any session change invalidates affected session analysis. Scripts are reanalyzed on
  demand when an editor, execution, or diagnostics flow needs current analysis.

## Reload Protocol

```mermaid
flowchart TD
    E[Relevant watcher event] --> P[Pause writes for this session]
    P --> S[Await in-flight writes]
    S --> R[Read session snapshot]
    R --> Q{Matches live state?}
    Q -->|yes| Z[Resume writes]
    Q -->|no| W{Matches DashQL completed write?}
    W -->|yes| Z
    W -->|no| C[Inspect reloadable pending writes]
    C --> D{User chooses Reload?}
    D -->|no| Z
    D -->|yes| G{Write generation unchanged?}
    G -->|no| E
    G -->|yes| A[Cancel conflicting pending writes]
    A --> U[Apply session snapshot]
    U --> Z
```

The coordinator follows these steps for one session at a time:

1. Pause that session's debounced writes. Other sessions continue normally.
2. Await writes that already started, then read the session file and the scripts through
   `StorageBackend`.
3. Compare the snapshot with current state. Identical state ends the reload without a prompt.
4. Check whether every disk/memory divergence equals content that `StorageWriter` most recently
   completed. If so, the event came from DashQL's own earlier write and is ignored.
5. Inspect pending writes only in the reloadable path set. A pending manifest update is unrelated and
   must not be canceled by a session reload.
6. Ask the user whether to reload. When relevant local writes are pending, the dialog explicitly says
   that reloading discards them.
7. Recheck the relevant write generation after the dialog. The editor remains interactive while a
   native dialog is open; if another local edit was scheduled, the old decision is stale and the
   session is requeued for a fresh snapshot and decision.
8. Cancel only conflicting pending session writes when the user accepted that consequence.
9. Reconcile the session and invalidate analysis that may depend on the changed session contents.
   Reanalysis happens on demand.
10. Resume the session writer in a `finally` block.

Repeated events for a session collapse in a `Set`. The processing loop serializes sessions, avoiding
overlapping dialogs and concurrent mutation of shared WASM state.

## Writer Coordination

`StorageWriter` remains the authority for outbound writes. Native synchronization adds four narrowly
scoped capabilities:

- **Session pause:** `pauseSession` and `resumeSession` hold timers only for one session.
- **Scoped pending writes:** callers can inspect or cancel keys selected by a predicate.
- **Write generations:** every scheduled key receives a monotonic generation used to invalidate a
  conflict decision made while a dialog was open.
- **Completed content:** successful writes record their final per-path text, including rename/delete
  effects, so a delayed native event can be correlated with DashQL's own write.

Global `flush()` remains a hard drain. It force-processes pending tasks even when a session is paused,
which preserves shutdown and storage-migration semantics.

Storage write keys are session-rooted logical paths. The coordinator uses the same path convention as
the watcher filter, so conflict cancellation cannot affect `dashql-session.json` or another session.

## Conflict Semantics

There are three relevant versions:

| Version | Meaning |
| --- | --- |
| Live state | Current connection and session state visible in DashQL |
| Pending writes | Newer local state scheduled but not yet persisted |
| Disk snapshot | Stable read taken after in-flight writes have settled |

The policies are:

- If disk and live state match, do nothing.
- If disk differs from live state only because it is a known completed DashQL write and a newer local
  version is pending, do nothing and allow the pending write to complete.
- If disk differs externally and there are no pending local writes, ask whether to reload.
- If disk differs externally and local writes are pending, ask whether to reload and discard only
  those conflicting pending writes.
- If local writes change while the dialog is open, discard the decision, reread disk, and decide from
  a fresh state.
- Choosing **Keep current** resumes local writes. Those writes may subsequently overwrite the external
  version; this is the explicit meaning of keeping the application version.

## Failure Handling

- Watch registration failure is logged as a warning and does not prevent the session from loading.
- Snapshot read or reconciliation failure is logged as an error.
- Session writes are resumed in all success, rejection, and failure paths.
- Watcher cleanup closes all native subscriptions when the coordinator unmounts.
- Events for sessions no longer present in the registries are harmless; there is no state to replace.

Filesystem saves are not transactional snapshots. Editors often implement save as a temporary-file
write followed by rename, which the watcher debounce normally collapses. The storage read remains the
source of truth. A transient unreadable snapshot fails safely and leaves live state unchanged; a later
filesystem event can retry.

## Security and Permissions

Native watchers operate only on directories already registered as native DashQL sessions. The
renderer can request watches only through the narrow preload API; the Electron main process rejects
requests from untrusted renderer origins and non-absolute paths. Watchers are released when the
renderer is destroyed or explicitly unsubscribes.

## Testing

Focused tests cover:

- Native-location selection and cross-platform path filtering.
- Ignoring access, cache, manifest, and unrelated file events.
- Session-scoped pause/resume and cancellation.
- Global flush behavior while a session is paused.
- Preserving unrelated manifest writes during session conflict cancellation.
- Detection of page-only structural changes.
- Same-path script identity preservation and added/changed content reconciliation.

Relevant Bazel targets:

```bash
bazel test //packages/dashql-app:tsc_typecheck_test
bazel test //packages/dashql-app:test_chromium //packages/dashql-app:test_firefox
bazel build //packages/dashql-native:compile
```

## Known Limitations

- `dashql-session.json` changes require reopening the session.
- Reload is snapshot replacement, not a three-way merge or per-file conflict UI.
- Watchers and completed-content metadata are process-local and reset when the app restarts.
- A native filesystem watcher can coalesce or omit low-level events. The design therefore rescans the
  complete reloadable session state after every accepted invalidation, but it cannot react to a change
  for which the operating system emits no event at all.

## Implementation References

- Watch adapter: `packages/dashql-app/src/platform/storage/native_session_sync.ts`
- Reload coordinator: `packages/dashql-app/src/platform/storage/native_session_sync_react.tsx`
- Native storage reads: `packages/dashql-app/src/platform/storage/native_storage_backend.ts`
- Writer coordination: `packages/dashql-app/src/platform/storage/storage_writer.ts`
- Session scripts reconciliation: `packages/dashql-app/src/scripts/session_scripts.ts`
- Electron main/preload filesystem bridge: `packages/dashql-native/src/main.ts` and `src/preload.cjs`
- Watcher tests: `packages/dashql-app/src/platform/storage/native_session_sync.test.ts`
- Writer tests: `packages/dashql-app/src/platform/storage/storage_writer.test.ts`
- Session scripts reconciliation tests: `packages/dashql-app/src/scripts/session_scripts.test.ts`
