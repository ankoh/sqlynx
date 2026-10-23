import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPFSDirectoryMock, OPFSFileMock } from '../../tests/opfs_mock.js';
import { fsStore, makeFsMock, resetFsStore } from './test_fs_mock.js';
import { StorageBackendType } from './storage_backend.js';
import {
    StorageTreeEntryKind,
    StorageTreeStatCache,
    listStorageTreeRoots,
    nativeTreeRoot,
    opfsTreeRoot,
    type StorageTreeFileStat,
} from './storage_tree.js';

const { File: F, Directory: D } = StorageTreeEntryKind;

function opfsRoot(files: Record<string, string>, dirs: string[]) {
    const root = new OPFSDirectoryMock('', new Map(Object.entries(files)), new Set(dirs));
    return opfsTreeRoot(async () => root as unknown as FileSystemDirectoryHandle);
}

describe('opfsTreeRoot', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('lists one level, directories first and naturally sorted, without reading files', async () => {
        const getFile = vi.spyOn(OPFSFileMock.prototype, 'getFile');
        const root = opfsRoot({
            'dashql-manifest.json': '{}',
            'sessions/a/scripts/10.sql': 'SELECT 10',
            'sessions/a/scripts/2.sql': 'SELECT 2',
        }, ['sessions', 'sessions/a', 'sessions/a/scripts', 'instances']);

        expect(await root.list([])).toEqual([
            { name: 'instances', kind: D },
            { name: 'sessions', kind: D },
            { name: 'dashql-manifest.json', kind: F },
        ]);
        expect(await root.list(['sessions', 'a', 'scripts'])).toEqual([
            { name: '2.sql', kind: F },
            { name: '10.sql', kind: F },
        ]);
        expect(getFile).not.toHaveBeenCalled();
    });

    it('rejects listing a missing directory', async () => {
        const root = opfsRoot({}, []);
        await expect(root.list(['sessions'])).rejects.toThrow();
    });

    it('stats files and marks files held open by HyperDB', async () => {
        const root = opfsRoot({ 'dashql-manifest.json': '{"a":1}', 'instances/x/compute.hyper': '' }, ['instances', 'instances/x']);
        expect(await root.stat(['dashql-manifest.json'])).toMatchObject({ sizeBytes: 7, note: null });

        const locked = new Error('locked');
        locked.name = 'NoModificationAllowedError';
        vi.spyOn(OPFSFileMock.prototype, 'getFile').mockRejectedValue(locked);
        expect(await root.stat(['instances', 'x', 'compute.hyper'])).toEqual({ sizeBytes: null, modifiedMs: null, note: 'in use' });
    });
});

describe('nativeTreeRoot', () => {
    const DIR = '/home/me/session';

    beforeEach(() => {
        resetFsStore();
        globalThis.dashqlElectron = { fs: makeFsMock() } as unknown as DashQLElectronBridge;
    });

    afterEach(() => {
        delete globalThis.dashqlElectron;
    });

    it('lists with a single readDir and no stats', async () => {
        fsStore.files.set(`${DIR}/dashql-session.json`, '{}');
        fsStore.files.set(`${DIR}/scripts/1.sql`, 'SELECT 1');
        fsStore.dirs.add(DIR);
        fsStore.dirs.add(`${DIR}/scripts`);
        const fs = globalThis.dashqlElectron!.fs;
        const readDir = vi.spyOn(fs, 'readDir');
        const stat = vi.spyOn(fs, 'stat');

        const root = nativeTreeRoot(DIR, 'session', `fs://${DIR}`);
        expect(await root.list([])).toEqual([
            { name: 'scripts', kind: D },
            { name: 'dashql-session.json', kind: F },
        ]);
        expect(readDir).toHaveBeenCalledTimes(1);
        expect(readDir).toHaveBeenCalledWith(DIR);
        expect(stat).not.toHaveBeenCalled();

        expect(await root.stat(['scripts', '1.sql'])).toMatchObject({ sizeBytes: 8, note: null });
        expect(stat).toHaveBeenCalledWith(`${DIR}/scripts/1.sql`);
    });

    it('rejects listing a missing folder', async () => {
        const fs = globalThis.dashqlElectron!.fs;
        vi.spyOn(fs, 'readDir').mockRejectedValue(new Error('ENOENT'));
        await expect(nativeTreeRoot(DIR, 'session', `fs://${DIR}`).list([])).rejects.toThrow('ENOENT');
    });
});

describe('listStorageTreeRoots', () => {
    const sessions = {
        getSessionOrder: () => ['a', 'b', 'c', 'd'],
        getSessionLocation: (id: string) => id === 'a'
            ? { type: StorageBackendType.OPFS }
            : { type: StorageBackendType.Native, nativePath: id === 'd' ? '/x/d' : '/x/shared' },
    };

    it('lists the OPFS root and the distinct native session folders on desktop', () => {
        const roots = listStorageTreeRoots(sessions, true);
        expect(roots.map(root => root.displayPath)).toEqual(['opfs://', 'fs:///x/shared', 'fs:///x/d']);
        expect(roots[1].label).toBe('b');
    });

    it('lists only the OPFS root on the web', () => {
        expect(listStorageTreeRoots(sessions, false).map(root => root.displayPath)).toEqual(['opfs://']);
    });
});

describe('StorageTreeStatCache', () => {
    const STAT: StorageTreeFileStat = { sizeBytes: 1, modifiedMs: 2, note: null };

    /// A stat fetch that resolves when the test says so
    function deferredFetch() {
        let resolve!: (stat: StorageTreeFileStat) => void;
        const fetch = vi.fn(() => new Promise<StorageTreeFileStat>(r => { resolve = r; }));
        return { fetch, resolve: (stat: StorageTreeFileStat = STAT) => resolve(stat) };
    }

    it('limits the concurrent fetches and caches the results', async () => {
        const cache = new StorageTreeStatCache(2);
        const fetches = [deferredFetch(), deferredFetch(), deferredFetch()];
        const listener = vi.fn();
        fetches.forEach((f, i) => cache.subscribe(`k${i}`, f.fetch, listener));
        expect(fetches.map(f => f.fetch.mock.calls.length)).toEqual([1, 1, 0]);

        fetches[0].resolve();
        await vi.waitFor(() => expect(fetches[2].fetch).toHaveBeenCalledTimes(1));
        expect(listener).toHaveBeenCalledWith(STAT);
        expect(cache.get('k0')).toEqual(STAT);

        // A cached stat is not fetched again
        const again = vi.fn(async () => STAT);
        cache.subscribe('k0', again, listener);
        expect(again).not.toHaveBeenCalled();
    });

    it('skips queued requests without subscribers', async () => {
        const cache = new StorageTreeStatCache(1);
        const first = deferredFetch();
        const second = deferredFetch();
        const third = deferredFetch();
        cache.subscribe('k0', first.fetch, () => {});
        const unsubscribe = cache.subscribe('k1', second.fetch, () => {});
        cache.subscribe('k2', third.fetch, () => {});
        unsubscribe();

        first.resolve();
        await vi.waitFor(() => expect(third.fetch).toHaveBeenCalledTimes(1));
        expect(second.fetch).not.toHaveBeenCalled();
    });

    it('turns a failed fetch into an unavailable stat', async () => {
        const cache = new StorageTreeStatCache();
        const listener = vi.fn();
        cache.subscribe('k', () => Promise.reject(new Error('gone')), listener);
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ sizeBytes: null, modifiedMs: null, note: 'unavailable' }));
    });
});
