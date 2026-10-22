import { describe, expect, it } from 'vitest';
import type { WatchEvent } from './native_notebook_sync.js';

import { isNotebookContentWatchEvent, nativeNotebookWatchForLocation } from './native_notebook_sync.js';
import { StorageBackendType } from './storage_backend.js';

const DIR = '/tmp/dashql-notebook';

describe('native notebook sync', () => {
    it('only creates watches for native notebook locations', () => {
        expect(nativeNotebookWatchForLocation('notebook', { type: StorageBackendType.OPFS })).toBeNull();
        expect(nativeNotebookWatchForLocation('notebook', {
            type: StorageBackendType.Native,
            nativePath: DIR,
        })).toEqual({ notebookId: 'notebook', dir: DIR });
    });

    it('ignores access-only watcher events', () => {
        const event: WatchEvent = {
            type: { access: { kind: 'open', mode: 'read' } },
            paths: [`${DIR}/scripts/01_query.sql`],
            attrs: {},
        };
        expect(isNotebookContentWatchEvent(event, DIR)).toBe(false);
    });

    it('ignores unrelated files but accepts reloadable notebook changes', () => {
        const modify = (path: string): WatchEvent => ({
            type: { modify: { kind: 'data', mode: 'content' } },
            paths: [path],
            attrs: {},
        });
        expect(isNotebookContentWatchEvent(modify(`${DIR}/cache/result.arrow`), DIR)).toBe(false);
        expect(isNotebookContentWatchEvent(modify(`${DIR}/dashql-notebook.json`), DIR)).toBe(false);
        expect(isNotebookContentWatchEvent(modify(`${DIR}/scripts/01_query.sql`), DIR)).toBe(true);
        expect(isNotebookContentWatchEvent(modify(`${DIR}/dashql-catalog-relations.sql`), DIR)).toBe(true);
    });

    it('normalizes windows paths before filtering cache events', () => {
        const event: WatchEvent = {
            type: { create: { kind: 'file' } },
            paths: ['C:\\notebooks\\one\\cache\\result.arrow'],
            attrs: {},
        };
        expect(isNotebookContentWatchEvent(event, 'C:\\notebooks\\one')).toBe(false);
    });

    it('accepts attachment directory and file changes including windows paths', () => {
        expect(isNotebookContentWatchEvent({ paths: [`${DIR}/attachments`] }, DIR)).toBe(true);
        expect(isNotebookContentWatchEvent({ paths: [`${DIR}/attachments/data.csv`] }, DIR)).toBe(true);
        expect(isNotebookContentWatchEvent({ paths: ['C:\\notebooks\\one\\attachments\\data.csv'] }, 'C:\\notebooks\\one')).toBe(true);
        expect(isNotebookContentWatchEvent({ paths: [`${DIR}/attachments-old/data.csv`] }, DIR)).toBe(false);
        expect(isNotebookContentWatchEvent({ type: { access: {} }, paths: [`${DIR}/attachments/data.csv`] }, DIR)).toBe(false);
    });
});
