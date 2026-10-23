import { describe, expect, it } from 'vitest';
import type { WatchEvent } from './native_session_sync.js';

import { isSessionContentWatchEvent, nativeSessionWatchForLocation } from './native_session_sync.js';
import { StorageBackendType } from '../../storage/storage_backend.js';

const DIR = '/tmp/dashql-session';

describe('native session sync', () => {
    it('only creates watches for native session locations', () => {
        expect(nativeSessionWatchForLocation('session', { type: StorageBackendType.OPFS })).toBeNull();
        expect(nativeSessionWatchForLocation('session', {
            type: StorageBackendType.Native,
            nativePath: DIR,
        })).toEqual({ sessionId: 'session', dir: DIR });
    });

    it('ignores access-only watcher events', () => {
        const event: WatchEvent = {
            type: { access: { kind: 'open', mode: 'read' } },
            paths: [`${DIR}/scripts/01_query.sql`],
            attrs: {},
        };
        expect(isSessionContentWatchEvent(event, DIR)).toBe(false);
    });

    it('ignores unrelated files but accepts reloadable session changes', () => {
        const modify = (path: string): WatchEvent => ({
            type: { modify: { kind: 'data', mode: 'content' } },
            paths: [path],
            attrs: {},
        });
        expect(isSessionContentWatchEvent(modify(`${DIR}/cache/result.arrow`), DIR)).toBe(false);
        expect(isSessionContentWatchEvent(modify(`${DIR}/dashql-session.json`), DIR)).toBe(true);
        expect(isSessionContentWatchEvent(modify(`${DIR}/scripts/01_query.sql`), DIR)).toBe(true);
        // Sessions don't hold a catalog, the connection does
        expect(isSessionContentWatchEvent(modify(`${DIR}/dashql-catalog-relations.sql`), DIR)).toBe(false);
    });

    it('normalizes windows paths before filtering cache events', () => {
        const event: WatchEvent = {
            type: { create: { kind: 'file' } },
            paths: ['C:\\sessions\\one\\cache\\result.arrow'],
            attrs: {},
        };
        expect(isSessionContentWatchEvent(event, 'C:\\sessions\\one')).toBe(false);
    });

    it('accepts attachment directory and file changes including windows paths', () => {
        expect(isSessionContentWatchEvent({ paths: [`${DIR}/attachments`] }, DIR)).toBe(true);
        expect(isSessionContentWatchEvent({ paths: [`${DIR}/attachments/data.csv`] }, DIR)).toBe(true);
        expect(isSessionContentWatchEvent({ paths: ['C:\\sessions\\one\\attachments\\data.csv'] }, 'C:\\sessions\\one')).toBe(true);
        expect(isSessionContentWatchEvent({ paths: [`${DIR}/attachments-old/data.csv`] }, DIR)).toBe(false);
        expect(isSessionContentWatchEvent({ type: { access: {} }, paths: [`${DIR}/attachments/data.csv`] }, DIR)).toBe(false);
    });
});
