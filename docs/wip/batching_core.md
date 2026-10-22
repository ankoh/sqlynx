# Batching Core

## Status

Implemented for catalog preparation and publication. Interactive editor analysis remains synchronous.
This replaces the former shared-heap, pthread-based catalog analysis proposal. Asynchronous editor
analysis requires a separate design; it cannot reuse the removed native asynchronous executor.

## Motivation

Catalog loading produces independent SQL sources, typically one relation catalog and one function
catalog. Scanning, parsing, and analyzing large generated sources on the browser event loop blocks
the UI. Publishing each source independently can also expose a partially refreshed catalog.

The batch API separates preparation from publication:

- Submit complete source texts in one request instead of coordinating mutable native scripts across threads.
- Run preparation in a dedicated worker without accessing the UI's catalog or Wasm heap.
- Return owned, portable buffers rather than native pointers or shared analyzer object graphs.
- Validate all required results before replacing the receiving catalog entries sequentially.
- Keep the previous catalog available when preparation fails, is cancelled, or becomes obsolete.

The native API is synchronous. The worker provides the asynchronous boundary. Batching does not
currently parallelize scripts within a request; it moves their sequential processing off the UI
thread and provides one preparation boundary followed by per-descriptor publication.

## Execution Model

```mermaid
sequenceDiagram
    participant UI as Application / Main Core
    participant W as Batch Worker / Worker Core
    UI->>UI: Allocate refresh generation; fetch metadata
    UI->>W: BatchRequest with SQL and optional descriptor context
    W->>W: Scan / parse / analyze in a job-local catalog
    W-->>UI: Diagnostics and selected owned buffers
    UI->>UI: Validate generation, lifecycle, and results
    loop Each prepared descriptor
        UI->>UI: Update its persistence source text
        UI->>UI: Atomically replace its catalog descriptor
    end
```

There is one batch worker per main-thread `DashQL` instance. `DashQLCoreProvider` accepts
`initialSetup={{ setupBatchWorker: true }}` to initialize the worker and its Core module during
initial Core setup, before returning the instance. The session app enables this option; callers
that disable or omit it, including the shell, have no batch worker. Worker-backed catalog calls
fail without an initialized worker; there is no lazy creation or automatic replacement. The option
is captured at provider creation rather than reacting to later prop changes. An empty batch warms
the module without preparing scripts; repeated initialization calls reuse the readiness promise.
Worker initialization failure fails initial Core setup and disposes the worker.

The worker caches its
own Core module across requests: **Core is not reinstantiated for every batch**. Only scripts and
the temporary catalog are job-local. Worker jobs are serialized through a promise queue.

Core initialization is retried if it fails. A worker transport failure closes the client and rejects
outstanding requests; recovery requires explicit worker setup rather than a refresh creating one.
Provider disposal terminates
the worker and aborts outstanding publication waits. The same abort signal guards queued response
continuations before commit. Delayed metadata fetches cannot recreate a worker because publication
requires explicit setup; no separate retired-Core registry is needed.

## Batch Contract

The TypeScript entry point is `DashQL.processBatch(request)`. The native entry point is
`dashql_process_batch`; request and response envelopes use FlatBuffers defined in
`proto/fb/dashql/batch.fbs`.

Each input contains a caller-defined string ID, SQL text, and selected outputs:

| Output | Native Bit | Contents |
|---|---|---|
| `scanned` | 1 | Scanner result |
| `parsed` | 2 | Parser result |
| `analyzed` | 4 | Analyzer result |
| `catalogDescriptor` | 8 | Portable table, column, and function declarations |

Only the stages needed for the requested outputs run. Requesting a descriptor runs the full
pipeline but does not return the intermediate buffers unless requested. A zero-output input performs
no SQL processing. Results preserve input order and IDs; IDs need not be unique at this API layer.

Optional catalog descriptors provide analysis context. Every batch imports that context into a
fresh catalog. Input scripts are never published into it, so declarations from one input do not
become visible to another input. Successive batches likewise do not inherit catalog state.

Calls sharing a native catalog must be serialized. The catalog has no state or ID-reservation
mutexes, and its monotonic ID counters are ordinary integers. The main thread and worker use
separate Core instances, so they do not concurrently access a catalog. Atomic publication means
staging and committing one complete descriptor replacement, not thread synchronization or a
transaction across descriptor pools.

Diagnostics include stage, severity, byte offset, length, and message. SQL errors are diagnostics,
not processing failures. Errors suppress descriptor output; warnings do not. Invalid input or
processing exceptions produce a per-script `failure` while allowing other inputs to finish.
Descriptor semantic validation failures also use `failure`; already packed stage outputs remain
available. Malformed request envelopes or context descriptors reject the whole call.

## Ownership And Descriptors

Selected TypeScript outputs own their bytes independently of Wasm memory. The API frees the native
request/result allocations after copying the result buffers. Worker responses transfer their output
buffers to the caller. Caller-owned context buffers are copied into the worker, never detached.

`CatalogDescriptor` carries declarations, not a portable live analyzer graph. Receiver import:

- Verifies the FlatBuffer and declaration semantics, including names and duplicate tables/columns.
- Owns immutable descriptor bytes and all declaration strings.
- Uses receiver-assigned entry IDs and canonical database/schema IDs, not producer IDs or AST locations.
- Builds receiver-local declaration objects and lazily constructs completion search indexes.
- Supports descriptors and ordinary script-backed entries in the same catalog.

`Catalog.replaceDescriptor(catalogEntryId: number, rank: number, descriptor: Uint8Array)` stages one
replacement before publication. Each successful call increments the catalog version once; a failed
call leaves that pool's previous publication intact. Multiple calls are not a transaction: a later
import failure does not undo earlier successful replacements, so partial publication is possible.
Source script IDs remain the stable publication identities even though the entries are now backed
by descriptors. Persisted SQL remains the source format; descriptors are rebuilt on restoration.

Existing analyzed scripts retain the catalog generations they reference. Reanalysis uses fresh
scanner/parser state when old analysis metadata or shared snapshots would otherwise be reused,
avoiding mutation of published name graphs and dangling intrusive links. Removal prunes active
namespace membership without discarding canonical ID reservations or retained old generations.

## Application Publication

`catalog_batch.ts` centralizes catalog preparation and commit. Production catalog callers request
only `catalogDescriptor` output.

A refresh generation is allocated before metadata fetching. Immediately before commit, publication
checks generation, abort signal, connection identity where supplied, and Core lifecycle. The helper
also validates result identities, SQL diagnostics, descriptor presence, and required function counts.

All processing results are prechecked before any source writes or imports. The helper then processes
each pool sequentially, writing its persistence source text immediately before importing its descriptor,
with no asynchronous gap between validation, source updates, and publication. If a source write or
import fails, the helper restores only the failed current source text on a best-effort basis. Earlier
successful pools and their updated source texts remain published; later pools are not attempted.
Each descriptor replacement is atomic, but the refresh is not atomic across pools and may be partially
published when a later import fails.

Reset/delete abort running catalog tasks and invalidate their generations. Forced refreshes cancel
the previous execution and stay queued until it settles. Completion wakes the queue, and late terminal
actions cannot replace a newer task's authoritative refresh identity. Cancellation stops waiting and
prevents publication; it does not interrupt a synchronous native job already executing in the worker.

## Current Uses

| Path | Inputs | Execution |
|---|---|---|
| Session startup restoration | Persisted relation and function SQL | Worker |
| Hyper catalog refresh | Relation and function SQL | Worker |
| Salesforce catalog refresh | Metadata-derived relations and prefetched functions | Worker |
| PostgreSQL-style refresh | Relations from `pg_attribute`, functions from `pg_proc` | Worker |
| Trino refresh | Relations from `information_schema` | Worker |
| Initial prefetched Hyper function loading | Bundled function SQL | Synchronous batch |
| Applying external catalog file changes | Changed relation/function SQL | Synchronous batch |

The synchronous exceptions use the same isolated descriptor preparation and per-descriptor atomic
import contract, but still perform preparation on the main thread. They are not off-thread paths.

Interactive session editing, editor completion, and query execution do not use the batch API.
Moving editor analysis to a worker would need revision validation and a serialized editor-state
contract beyond catalog descriptors.

## Related Changes

- Removed native asynchronous analysis jobs, script busy guards, and Core Wasm pthread configuration.
- Added descriptor publication, entry-ID allocation, descriptor removal, and catalog statistics.
- Fixed partial table resolution and Unicode namespace range searches exercised by descriptor imports.
- Preserved quoted identifier handling needed to round-trip generated catalog SQL.
- Corrected function metadata generation for multiple arguments, names, modes, and unsupported signatures.
- Replaced JSON array conversion in the live function query with native Arrow arrays because Hyper WASM
  does not support `array_to_json` or casting `oidvector` to `oid[]`.

Hyper exposes incomplete built-in function signatures. The live query represents missing return
metadata as `any`; batching does not reconstruct argument metadata that the engine does not expose.

## Verification

Regression coverage includes all output subsets, diagnostics, input isolation, buffer ownership,
descriptor validation/remapping, per-descriptor atomic publication, sequential partial publication,
retained generations, reanalysis safety, Unicode resolution, worker reuse/transport failure,
cancellation, provider disposal, startup
restoration, and forced-refresh queue ordering.

A live Hyper WASM test executes the function metadata query, generates SQL, processes it into a
descriptor, imports it, and checks completion. This catches engine compatibility issues that mocked
Arrow fixtures cannot establish.

Before the single-descriptor API migration, the implementation was verified through nine native Core
test suites, both TypeScript type-check targets, and the Chromium and Firefox browser suites. Each
browser suite passed 9,637 tests with one skipped. Those results do not verify the subsequent
single-descriptor migration. Verification uses Bazel targets, as required by repository guidance.

## Main Files

- `proto/fb/dashql/batch.fbs` and `catalog.fbs`: wire contracts.
- `packages/dashql-core/src/batch.rs`: isolated native processing.
- `packages/dashql-core/src/catalog/descriptor.rs` and `catalog/mod.rs`: validation and receiver publication.
- `packages/dashql-core-js/src/batch.ts` and `api.ts`: public API and buffer ownership.
- `packages/dashql-core-js/src/batch_worker.ts` and `batch_worker_client.ts`: persistent worker transport.
- `packages/dashql-app/src/app/connections/catalog_batch.ts`: application commit boundary.
- `packages/dashql-app/src/app/connections/catalog_loader.tsx`: refresh queue and supersession.
- `packages/dashql-app/src/app/session/persistence/app_state_loader.ts`: startup restoration.
