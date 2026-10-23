import { StorageBackendType } from './storage_backend.js';
import { type SessionLocation, displayPath } from './session_locator.js';
import { join, readDir, stat } from '../../platform/electron_fs.js';
import { isDesktopHost } from '../../platform/native_globals.js';

/// The kind of a directory entry
export enum StorageTreeEntryKind {
    File = 0,
    Directory = 1,
}

/// One entry of a listed directory. A listing carries names only, the metadata of files is fetched
/// separately for the rows that are visible.
export interface StorageTreeEntry {
    /// The name of the entry in its directory
    name: string;
    /// Is the entry a file or a directory?
    kind: StorageTreeEntryKind;
}

/// The metadata of a file
export interface StorageTreeFileStat {
    /// The size in bytes, null if the file could not be read
    sizeBytes: number | null;
    /// The last modification time in epoch ms, null if unknown
    modifiedMs: number | null;
    /// A short note shown instead of the size, e.g. for files that are held open by HyperDB
    note: string | null;
}

/// A folder the storage browser can list, e.g. the OPFS root or a native session folder
export interface StorageTreeRoot {
    /// The unique key of the root
    key: string;
    /// The label of the root
    label: string;
    /// The path of the root for display, e.g. `opfs://` or `fs:///home/me/session`
    displayPath: string;
    /// List the entries of a directory, given as path segments relative to the root
    list(path: readonly string[]): Promise<StorageTreeEntry[]>;
    /// Read the metadata of a file, given as path segments relative to the root
    stat(path: readonly string[]): Promise<StorageTreeFileStat>;
}

/// The key of the OPFS root
export const OPFS_TREE_ROOT_KEY = 'opfs';

/// Directories first, then a natural sort by name (e.g. "page-2" < "page-10")
export function sortStorageTreeEntries(entries: StorageTreeEntry[]): StorageTreeEntry[] {
    return entries.sort((a, b) => (b.kind - a.kind) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/// The Origin Private File System as a storage tree root
export function opfsTreeRoot(getRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory()): StorageTreeRoot {
    const directory = async (path: readonly string[]): Promise<FileSystemDirectoryHandle> => {
        let dir = await getRoot();
        for (const name of path) {
            dir = await dir.getDirectoryHandle(name, { create: false });
        }
        return dir;
    };
    return {
        key: OPFS_TREE_ROOT_KEY,
        label: 'Origin Private File System',
        displayPath: 'opfs://',
        async list(path) {
            const dir = await directory(path);
            const entries: StorageTreeEntry[] = [];
            for await (const [name, handle] of dir.entries()) {
                entries.push({ name, kind: handle.kind === 'directory' ? StorageTreeEntryKind.Directory : StorageTreeEntryKind.File });
            }
            return sortStorageTreeEntries(entries);
        },
        async stat(path) {
            const dir = await directory(path.slice(0, -1));
            const handle = await dir.getFileHandle(path[path.length - 1], { create: false });
            try {
                const file = await handle.getFile();
                return { sizeBytes: file.size, modifiedMs: file.lastModified, note: null };
            } catch (error) {
                // Files with an open sync access handle, e.g. the databases of a live HyperDB instance,
                // may refuse to be read.
                const name = (error as Error)?.name;
                const inUse = name === 'NoModificationAllowedError' || name === 'InvalidStateError';
                return { sizeBytes: null, modifiedMs: null, note: inUse ? 'in use' : 'unavailable' };
            }
        },
    };
}

/// A native folder as a storage tree root. Symlinks are listed as files and never followed.
export function nativeTreeRoot(dir: string, label: string, shownPath: string): StorageTreeRoot {
    return {
        key: `native:${dir}`,
        label,
        displayPath: shownPath,
        async list(path) {
            const entries = await readDir(await join(dir, ...path));
            return sortStorageTreeEntries(entries.map(entry => ({
                name: entry.name,
                kind: entry.isDirectory && !entry.isSymlink ? StorageTreeEntryKind.Directory : StorageTreeEntryKind.File,
            })));
        },
        async stat(path) {
            const value = await stat(await join(dir, ...path));
            return { sizeBytes: value.size, modifiedMs: value.mtime?.getTime() ?? null, note: null };
        },
    };
}

/// The session routing the storage browser reads its native roots from
export interface StorageTreeSessions {
    /// The user-facing session order, as session UUIDs
    getSessionOrder(): string[];
    /// The physical location of a session's files
    getSessionLocation(sessionId: string): SessionLocation;
}

/// The roots of the storage browser: the OPFS root, followed by the native session folders on desktop
export function listStorageTreeRoots(sessions: StorageTreeSessions, desktop: boolean = isDesktopHost()): StorageTreeRoot[] {
    const roots = [opfsTreeRoot()];
    if (!desktop) {
        return roots;
    }
    const seen = new Set<string>();
    for (const sessionId of sessions.getSessionOrder()) {
        const location = sessions.getSessionLocation(sessionId);
        if (location.type !== StorageBackendType.Native || !location.nativePath || seen.has(location.nativePath)) {
            continue;
        }
        seen.add(location.nativePath);
        roots.push(nativeTreeRoot(location.nativePath, sessionId, displayPath(sessionId, location)));
    }
    return roots;
}

/// A queued or running stat request
interface StatRequest {
    /// Fetch the stat
    fetch: () => Promise<StorageTreeFileStat>;
    /// The subscribers waiting for the stat
    listeners: Set<(stat: StorageTreeFileStat) => void>;
}

/// The file stats of the storage browser, fetched on demand for the visible rows.
///
/// At most `concurrency` stats are fetched at once. A queued request whose subscribers all left
/// (e.g. the row was scrolled out of view) is skipped. Fetched stats stay cached, a refresh replaces
/// the whole cache.
export class StorageTreeStatCache {
    /// The fetched stats by node key
    private readonly stats = new Map<string, StorageTreeFileStat>();
    /// The queued and running requests by node key
    private readonly requests = new Map<string, StatRequest>();
    /// The node keys of the queued requests
    private readonly queue: string[] = [];
    /// The number of running requests
    private running = 0;

    constructor(private readonly concurrency: number = 4) {}

    /// The cached stat of a file
    get(key: string): StorageTreeFileStat | undefined {
        return this.stats.get(key);
    }

    /// Subscribe to the stat of a file, fetching it unless it is cached. Returns the unsubscribe function.
    subscribe(key: string, fetch: () => Promise<StorageTreeFileStat>, listener: (stat: StorageTreeFileStat) => void): () => void {
        if (this.stats.has(key)) {
            return () => {};
        }
        let request = this.requests.get(key);
        if (request == null) {
            request = { fetch, listeners: new Set() };
            this.requests.set(key, request);
            this.queue.push(key);
        }
        const listeners = request.listeners;
        listeners.add(listener);
        this.pump();
        return () => {
            listeners.delete(listener);
        };
    }

    /// Start queued requests up to the concurrency limit
    private pump(): void {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const key = this.queue.shift()!;
            const request = this.requests.get(key)!;
            if (request.listeners.size === 0) {
                this.requests.delete(key);
                continue;
            }
            ++this.running;
            void request.fetch()
                .catch((): StorageTreeFileStat => ({ sizeBytes: null, modifiedMs: null, note: 'unavailable' }))
                .then(stat => {
                    this.stats.set(key, stat);
                    this.requests.delete(key);
                    for (const listener of request.listeners) {
                        listener(stat);
                    }
                })
                .finally(() => {
                    --this.running;
                    this.pump();
                });
        }
    }
}
