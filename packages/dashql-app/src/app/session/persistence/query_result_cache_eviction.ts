/// Backend-agnostic eviction policy for the file-based query result cache.
///
/// The cache stores query results as `<hash>.arrow` files in a `cache/` folder inside each session's
/// storage. Only *listing* and *deleting* those files differs between backends (OPFS reads size and
/// `lastModified` from a `File`; the native backend has to `stat()` each entry), so those primitives
/// live behind `QueryResultCacheStore` while the policy below is shared and unit-testable.
///
/// Eviction is a true LRU keyed on `lastAccessMs`. Neither OPFS nor the native filesystem bridge exposes a
/// filesystem last-access time (nor a way to set one), and re-touching the payload on a hit would
/// mean rewriting a potentially large `.arrow` blob and would clobber its write time. So each entry
/// carries an empty sibling marker (`<hash>.arrow.last_access`) whose own mtime is bumped on every
/// hit; the backend reports that marker's mtime as `lastAccessMs`. The marker is advisory — the
/// `.arrow` files remain authoritative — so an entry with no marker falls back to its payload's write
/// time (i.e. it degrades to the old FIFO-by-creation behavior for that entry).
///
/// The cache is best-effort, not transactional: under concurrent writes the size/count totals are
/// approximate, and a delete of an already-gone file is tolerated (see `deleteCacheFile`).

/// Size/recency metadata for a single cached `.arrow` file.
export interface CacheFileStat {
    /// The file name (including the `.arrow` extension), unique within the cache folder.
    name: string;
    /// The file size in bytes.
    size: number;
    /// The last-modified (write) time in milliseconds since the epoch. Doubles as the "cached at"
    /// timestamp surfaced in the UI (a cache hit never re-touches the payload).
    mtimeMs: number;
    /// The last-*access* time in milliseconds since the epoch: the mtime of the entry's
    /// `<hash>.arrow.last_access` marker, bumped on every cache hit. Eviction drops the
    /// least-recently-accessed entries first. When no marker exists the backend falls back to
    /// `mtimeMs` here, so an un-accessed entry evicts by its write time.
    lastAccessMs: number;
}

/// The per-backend primitives the eviction policy operates over.
export interface QueryResultCacheStore {
    /// List every `*.arrow` entry in the session's cache folder with its size and mtime. Returns an
    /// empty array when the folder does not exist yet.
    listCacheFiles(sessionId: string): Promise<CacheFileStat[]>;
    /// Delete a single cache file by name. Must tolerate a missing file (treat NotFound as success).
    deleteCacheFile(sessionId: string, name: string): Promise<void>;
}

/// Default cap on the total size of a session's query result cache.
export const DEFAULT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
/// Default cap on the number of cached query results per session.
export const DEFAULT_CACHE_MAX_FILES = 200;

/// Evict least-recently-accessed cache files until a new entry of `incomingBytes` fits under both the
/// size and count thresholds.
///
/// Age is last-access time (`lastAccessMs`, the marker's mtime — see the module header): the
/// least-recently-*used* entries are dropped first, so this is a true LRU. Files are deleted
/// oldest-access-first until `totalBytes + incomingBytes <= maxBytes` and `count + 1 <= maxFiles`.
/// A single incoming entry
/// larger than `maxBytes` simply empties the cache (nothing more can be freed); the caller still
/// writes it, and the next write will evict it in turn.
export async function evictToFit(
    store: QueryResultCacheStore,
    sessionId: string,
    incomingBytes: number,
    maxBytes: number = DEFAULT_CACHE_MAX_BYTES,
    maxFiles: number = DEFAULT_CACHE_MAX_FILES,
): Promise<void> {
    const files = await store.listCacheFiles(sessionId);

    let totalBytes = 0;
    for (const f of files) {
        totalBytes += f.size;
    }
    let count = files.length;

    // Already room for the incoming entry (which will overwrite any existing same-hash file, but we
    // conservatively treat it as an addition — the totals are approximate by design).
    if (totalBytes + incomingBytes <= maxBytes && count + 1 <= maxFiles) {
        return;
    }

    // Least-recently-accessed first (ascending lastAccessMs) so we drop the coldest entries.
    const byAge = [...files].sort((a, b) => a.lastAccessMs - b.lastAccessMs);
    for (const f of byAge) {
        if (totalBytes + incomingBytes <= maxBytes && count + 1 <= maxFiles) {
            break;
        }
        await store.deleteCacheFile(sessionId, f.name);
        totalBytes -= f.size;
        count -= 1;
    }
}
