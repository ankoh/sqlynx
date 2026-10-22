import { STORAGE_CACHE_EXTENSION, type StorageBackend } from './storage_backend.js';
import { QUERY_CACHE_DELETED } from '../connections/query_execution_state.js';
import {
    resolveNotebookAttachedDatabases,
    type AttachedDatabaseRegistry,
    type DynamicAttachedDatabaseDispatch,
} from '../connections/attached_database_registry.js';

/// The content hash of a cached query result file
export function cacheFileHash(name: string): string {
    return name.endsWith(STORAGE_CACHE_EXTENSION) ? name.slice(0, -STORAGE_CACHE_EXTENSION.length) : name;
}

/// Delete every cached query result of a notebook, returns the content hashes of the deleted entries
export async function clearQueryResultCache(backend: StorageBackend, notebookId: string): Promise<string[]> {
    const hashes = (await backend.listQueryResultCache(notebookId)).map(file => cacheFileHash(file.name));
    for (const hash of hashes) {
        await backend.deleteQueryResultCache(notebookId, hash);
    }
    return hashes;
}

/// Mark the finished queries of a notebook whose cached results were deleted, their results no longer advertise
/// a cache entry. Returns the number of marked queries.
export function markDeletedQueryResults(
    registry: AttachedDatabaseRegistry,
    dispatch: DynamicAttachedDatabaseDispatch,
    notebookId: string,
    hashes: Iterable<string>,
): number {
    const deleted = new Set(hashes);
    const databases = resolveNotebookAttachedDatabases(registry, notebookId);
    let marked = 0;
    for (const database of databases == null ? [] : [databases.main, ...databases.attached]) {
        for (const query of database.queriesFinished.values()) {
            if (query.cacheKey != null && deleted.has(query.cacheKey) && !query.cacheDeleted) {
                dispatch(database.databaseId, { type: QUERY_CACHE_DELETED, value: [query.queryId] });
                ++marked;
            }
        }
    }
    return marked;
}
