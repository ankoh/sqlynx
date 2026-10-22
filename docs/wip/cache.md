# File-Based Query Result Cache

## Context

Re-running the same SQL query against the same connection re-executes it against the backend
(Hyper / Salesforce / Trino) every time, even when nothing has changed. We want a **file-based query
result cache** that stores query results as Arrow IPC (`.arrow`) files on disk, keyed by a hash of
the connection parameters plus the SQL text. On a repeat run of a cacheable query we serve the
result straight from disk instead of hitting the backend.

The cache is entirely file-based and self-managing:
- A `cache/` folder inside each session's storage holds `<sha256hex>.arrow` files.
- For native sessions, a top-level `.gitignore` in the session folder excludes `cache/`.
- When storing a new result we evict least-recently-used files until we're under a size **and** a
  file-count threshold, then write the new file.

Results are a pure function of `(connection params signature, query text)`, so that pair is the
cache key. Post-processing (`analyzeResults`, UMAP `projection`) runs after load on both hit and
miss, so it is deliberately **excluded** from the key.

## Design decisions (confirmed)

1. **Both OPFS and native sessions**, implemented through the `StorageBackend` interface. Cache dir
   is `cache/` — under `sessions/<uuid>/cache/` for OPFS, `<dir>/cache/` for native. Native also
   gets a lazily-created `<dir>/.gitignore` containing `cache/` (never clobber an existing one).
2. **Opt-in per query** via a new `cacheable?: boolean` on `QueryExecutionArgs`. Only user queries
   set it; catalog/health-check queries never touch the cache. Read/write is otherwise transparent
   inside the executor.
3. **LRU eviction by size + count.** Before writing, if `totalBytes + incoming > MAX_BYTES` (default
   512 MB) **or** `count + 1 > MAX_FILES` (default 200), delete oldest-by-mtime `*.arrow` files until
   under both thresholds. Best-effort, not transactional.

## Implementation

### 1. Storage interface — `platform/storage/storage_backend.ts`
- Add `export const STORAGE_CACHE_FOLDER = 'cache';`
- Add two non-optional methods to `StorageBackend`:
  ```ts
  loadQueryResultCache(sessionId: string, hash: string): Promise<Uint8Array | null>;
  saveQueryResultCache(sessionId: string, hash: string, bytes: Uint8Array): Promise<void>;
  ```

### 2. Shared eviction policy — new `platform/storage/query_result_cache_eviction.ts`
Backend-agnostic LRU policy over a tiny primitive interface each backend implements (only listing/
statting differs between OPFS and native — see note below):
```ts
export interface CacheFileStat { name: string; size: number; mtimeMs: number; }
export interface QueryResultCacheStore {
    listCacheFiles(sessionId: string): Promise<CacheFileStat[]>;
    deleteCacheFile(sessionId: string, name: string): Promise<void>;
}
export const DEFAULT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CACHE_MAX_FILES = 200;
export async function evictToFit(store, sessionId, incomingBytes, maxBytes?, maxFiles?): Promise<void>
```
`evictToFit` lists, sorts by `mtimeMs` ascending (LRU), deletes until
`totalBytes + incomingBytes <= maxBytes && count + 1 <= maxFiles`, tolerating NotFound on delete.

### 3. OPFS backend — `platform/storage/opfs_storage_backend.ts`
- Private `getCacheDir(sessionId, create)` mirroring `getSessionDir` (`sessions/<uuid>/cache`).
- `loadQueryResultCache`: `getFileHandle(hash+'.arrow')`, `getFile()`, return
  `new Uint8Array(await file.arrayBuffer())`; return `null` on `NotFoundError`.
- `saveQueryResultCache`: ensure cache dir; run `evictToFit` via an inline `QueryResultCacheStore`
  that enumerates `dir.entries()` filtered to `*.arrow` and uses `getFile()` for `size`/
  `lastModified`; then `createWritable`/`write(bytes)`/`close`.

### 4. Native backend — `platform/storage/native_storage_backend.ts`
- Import `readFile`, `writeFile`, and `stat` from `platform/electron_fs`. (`readDir` entries give only
  `name`/`isFile` — no size/mtime — so eviction must `stat()` each `*.arrow` file.)
- `loadQueryResultCache`: `abs('cache/'+hash+'.arrow')`, `exists` guard, `readFile`.
- `saveQueryResultCache`: `ensureDir('cache')`; lazily write `<dir>/.gitignore` (`cache/`) only if it
  doesn't already exist; run `evictToFit` via a `QueryResultCacheStore` that `readDir`s `cache/`,
  filters to `*.arrow`, `stat`s each for size/mtime; then `writeFile(bytes)`.

### 5. Composite backend — `platform/storage/composite_storage_backend.ts`
Route both methods by UUID: `return (await this.backendFor(sessionId)).<method>(...)`.

### 6. Cache key helper — new `connection/query_result_cache_key.ts`
```ts
export async function computeQueryResultCacheKey(paramsSignature: unknown, queryText: string): Promise<string>
```
Deterministic **key-sorted** JSON stringify of `paramsSignature` (the whole cache's correctness rests
on byte-stable canonicalization — `createConnectionParamsSignature` already sorts arrays, but
`JSON.stringify` does not sort object keys), then `'\n' + queryText`, `TextEncoder`-encode,
`crypto.subtle.digest('SHA-256', …)`, lowercase hex.

### 7. Args flag — `connection/query_execution_args.ts`
Add `cacheable?: boolean;` to `QueryExecutionArgs`. Set `true` only at user-query call sites; leave
catalog/health-check callers untouched.

### 8. Executor wiring — `connection/query_executor.tsx`
- Add `const storageReader = useStorageReader();` in `QueryExecutorProvider`; capture
  `storageReader.backend`; add it to the `executeImpl` `useCallback` deps.
- **Read (hit) path**, after dispatching `EXECUTE_QUERY`, when `args.cacheable`:
  - `const params = getConnectionParamsFromStateDetails(conn.details)` — bail (execute normally) if
    `null`.
  - `const sig = createConnectionParamsSignature(params)` — bail if `null`.
  - `const hash = await computeQueryResultCacheKey(sig, args.query)`.
  - `const cached = await backend.loadQueryResultCache(sessionId, hash).catch(() => null)`.
  - After the async read, if `cancellation.signal.aborted` → dispatch `QUERY_CANCELLED`, return null.
  - On a hit: `table = arrow.tableFromIPC(cached)`; dispatch `QUERY_RECEIVED_ALL_BATCHES` with
    **null metadata** and a zeroed `createQueryResponseStreamMetrics()`; log "served from cache";
    then fall through to the shared post-table block. A present file is a hit even if it decodes to
    0 rows.
- **Converge hit + miss** on one shared post-table block (current lines ~209–276:
  `QUERY_PROCESSING_RESULTS` → `analyzeTable` → `QUERY_PROCESSED_RESULTS` → `QUERY_SUCCEEDED`) so the
  reducers, metrics, and compute registry stay driven identically.
- **Write path**: on a miss, after success, if `args.cacheable && table != null && hash != null`,
  **fire-and-forget** (do not await — the returned promise is awaited by callers and a 512 MB
  eviction scan must not stall the UI):
  `void backend.saveQueryResultCache(sessionId, hash, arrow.tableToIPC(table, 'stream')).catch(e => traced.warn(...))`.
  A cache write failure (quota/permission) must never fail the query.

### Reused building blocks
- `getConnectionParamsFromStateDetails` + `createConnectionParamsSignature` — `connection/connection_params.ts`
- `arrow.tableToIPC(table, 'stream')` / `arrow.tableFromIPC(bytes)` — already used in `platform/duckdb/duckdb_api.ts`
- `useStorageReader()` → `reader.backend` — `platform/storage/storage_provider.tsx` (provider wraps the executor, confirmed)
- `abs`/`ensureDir` (native), `getSessionDir` (OPFS) — existing private helpers

## Correctness notes
- **Eviction split**: LRU policy lives once in `evictToFit`; only list-with-stat and delete differ
  per backend, exposed via `QueryResultCacheStore`. Keeps OPFS/Electron types out of the shared module
  and makes the policy unit-testable with an in-memory store.
- **Recency = write time only.** A cache *hit* does not re-touch the file (OPFS has no `utimes`).
  Documented and accepted.
- **Concurrency**: two identical queries racing write the same bytes to the same hash → last writer
  wins, result identical. No locking; eviction tolerates NotFound on delete; thresholds are
  approximate under concurrency. Best-effort by design.
- **Key soundness**: assumes result = pure function of `(params signature, query text)`. Confirm
  Trino (`catalogName`) and Salesforce fold all per-query bindings into
  `createConnectionParamsSignature`; any connector that doesn't must not set `cacheable`.
- **Cleanup**: OPFS `deleteSession`/`clearAllStorage` recursive-delete the session folder, so
  `cache/` goes with it. Native `deleteSession` is intentionally a no-op (user-owned folder), so
  native cache files persist after unregistering — the `.gitignore` keeps them out of git.
- Never throw from the cache path; all failures log and fall back to normal execution.

## Verification

Tests must run via **bazel**, never `npx vitest` directly (confirm the exact target in the package's
`BUILD.bazel`, e.g. `bazel test //packages/dashql-app/...`).

1. **Key helper** (`query_result_cache_key.test.ts`): determinism; sensitivity (different query text
   or signature → different hash); key-order stability (same content, different insertion order →
   same hash).
2. **Eviction policy** (`query_result_cache_eviction.test.ts`): in-memory store; LRU-by-mtime
   deletion until under both thresholds; incoming bytes accounted; NotFound-on-delete tolerated;
   no-op when already under thresholds.
3. **Backend roundtrip** (extend `composite_storage_backend.test.ts`): save→load returns identical
   bytes for an OPFS-routed and a native-routed session; missing hash → null; native writes
   `.gitignore` once without clobbering an existing one; eviction removes oldest `.arrow` and never
   touches `.gitignore`. (Verify the test fs mock exposes `stat` with size/mtime and binary
   `readFile`/`writeFile`; extend the mock if not.)
4. **Executor hit/miss**: extract "recover params → compute key → decide hit/miss → post-table
   block" into testable helpers and cover: miss calls connector then writes cache; hit decodes bytes
   and skips the connector; `cacheable` false never touches the cache; catalog/health-check queries
   never cache.
5. **Manual (Electron native session)**: run a user query, confirm `<dir>/cache/<hash>.arrow` and
   `<dir>/.gitignore` (containing `cache/`) appear; re-run the same query and confirm it serves from
   cache (log line + no backend round-trip); edit the SQL and confirm a new cache file; exceed the
   thresholds (temporarily lower them) and confirm oldest files are evicted.
