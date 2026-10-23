import { HYPER_OPFS_ROOT } from './hyperdb_opfs.js';

/// The OPFS folder with one folder per embedded database instance, e.g. `instances/<uuid>/compute.hyper`
export const HYPER_INSTANCES_DIRECTORY = 'instances';
/// The folder of the Hyper log files in an instance folder
export const HYPER_INSTANCE_LOGS_DIRECTORY = 'logs';
const LOCK_PREFIX = 'dashql-instance-';
/// The instance folders of app versions before the instances folder sit in the OPFS root, with a lock of the same name
const LEGACY_PREFIX = 'dashql-session-';
/// The default log folder of Hyper in the OPFS root, which app versions before the instance log folders filled
const LEGACY_LOGS_DIRECTORY = 'logs';

/// The database files of an embedded database instance, which lives as long as its app window.
/// A Web Lock marks the instance as alive, the folders of instances without a lock are stale.
export interface HyperDBOPFSInstance {
    /// The Hyper path of the compute database with the data frames
    readonly computeDatabasePath: string;
    /// The Hyper path of the user database of the embedded Hyper connector
    readonly userDatabasePath: string;
    /// The Hyper path of the folder of the Hyper log files, the setting `log_file_path` of the instance
    readonly logDirectoryPath: string;
    /// Remove the files of the instance and release its lock
    dispose(): Promise<void>;
}

export async function createHyperDBOPFSInstance(
    getRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): Promise<HyperDBOPFSInstance> {
    const id = crypto.randomUUID();
    const release = await holdLock(`${LOCK_PREFIX}${id}`);
    try {
        const instances = await (await getRoot()).getDirectoryHandle(HYPER_INSTANCES_DIRECTORY, { create: true });
        const instance = await instances.getDirectoryHandle(id, { create: true });
        await instance.getDirectoryHandle(HYPER_INSTANCE_LOGS_DIRECTORY, { create: true });
        const folder = `${HYPER_OPFS_ROOT}/${HYPER_INSTANCES_DIRECTORY}/${id}`;
        let disposed = false;
        return {
            computeDatabasePath: `${folder}/compute.hyper`,
            userDatabasePath: `${folder}/user.hyper`,
            logDirectoryPath: `${folder}/${HYPER_INSTANCE_LOGS_DIRECTORY}`,
            async dispose(): Promise<void> {
                if (disposed) return;
                disposed = true;
                try {
                    await instances.removeEntry(id, { recursive: true });
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

/// Remove the folders of the instances whose app window is gone, including the instance folders and the log
/// files of earlier app versions.
export async function cleanupStaleHyperDBOPFSInstances(
    getRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): Promise<void> {
    if (navigator.locks == null) return;
    const root = await getRoot();
    let instances: FileSystemDirectoryHandle | null = null;
    try {
        instances = await root.getDirectoryHandle(HYPER_INSTANCES_DIRECTORY, { create: false });
    } catch (error) {
        if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
    if (instances != null) {
        for await (const [name, handle] of instances.entries()) {
            if (handle.kind === 'directory' && isUuid(name)) await removeUnlocked(instances, name, `${LOCK_PREFIX}${name}`);
        }
    }
    for await (const [name, handle] of root.entries()) {
        if (handle.kind === 'directory' && name.startsWith(LEGACY_PREFIX) && isUuid(name.slice(LEGACY_PREFIX.length))) {
            await removeUnlocked(root, name, name);
        }
    }
    // The log folders of earlier app versions have no lock, the processes of open windows keep their files open.
    let logs: FileSystemDirectoryHandle | null = null;
    try {
        logs = await root.getDirectoryHandle(LEGACY_LOGS_DIRECTORY, { create: false });
    } catch (error) {
        if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
    if (logs != null) {
        for await (const [name, handle] of logs.entries()) {
            if (handle.kind === 'directory' && isUuid(name)) await removeOpenTolerant(logs, name);
        }
    }
}

/// Remove a folder unless its lock is held.
async function removeUnlocked(parent: FileSystemDirectoryHandle, name: string, lockName: string): Promise<void> {
    const failure = await navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
        if (lock == null) return;
        try {
            await removeOpenTolerant(parent, name);
        } catch (error) {
            return { error };
        }
    });
    if (failure != null) throw failure.error;
}

/// Remove a folder, a folder with files that are still open is left for a later cleanup.
async function removeOpenTolerant(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
        await parent.removeEntry(name, { recursive: true });
    } catch (error) {
        // Browsers report locked OPFS handles with either modification error while workers terminate.
        const errorName = (error as DOMException).name;
        if (errorName !== 'InvalidModificationError' && errorName !== 'NoModificationAllowedError'
            && errorName !== 'NotFoundError') throw error;
    }
}

async function holdLock(name: string): Promise<() => void> {
    if (navigator.locks == null) return () => {};
    let acquired!: () => void;
    const acquiredLock = new Promise<void>(resolve => { acquired = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    void navigator.locks.request(name, async () => {
        acquired();
        await held;
    });
    await acquiredLock;
    return release;
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
