import {
    STORAGE_ATTACHMENTS_FOLDER,
    STORAGE_CACHE_FOLDER,
    STORAGE_CONNECTIONS_FOLDER,
    STORAGE_MANIFEST_FILE,
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_SESSION_FILE,
    STORAGE_SESSIONS_FOLDER,
    STORAGE_SHELL_FOLDER,
    StorageBackendType,
} from './storage_backend.js';
import { OPFS_MANIFEST_LOCK } from './opfs_storage_backend.js';
import { type ManifestJson, readManifestJson } from '../../migration/storage_root.js';
import { SHELL_FILES_DIRECTORY } from '../../platform/hyperdb/hyperdb_opfs.js';
import {
    HYPER_INSTANCE_LOCK_PREFIX,
    HYPER_INSTANCES_DIRECTORY,
    HYPER_LEGACY_INSTANCE_PREFIX,
    HYPER_LEGACY_LOGS_DIRECTORY,
    isUuid,
} from '../../platform/hyperdb/hyperdb_opfs_instance.js';
import { PARQUET_EXPORT_DIRECTORY } from '../../platform/hyperdb/hyperdb_parquet_export.js';

/// An OPFS entry that the current app version doesn't use
export interface OPFSCleanupCandidate {
    /// The path segments from the OPFS root
    path: string[];
    /// Is the entry a directory?
    directory: boolean;
    /// Why the entry can be deleted
    reason: string;
    /// The registration that would make the entry used again, checked again before the entry is deleted
    guard: { sessionId: string } | { connectionId: string } | null;
    /// The Web Lock that marks the entry as in use, the entry is only deleted while the lock is free
    lockName: string | null;
}

/// The outcome of a cleanup
export interface OPFSCleanupResult {
    /// The number of deleted entries
    removed: number;
    /// The entries that were kept
    skipped: { path: string; reason: string }[];
}

/// The sessions and connections that the manifest registers, with lower-case ids
interface Registrations {
    /// The sessions that live in OPFS
    opfsSessions: Set<string>;
    /// The sessions that live in a native folder, OPFS keeps a mirror of their attachments
    nativeSessions: Set<string>;
    /// The connections
    connections: Set<string>;
}

/// Read the registrations of the manifest, null without a manifest
function readRegistrations(manifest: ManifestJson | null): Registrations | null {
    if (manifest == null) return null;
    const registrations: Registrations = { opfsSessions: new Set(), nativeSessions: new Set(), connections: new Set() };
    for (const entry of Array.isArray(manifest.sessions) ? manifest.sessions as unknown[] : []) {
        const { path, storageType } = (entry ?? {}) as { path?: unknown; storageType?: unknown };
        if (typeof path !== 'string') continue;
        (storageType === StorageBackendType.Native ? registrations.nativeSessions : registrations.opfsSessions).add(path.toLowerCase());
    }
    for (const entry of Array.isArray(manifest.connections) ? manifest.connections as unknown[] : []) {
        const { id } = (entry ?? {}) as { id?: unknown };
        if (typeof id === 'string') registrations.connections.add(id.toLowerCase());
    }
    return registrations;
}

/// Is the guarded registration in the manifest? Without a manifest every guarded entry counts as registered.
function isRegistered(guard: OPFSCleanupCandidate['guard'], registrations: Registrations | null): boolean {
    if (guard == null) return false;
    if (registrations == null) return true;
    if ('sessionId' in guard) {
        const id = guard.sessionId.toLowerCase();
        return registrations.opfsSessions.has(id) || registrations.nativeSessions.has(id);
    }
    return registrations.connections.has(guard.connectionId.toLowerCase());
}

/// The entries of a session folder in OPFS. The folder of a native session only mirrors its attachments.
const OPFS_SESSION_ENTRIES = new Map<string, boolean>([
    [STORAGE_SESSION_FILE, false],
    [STORAGE_SCRIPTS_FOLDER, true],
    [STORAGE_ATTACHMENTS_FOLDER, true],
    [STORAGE_CACHE_FOLDER, true],
]);
const NATIVE_SESSION_ENTRIES = new Map<string, boolean>([[STORAGE_ATTACHMENTS_FOLDER, true]]);

const UNUSED = 'Not used by this version of DashQL';

/// Find the OPFS entries that the current app version doesn't use.
///
/// The scan compares the OPFS root against the current layout: the manifest, the registered sessions
/// and connections, the shell folders, the instance folders of open app windows and the Parquet
/// exports. Everything else was left by earlier app versions, by interrupted operations or by sessions
/// and connections that are gone. The scan reads directory listings only, it never reads files besides
/// the manifest and only descends into the folders it knows.
export async function findOPFSCleanupCandidates(
    root: FileSystemDirectoryHandle,
    locks: LockManager | null = navigator.locks ?? null,
): Promise<OPFSCleanupCandidate[]> {
    // Without a manifest there is no telling which sessions and connections are registered, they are left alone
    const registrations = readRegistrations(await readManifestJson(root));
    // Without Web Locks there is no telling which instance folders are alive, they are left alone
    const heldLocks = locks == null ? null : new Set(((await locks.query()).held ?? []).map(lock => lock.name));
    const candidates: OPFSCleanupCandidate[] = [];
    const add = (path: string[], directory: boolean, reason: string, guard: OPFSCleanupCandidate['guard'] = null, lockName: string | null = null) => {
        candidates.push({ path, directory, reason, guard, lockName });
    };

    for await (const [name, handle] of root.entries()) {
        const directory = handle.kind === 'directory';
        if (name === STORAGE_MANIFEST_FILE && !directory) continue;
        if (!directory) {
            add([name], false, UNUSED);
            continue;
        }
        const dir = handle as FileSystemDirectoryHandle;
        switch (name) {
            case STORAGE_SESSIONS_FOLDER:
                if (registrations != null) await scanSessions(dir, registrations, add);
                break;
            case STORAGE_CONNECTIONS_FOLDER:
                if (registrations == null) break;
                for await (const [id, child] of dir.entries()) {
                    if (child.kind !== 'directory') add([name, id], false, UNUSED);
                    else if (!registrations.connections.has(id.toLowerCase())) add([name, id], true, 'Connection that is not registered', { connectionId: id });
                }
                break;
            case HYPER_INSTANCES_DIRECTORY:
                if (heldLocks == null) break;
                for await (const [id, child] of dir.entries()) {
                    const lockName = `${HYPER_INSTANCE_LOCK_PREFIX}${id}`;
                    if (child.kind !== 'directory' || !isUuid(id)) add([name, id], child.kind === 'directory', UNUSED);
                    else if (!heldLocks.has(lockName)) add([name, id], true, 'Database of a closed app window', null, lockName);
                }
                break;
            case PARQUET_EXPORT_DIRECTORY:
                for await (const [id, child] of dir.entries()) {
                    add([name, id], child.kind === 'directory', 'Leftover of an interrupted Parquet export');
                }
                break;
            case STORAGE_SHELL_FOLDER:
            case SHELL_FILES_DIRECTORY:
                break;
            case HYPER_LEGACY_LOGS_DIRECTORY:
                add([name], true, 'Hyper logs of an earlier version');
                break;
            default:
                if (name.startsWith(HYPER_LEGACY_INSTANCE_PREFIX) && isUuid(name.slice(HYPER_LEGACY_INSTANCE_PREFIX.length))) {
                    if (heldLocks != null && !heldLocks.has(name)) add([name], true, 'Database of an earlier version', null, name);
                } else {
                    add([name], true, UNUSED);
                }
        }
    }
    return candidates.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true }));
}

/// Scan the session folders against the registered sessions
async function scanSessions(
    sessions: FileSystemDirectoryHandle,
    registrations: Registrations,
    add: (path: string[], directory: boolean, reason: string, guard?: OPFSCleanupCandidate['guard']) => void,
): Promise<void> {
    for await (const [id, handle] of sessions.entries()) {
        const path = [STORAGE_SESSIONS_FOLDER, id];
        if (handle.kind !== 'directory') {
            add(path, false, UNUSED);
            continue;
        }
        const key = id.toLowerCase();
        const native = registrations.nativeSessions.has(key);
        if (!native && !registrations.opfsSessions.has(key)) {
            add(path, true, 'Session that is not registered', { sessionId: id });
            continue;
        }
        const expected = native ? NATIVE_SESSION_ENTRIES : OPFS_SESSION_ENTRIES;
        for await (const [name, child] of (handle as FileSystemDirectoryHandle).entries()) {
            const directory = child.kind === 'directory';
            if (expected.get(name) !== directory) {
                add([...path, name], directory, native ? 'Left behind when the session moved to a folder' : 'Not part of the current session layout');
            } else if (name === STORAGE_SCRIPTS_FOLDER) {
                // Scripts are flat files, script folders are pages of an earlier version
                for await (const [script, entry] of (child as FileSystemDirectoryHandle).entries()) {
                    if (entry.kind === 'directory') add([...path, name, script], true, 'Script folder of an earlier version');
                }
            }
        }
    }
}

/// Delete cleanup candidates.
///
/// The deletion holds the manifest lock and reads the manifest again, a candidate whose session or
/// connection was registered in the meantime is kept. A candidate with a lock is only deleted while
/// its lock is free, and files that are still open are kept.
export async function removeOPFSCleanupCandidates(
    root: FileSystemDirectoryHandle,
    candidates: readonly OPFSCleanupCandidate[],
    locks: LockManager | null = navigator.locks ?? null,
): Promise<OPFSCleanupResult> {
    const run = async (): Promise<OPFSCleanupResult> => {
        const registrations = readRegistrations(await readManifestJson(root));
        const result: OPFSCleanupResult = { removed: 0, skipped: [] };
        for (const candidate of candidates) {
            const path = candidate.path.join('/');
            if (isRegistered(candidate.guard, registrations)) {
                result.skipped.push({ path, reason: 'registered again' });
                continue;
            }
            const failure = candidate.lockName != null && locks != null
                ? await locks.request(candidate.lockName, { ifAvailable: true }, lock => lock == null ? 'in use' : removeEntry(root, candidate))
                : await removeEntry(root, candidate);
            if (failure == null) ++result.removed;
            else result.skipped.push({ path, reason: failure });
        }
        return result;
    };
    return locks != null ? await locks.request(OPFS_MANIFEST_LOCK, run) : await run();
}

/// Remove an entry, returns why it was kept or null
async function removeEntry(root: FileSystemDirectoryHandle, candidate: OPFSCleanupCandidate): Promise<string | null> {
    try {
        let parent = root;
        for (const name of candidate.path.slice(0, -1)) {
            parent = await parent.getDirectoryHandle(name, { create: false });
        }
        await parent.removeEntry(candidate.path[candidate.path.length - 1], { recursive: candidate.directory });
        return null;
    } catch (error) {
        const name = (error as DOMException)?.name;
        if (name === 'NotFoundError') return null;
        // Browsers report files that are still open with either modification error
        if (name === 'NoModificationAllowedError' || name === 'InvalidModificationError') return 'in use';
        return (error as Error)?.message ?? String(error);
    }
}
