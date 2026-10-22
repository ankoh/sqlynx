import type { QueryResultCache } from '../../../query/query_result_cache.js';
import type { StorageBackend } from './storage_backend.js';

export function createSessionQueryResultCache(
    backend: StorageBackend,
    sessionId: string,
): QueryResultCache {
    return {
        load: key => backend.loadQueryResultCache(sessionId, key),
        touch: key => backend.touchQueryResultCacheAccess(sessionId, key),
        store: (key, bytes) => backend.saveQueryResultCache(sessionId, key, bytes),
    };
}
