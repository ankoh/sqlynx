/// Shared in-memory filesystem backing the Electron filesystem mock used by the storage tests.
///
/// `native_storage_backend.test.ts` and `composite_storage_backend.test.ts` both exercise the *real*
/// `NativeStorageBackend` against a mocked Electron bridge. Keeping the mock implementation here
/// ensures both tests model the filesystem consistently. Each test file receives an isolated module
/// instance, and resets its store in `beforeEach`.
export interface FsStore {
    files: Map<string, string>;
    /// Binary files written via `writeFile` / read via `readFile` (e.g. the `.arrow` cache entries),
    /// kept separate from the text `files` map so each mock method touches only its own kind.
    binFiles: Map<string, Uint8Array>;
    dirs: Set<string>;
    /// Per-path last-modified time in epoch ms, stamped on every write. Backs the `stat().mtime` the
    /// cache eviction policy sorts on. Uses a monotonic counter (not wall-clock) so write order is
    /// deterministic across test runs.
    mtimes: Map<string, number>;
    /// Monotonic clock feeding `mtimes`; bumped on each write.
    clock: number;
}

/// Store shared by the test and its dynamic `vi.mock` factory within one isolated test context.
export const fsStore: FsStore = {
    files: new Map<string, string>(),
    binFiles: new Map<string, Uint8Array>(),
    dirs: new Set<string>(),
    mtimes: new Map<string, number>(),
    clock: 0,
};

/// Reset the shared store. Call from `beforeEach`.
export function resetFsStore(): void {
    fsStore.files.clear();
    fsStore.binFiles.clear();
    fsStore.dirs.clear();
    fsStore.mtimes.clear();
    fsStore.clock = 0;
}

/// Build the Electron filesystem mock object over the shared store.
export function makeFsMock() {
    const { files, binFiles, dirs, mtimes } = fsStore;
    const nextMtime = () => ++fsStore.clock;
    const parentOf = (p: string) => {
        const i = p.lastIndexOf('/');
        return i < 0 ? '' : p.substring(0, i);
    };
    const nameOf = (p: string) => {
        const i = p.lastIndexOf('/');
        return i < 0 ? p : p.substring(i + 1);
    };
    const isAncestorDir = (p: string) => {
        for (const f of files.keys()) if (f.startsWith(p + '/')) return true;
        for (const f of binFiles.keys()) if (f.startsWith(p + '/')) return true;
        for (const d of dirs) if (d.startsWith(p + '/')) return true;
        return false;
    };
    return {
        exists: async (p: string) => files.has(p) || binFiles.has(p) || dirs.has(p) || isAncestorDir(p),
        mkdir: async (p: string) => {
            // Register the dir and all ancestors, preserving any leading slash (absolute paths)
            // the same way writeTextFile's parent walk does.
            dirs.add(p);
            let parent = parentOf(p);
            while (parent) {
                dirs.add(parent);
                parent = parentOf(parent);
            }
        },
        readDir: async (p: string) => {
            const children = new Map<string, { isFile: boolean; isDirectory: boolean }>();
            for (const f of files.keys()) {
                if (parentOf(f) === p) children.set(nameOf(f), { isFile: true, isDirectory: false });
            }
            for (const f of binFiles.keys()) {
                if (parentOf(f) === p) children.set(nameOf(f), { isFile: true, isDirectory: false });
            }
            for (const d of dirs) {
                if (parentOf(d) === p) children.set(nameOf(d), { isFile: false, isDirectory: true });
            }
            return [...children.entries()].map(([name, kind]) => ({
                name,
                isFile: kind.isFile,
                isDirectory: kind.isDirectory,
                isSymlink: false,
            }));
        },
        readTextFile: async (p: string) => {
            if (!files.has(p)) {
                throw new Error(`File not found: ${p}`);
            }
            return files.get(p)!;
        },
        writeTextFile: async (p: string, data: string) => {
            files.set(p, data);
            mtimes.set(p, nextMtime());
            let parent = parentOf(p);
            while (parent) {
                dirs.add(parent);
                parent = parentOf(parent);
            }
        },
        readFile: async (p: string) => {
            if (!binFiles.has(p)) {
                throw new Error(`File not found: ${p}`);
            }
            return binFiles.get(p)!;
        },
        writeFile: async (p: string, data: Uint8Array) => {
            // Copy so a later mutation of the caller's buffer can't retroactively change stored bytes.
            binFiles.set(p, new Uint8Array(data));
            mtimes.set(p, nextMtime());
            let parent = parentOf(p);
            while (parent) {
                dirs.add(parent);
                parent = parentOf(parent);
            }
        },
        stat: async (p: string) => {
            const size = binFiles.has(p) ? binFiles.get(p)!.byteLength
                : files.has(p) ? files.get(p)!.length
                    : 0;
            if (!binFiles.has(p) && !files.has(p)) {
                throw new Error(`File not found: ${p}`);
            }
            return {
                size,
                mtime: new Date(mtimes.get(p) ?? 0),
                isFile: true,
                isDirectory: false,
                isSymlink: false,
            };
        },
        remove: async (p: string, opts?: { recursive?: boolean }) => {
            files.delete(p);
            binFiles.delete(p);
            mtimes.delete(p);
            dirs.delete(p);
            if (opts?.recursive) {
                for (const f of [...files.keys()]) if (f.startsWith(p + '/')) { files.delete(f); mtimes.delete(f); }
                for (const f of [...binFiles.keys()]) if (f.startsWith(p + '/')) { binFiles.delete(f); mtimes.delete(f); }
                for (const d of [...dirs]) if (d.startsWith(p + '/')) dirs.delete(d);
            }
        },
        rename: async (from: string, to: string) => {
            // Move a file or a whole directory subtree, re-keying every path prefixed by `from`.
            // Mirrors the host filesystem's atomic rename.
            const reKey = (k: string) => (k === from ? to : k.startsWith(from + '/') ? to + k.substring(from.length) : null);
            for (const [k, v] of [...files.entries()]) {
                const nk = reKey(k);
                if (nk !== null) {
                    files.delete(k);
                    files.set(nk, v);
                    const mt = mtimes.get(k);
                    if (mt !== undefined) { mtimes.delete(k); mtimes.set(nk, mt); }
                }
            }
            for (const [k, v] of [...binFiles.entries()]) {
                const nk = reKey(k);
                if (nk !== null) {
                    binFiles.delete(k);
                    binFiles.set(nk, v);
                    const mt = mtimes.get(k);
                    if (mt !== undefined) { mtimes.delete(k); mtimes.set(nk, mt); }
                }
            }
            for (const d of [...dirs]) {
                const nd = reKey(d);
                if (nd !== null) {
                    dirs.delete(d);
                    dirs.add(nd);
                }
            }
            let parent = parentOf(to);
            while (parent) {
                dirs.add(parent);
                parent = parentOf(parent);
            }
        },
    };
}

/// Build the path mock object. Tests use "/" separators for simplicity.
export function makePathMock() {
    return {
        join: async (...parts: string[]) => parts.filter(p => p.length > 0).join('/'),
    };
}
