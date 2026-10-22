import { describe, it, expect } from 'vitest';
import {
    type CacheFileStat,
    type QueryResultCacheStore,
    evictToFit,
} from './query_result_cache_eviction.js';

/// An in-memory cache store for exercising the eviction policy in isolation.
class MemoryCacheStore implements QueryResultCacheStore {
    files: CacheFileStat[];
    deleted: string[] = [];
    /// When set, deleteCacheFile throws for these names (simulating a NotFound race). evictToFit does
    /// not itself swallow errors — the per-backend store is responsible for tolerating NotFound — so
    /// this store models the tolerant backends.
    missing = new Set<string>();

    constructor(files: CacheFileStat[]) {
        this.files = files;
    }
    async listCacheFiles(): Promise<CacheFileStat[]> {
        return this.files.filter(f => !this.deleted.includes(f.name));
    }
    async deleteCacheFile(_sessionId: string, name: string): Promise<void> {
        if (this.missing.has(name)) {
            // Tolerated: mark as gone without error, as the real backends do for NotFound.
            this.deleted.push(name);
            return;
        }
        this.deleted.push(name);
    }
}

const SID = 'session';

/// Shorthand for a stat whose access time equals its write time (the un-accessed / fresh-write case,
/// where the marker mtime falls back to the payload's mtime).
function stat(name: string, size: number, mtimeMs: number): CacheFileStat {
    return { name, size, mtimeMs, lastAccessMs: mtimeMs };
}

describe('evictToFit', () => {
    it('does nothing when the incoming entry already fits', async () => {
        const store = new MemoryCacheStore([
            stat('a.arrow', 10, 1),
            stat('b.arrow', 10, 2),
        ]);
        await evictToFit(store, SID, 10, /*maxBytes*/ 100, /*maxFiles*/ 10);
        expect(store.deleted).toEqual([]);
    });

    it('evicts least-recently-accessed files first until under the size threshold', async () => {
        const store = new MemoryCacheStore([
            stat('old.arrow', 40, 1),
            stat('mid.arrow', 40, 2),
            stat('new.arrow', 40, 3),
        ]);
        // total 120, incoming 40, cap 100 -> must free >= 60 -> drop old (40) then mid (40) => 40 left.
        await evictToFit(store, SID, 40, /*maxBytes*/ 100, /*maxFiles*/ 100);
        expect(store.deleted).toEqual(['old.arrow', 'mid.arrow']);
    });

    it('sorts by last-access time, not write time (true LRU)', async () => {
        // 'old' was written first but accessed most recently; 'new' was written last but never
        // re-accessed. LRU must evict the coldest by access time ('new'), not the oldest write.
        const store = new MemoryCacheStore([
            { name: 'old.arrow', size: 40, mtimeMs: 1, lastAccessMs: 99 },
            { name: 'mid.arrow', size: 40, mtimeMs: 2, lastAccessMs: 50 },
            { name: 'new.arrow', size: 40, mtimeMs: 3, lastAccessMs: 5 },
        ]);
        // total 120, incoming 10, cap 100 -> free >= 30 -> dropping the coldest ('new') suffices.
        await evictToFit(store, SID, 10, /*maxBytes*/ 100, /*maxFiles*/ 100);
        expect(store.deleted).toEqual(['new.arrow']);
    });

    it('stops evicting as soon as it fits', async () => {
        const store = new MemoryCacheStore([
            stat('old.arrow', 40, 1),
            stat('mid.arrow', 40, 2),
            stat('new.arrow', 40, 3),
        ]);
        // total 120, incoming 10, cap 100 -> free >= 30 -> dropping old (40) suffices.
        await evictToFit(store, SID, 10, /*maxBytes*/ 100, /*maxFiles*/ 100);
        expect(store.deleted).toEqual(['old.arrow']);
    });

    it('evicts to satisfy the file-count threshold even when size fits', async () => {
        const store = new MemoryCacheStore([
            stat('old.arrow', 1, 1),
            stat('mid.arrow', 1, 2),
            stat('new.arrow', 1, 3),
        ]);
        // 3 files + 1 incoming = 4 > maxFiles 3 -> drop the single coldest.
        await evictToFit(store, SID, 1, /*maxBytes*/ 1000, /*maxFiles*/ 3);
        expect(store.deleted).toEqual(['old.arrow']);
    });

    it('empties the cache for an incoming entry larger than the whole budget', async () => {
        const store = new MemoryCacheStore([
            stat('a.arrow', 10, 1),
            stat('b.arrow', 10, 2),
        ]);
        await evictToFit(store, SID, 1000, /*maxBytes*/ 100, /*maxFiles*/ 100);
        expect(store.deleted.sort()).toEqual(['a.arrow', 'b.arrow']);
    });

    it('tolerates a NotFound during deletion', async () => {
        const store = new MemoryCacheStore([
            stat('old.arrow', 40, 1),
            stat('mid.arrow', 40, 2),
            stat('new.arrow', 40, 3),
        ]);
        store.missing.add('old.arrow');
        await expect(evictToFit(store, SID, 40, 100, 100)).resolves.toBeUndefined();
        expect(store.deleted).toContain('old.arrow');
    });
});
