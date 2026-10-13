import { HYPER_OPFS_ROOT } from './hyperdb_opfs.js';

const DIRECTORY_PREFIX = 'dashql-session-';
const LOCK_PREFIX = 'dashql-session-';

export interface HyperDBOPFSSession {
    readonly computeDatabasePath: string;
    readonly defaultDatabasePath: string;
    dispose(): Promise<void>;
}

export async function createHyperDBOPFSSession(
    getRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): Promise<HyperDBOPFSSession> {
    const id = crypto.randomUUID();
    const directoryName = `${DIRECTORY_PREFIX}${id}`;
    const release = await holdSessionLock(id);
    try {
        const root = await getRoot();
        await root.getDirectoryHandle(directoryName, { create: true });
        let disposed = false;
        return {
            computeDatabasePath: `${HYPER_OPFS_ROOT}/${directoryName}/compute.hyper`,
            defaultDatabasePath: `${HYPER_OPFS_ROOT}/${directoryName}/session.hyper`,
            async dispose(): Promise<void> {
                if (disposed) return;
                disposed = true;
                try {
                    await root.removeEntry(directoryName, { recursive: true });
                } finally {
                    release();
                }
            },
        };
    } catch (error) {
        release();
        throw error;
    }
}

export async function cleanupStaleHyperDBOPFSSessions(
    getRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): Promise<void> {
    if (navigator.locks == null) return;
    const root = await getRoot();
    for await (const [name, handle] of root.entries()) {
        if (handle.kind !== 'directory' || !name.startsWith(DIRECTORY_PREFIX)) continue;
        const id = name.slice(DIRECTORY_PREFIX.length);
        if (!isUuid(id)) continue;
        await navigator.locks.request(`${LOCK_PREFIX}${id}`, { ifAvailable: true }, async lock => {
            if (lock != null) await root.removeEntry(name, { recursive: true });
        });
    }
}

async function holdSessionLock(id: string): Promise<() => void> {
    if (navigator.locks == null) return () => {};
    let acquired!: () => void;
    const acquiredLock = new Promise<void>(resolve => { acquired = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    void navigator.locks.request(`${LOCK_PREFIX}${id}`, async () => {
        acquired();
        await held;
    });
    await acquiredLock;
    return release;
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
