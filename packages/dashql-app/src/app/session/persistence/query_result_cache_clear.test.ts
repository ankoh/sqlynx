import { describe, expect, it, vi } from 'vitest';

import { cacheFileHash, clearQueryResultCache, markDeletedQueryResults } from './query_result_cache_clear.js';
import { QUERY_CACHE_DELETED } from '../connections/query_execution_state.js';

describe('Query result cache clearing', () => {
    it('strips the extension of cache files', () => {
        expect(cacheFileHash('abc.arrow')).toBe('abc');
        expect(cacheFileHash('abc')).toBe('abc');
    });

    it('deletes every cached result of a session', async () => {
        const deleteQueryResultCache = vi.fn(async () => { });
        const backend = {
            listQueryResultCache: vi.fn(async () => [{ name: 'a.arrow' }, { name: 'b.arrow' }]),
            deleteQueryResultCache,
        };
        expect(await clearQueryResultCache(backend as any, 'session')).toEqual(['a', 'b']);
        expect(deleteQueryResultCache.mock.calls).toEqual([['session', 'a'], ['session', 'b']]);
    });

    it('marks the finished queries of the session whose results were deleted', () => {
        const database = (databaseId: string, queries: [number, string | null, boolean][]) => ({
            databaseId,
            queriesFinished: new Map(queries.map(([queryId, cacheKey, cacheDeleted]) => [queryId, { queryId, cacheKey, cacheDeleted }])),
        });
        const registry = {
            attachedDatabases: new Map<string, any>([
                ['main', database('main', [[1, 'a', false], [2, 'other', false], [3, null, false], [4, 'b', true]])],
                ['attached', database('attached', [[5, 'b', false]])],
                ['unrelated', database('unrelated', [[6, 'a', false]])],
            ]),
            attachedDatabasesBySession: new Map([['session', { mainDatabaseId: 'main', attachedDatabaseIds: ['attached'] }]]),
        };
        const dispatch = vi.fn();
        expect(markDeletedQueryResults(registry as any, dispatch, 'session', ['a', 'b'])).toBe(2);
        expect(dispatch.mock.calls).toEqual([
            ['main', { type: QUERY_CACHE_DELETED, value: [1] }],
            ['attached', { type: QUERY_CACHE_DELETED, value: [5] }],
        ]);
    });
});
