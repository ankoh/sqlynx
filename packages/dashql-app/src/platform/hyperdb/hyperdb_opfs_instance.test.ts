import { describe, expect, it, vi } from 'vitest';

import { cleanupStaleHyperDBOPFSInstances, createHyperDBOPFSInstance } from './hyperdb_opfs_instance.js';

/// An OPFS root with an instances folder, the given folders directly in the root and an optional legacy logs folder
function mockRoot(instances: string[], legacy: string[], removeEntry: (name: string) => Promise<void>, logs?: string[]) {
    const instancesFolder = {
        async *entries() {
            for (const name of instances) yield [name, { kind: 'directory' }];
        },
        removeEntry: vi.fn(removeEntry),
    };
    const logsFolder = {
        async *entries() {
            for (const name of logs ?? []) yield [name, { kind: 'directory' }];
        },
        removeEntry: vi.fn(removeEntry),
    };
    const root = {
        async getDirectoryHandle(name: string) {
            if (name === 'instances') return instancesFolder;
            if (name === 'logs' && logs != null) return logsFolder;
            throw new DOMException('not found', 'NotFoundError');
        },
        async *entries() {
            yield ['instances', { kind: 'directory' }];
            for (const name of legacy) yield [name, { kind: 'directory' }];
        },
        removeEntry: vi.fn(removeEntry),
    };
    return { root: root as unknown as FileSystemDirectoryHandle, instancesFolder, logsFolder, rootFolder: root };
}

describe('HyperDB stale OPFS instance cleanup', () => {
    it.each(['InvalidModificationError', 'NoModificationAllowedError', 'NotFoundError'])(
        'defers directories with %s and continues cleaning other instances', async errorName => {
            const locked = crypto.randomUUID();
            const stale = crypto.randomUUID();
            const { root, instancesFolder } = mockRoot([locked, stale], [], async name => {
                if (name === locked) throw new DOMException('File cannot be removed', errorName);
            });

            await cleanupStaleHyperDBOPFSInstances(async () => root);

            expect(instancesFolder.removeEntry).toHaveBeenCalledWith(locked, { recursive: true });
            expect(instancesFolder.removeEntry).toHaveBeenCalledWith(stale, { recursive: true });
        },
    );

    it('removes the instance folders of earlier app versions in the OPFS root', async () => {
        const legacy = `dashql-session-${crypto.randomUUID()}`;
        const { root, rootFolder } = mockRoot([], [legacy, 'sessions', 'dashql-session-not-a-uuid'], async () => {});

        await cleanupStaleHyperDBOPFSInstances(async () => root);

        expect(rootFolder.removeEntry).toHaveBeenCalledTimes(1);
        expect(rootFolder.removeEntry).toHaveBeenCalledWith(legacy, { recursive: true });
    });

    it('removes the log folders of earlier app versions and keeps open ones', async () => {
        const closed = crypto.randomUUID();
        const open = crypto.randomUUID();
        const { root, logsFolder } = mockRoot([], [], async name => {
            if (name === open) throw new DOMException('File is open', 'NoModificationAllowedError');
        }, [closed, open, 'not-a-uuid']);

        await cleanupStaleHyperDBOPFSInstances(async () => root);

        expect(logsFolder.removeEntry).toHaveBeenCalledTimes(2);
        expect(logsFolder.removeEntry).toHaveBeenCalledWith(closed, { recursive: true });
        expect(logsFolder.removeEntry).toHaveBeenCalledWith(open, { recursive: true });
    });

    it('keeps the folders of live instances', async () => {
        const removeEntry = vi.fn(async () => {});
        const folders = new Map<string, unknown>();
        const instancesFolder = {
            async getDirectoryHandle(name: string) {
                folders.set(name, {});
                return { async getDirectoryHandle() { return {}; } };
            },
            async *entries() { for (const name of folders.keys()) yield [name, { kind: 'directory' }]; },
            removeEntry,
        };
        const root = {
            async getDirectoryHandle(name: string) {
                if (name !== 'instances') throw new DOMException('not found', 'NotFoundError');
                return instancesFolder;
            },
            async *entries() {},
        } as unknown as FileSystemDirectoryHandle;

        const instance = await createHyperDBOPFSInstance(async () => root);
        const [id] = folders.keys();
        expect(instance.computeDatabasePath).toBe(`/mnt/fs/instances/${id}/compute.hyper`);
        expect(instance.userDatabasePath).toBe(`/mnt/fs/instances/${id}/user.hyper`);
        expect(instance.logDirectoryPath).toBe(`/mnt/fs/instances/${id}/logs`);

        await cleanupStaleHyperDBOPFSInstances(async () => root);
        expect(removeEntry).not.toHaveBeenCalled();

        await instance.dispose();
        expect(removeEntry).toHaveBeenCalledWith(id, { recursive: true });
    });

    it('does not suppress unrelated cleanup failures', async () => {
        const { root } = mockRoot([crypto.randomUUID()], [], async () => {
            throw new DOMException('Access denied', 'NotAllowedError');
        });

        await expect(cleanupStaleHyperDBOPFSInstances(async () => root)).rejects.toThrow('Access denied');
    });
});
