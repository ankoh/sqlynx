import { type SessionRegistryBackend, type ConnectionEntry, STORAGE_CONNECTIONS_FOLDER, type SessionData, type ScriptData, type SessionEntry, type StorageManifest, type AppSettings, type CachedQueryResult, StorageBackendType, STORAGE_MANIFEST_FILE, LEGACY_STORAGE_SESSIONS_FOLDER, STORAGE_SESSIONS_FOLDER, STORAGE_SESSION_FILE, STORAGE_SESSION_INDEX_FILE, STORAGE_SCRIPTS_FOLDER, STORAGE_CATALOG_RELATIONS, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_CHANGES, STORAGE_CACHE_FOLDER, STORAGE_CACHE_EXTENSION, STORAGE_CACHE_ACCESS_SUFFIX, STORAGE_SHELL_FOLDER } from './storage_backend.js';
import { type CacheFileStat, type QueryResultCacheStore, evictToFit } from './query_result_cache_eviction.js';
import { serializeSessionIndex } from './session_index.js';
import { migrateSessionData, migrateSessionFiles, SESSION_FILE_RENAMES, type SessionFileRename } from './session_file_migration.js';
import { type DataFile, type DataFileContent, STORAGE_ATTACHMENTS_FOLDER, validateDataFileName } from './storage_backend.js';

/// The name of the web lock that guards the manifest
const OPFS_MANIFEST_LOCK = 'dashql-manifest';
/// The manifest key that listed the sessions when sessions were called notebooks
const LEGACY_MANIFEST_SESSIONS_KEY = 'notebooks';

/// Copy the files and folders of a directory into another one, existing files are overwritten.
/// OPFS cannot move directories everywhere, the content is copied.
async function copyDirectory(from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle): Promise<void> {
    for await (const [name, handle] of from.entries()) {
        if (handle.kind === 'directory') {
            await copyDirectory(handle as FileSystemDirectoryHandle, await to.getDirectoryHandle(name, { create: true }));
        } else {
            const content = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
            const writable = await (await to.getFileHandle(name, { create: true })).createWritable();
            await writable.write(content);
            await writable.close();
        }
    }
}

/// Origin Private File System storage backend.
///
/// This backend owns the session registry (the root manifest), which lists *every* session
/// regardless of where its files physically live. Sessions stored in OPFS keep their files under
/// `sessions/<uuid>/…`; sessions relocated to a native directory keep only a registry entry here
/// (their files live on disk, managed by `NativeStorageBackend`).
///
/// Every per-session method is keyed by the bare session UUID.
export class OPFSStorageBackend implements SessionRegistryBackend {
    private rootHandle: FileSystemDirectoryHandle | null = null;
    /// The renames that bring a session folder to the current file layout
    private readonly fileRenames: readonly SessionFileRename[];
    /// The sessions whose files were migrated by this backend
    private readonly migratedSessions = new Set<string>();
    /// The latest manifest mutation, every read-modify-write of the manifest chains onto it
    private manifestChain: Promise<void> = Promise.resolve();

    constructor(fileRenames: readonly SessionFileRename[] = SESSION_FILE_RENAMES) {
        this.fileRenames = fileRenames;
    }

    getBackendType(): StorageBackendType {
        return StorageBackendType.OPFS;
    }

    async initialize(): Promise<void> {
        this.rootHandle = await navigator.storage.getDirectory();
        await this.migrateLegacyLayout(this.rootHandle);
    }

    /// Bring an OPFS root of the time when sessions were called notebooks to the current layout.
    ///
    /// The session folders move from `notebooks/<uuid>` to `sessions/<uuid>` and the manifest lists
    /// them as `sessions` instead of `notebooks`. The files inside a folder are renamed when the
    /// session is loaded. A legacy folder is removed only after it was copied completely and the
    /// manifest is rewritten last, so an interrupted migration simply runs again.
    private async migrateLegacyLayout(root: FileSystemDirectoryHandle): Promise<void> {
        await this.withManifestLock(async () => {
            await this.migrateLegacySessionFolders(root);
            let manifest: Record<string, unknown>;
            try {
                const file = await (await root.getFileHandle(STORAGE_MANIFEST_FILE, { create: false })).getFile();
                manifest = JSON.parse(await file.text());
            } catch (error) {
                if ((error as any).name === 'NotFoundError') {
                    return;
                }
                throw error;
            }
            if (Array.isArray(manifest?.[LEGACY_MANIFEST_SESSIONS_KEY]) && !Array.isArray(manifest.sessions)) {
                const { [LEGACY_MANIFEST_SESSIONS_KEY]: sessions, ...rest } = manifest;
                await this.writeManifest(root, { sessions, ...rest } as StorageManifest);
            }
        });
    }

    /// Move the session folders from `notebooks/<uuid>` to `sessions/<uuid>`
    private async migrateLegacySessionFolders(root: FileSystemDirectoryHandle): Promise<void> {
        let legacyFolder: FileSystemDirectoryHandle;
        try {
            legacyFolder = await root.getDirectoryHandle(LEGACY_STORAGE_SESSIONS_FOLDER, { create: false });
        } catch (error) {
            if ((error as any).name === 'NotFoundError') {
                return;
            }
            throw error;
        }
        const sessionsFolder = await root.getDirectoryHandle(STORAGE_SESSIONS_FOLDER, { create: true });
        const sessionIds: string[] = [];
        for await (const [name, handle] of legacyFolder.entries()) {
            if (handle.kind === 'directory') {
                sessionIds.push(name);
            }
        }
        for (const sessionId of sessionIds) {
            const source = await legacyFolder.getDirectoryHandle(sessionId, { create: false });
            await copyDirectory(source, await sessionsFolder.getDirectoryHandle(sessionId, { create: true }));
            await legacyFolder.removeEntry(sessionId, { recursive: true });
        }
        await root.removeEntry(LEGACY_STORAGE_SESSIONS_FOLDER, { recursive: true });
    }

    /// Run a manifest operation exclusively.
    ///
    /// Every write of the manifest is a read-modify-write, so concurrent writers (session registry
    /// updates, app settings, connections) would otherwise lose each other's updates. The chain
    /// serializes the writers of this backend, the web lock serializes them across tabs that share
    /// the same OPFS root.
    private withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
        const run = locks != null ? () => locks.request(OPFS_MANIFEST_LOCK, fn) : fn;
        const result = this.manifestChain.then(run, run);
        this.manifestChain = result.then(() => { }, () => { });
        return result;
    }

    /// Mutate the manifest exclusively. The mutation returns false when nothing changed.
    private mutateManifest(fn: (manifest: StorageManifest) => boolean | void): Promise<void> {
        return this.withManifestLock(async () => {
            const root = this.ensureInitialized();
            const manifest = await this.readManifest(root);
            if (fn(manifest) === false) {
                return;
            }
            await this.writeManifest(root, manifest);
        });
    }

    private ensureInitialized(): FileSystemDirectoryHandle {
        if (!this.rootHandle) {
            throw new Error('OPFSStorageBackend not initialized. Call initialize() first.');
        }
        return this.rootHandle;
    }

    /// The relative folder that holds a session's files, e.g. "sessions/<uuid>"
    private sessionRelPath(sessionId: string): string {
        return `${STORAGE_SESSIONS_FOLDER}/${sessionId}`;
    }

    /// Natural sort for strings with numeric components (e.g., "page-1" < "page-2" < "page-10")
    private naturalSort(a: string, b: string): number {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    }

    async listSessions(manifestPath: string): Promise<SessionEntry[]> {
        const root = this.ensureInitialized();
        try {
            const indexFile = await root.getFileHandle(manifestPath, { create: false });
            const file = await indexFile.getFile();
            const text = await file.text();
            const manifest: StorageManifest = JSON.parse(text);

            if (!manifest.sessions || !Array.isArray(manifest.sessions)) {
                throw new Error('Invalid manifest format: sessions must be an array');
            }

            // Validate entries
            for (const entry of manifest.sessions) {
                if (!entry.path) {
                    throw new Error('Invalid manifest format: each session must have path');
                }
            }

            return manifest.sessions;
        } catch (error) {
            // If file doesn't exist, return empty array
            if ((error as any).name === 'NotFoundError') {
                return [];
            }
            // Re-throw other errors (including validation errors)
            throw error;
        }
    }

    /// Bring the files of a session to the current layout, once per session
    private async migrateSessionFiles(sessionId: string, sessionDir: FileSystemDirectoryHandle): Promise<void> {
        if (this.migratedSessions.has(sessionId)) return;
        await migrateSessionFiles({
            exists: async name => {
                try {
                    await sessionDir.getFileHandle(name, { create: false });
                    return true;
                } catch {
                    return false;
                }
            },
            // OPFS cannot rename files everywhere, the content is copied
            rename: async (from, to) => {
                const content = await (await (await sessionDir.getFileHandle(from)).getFile()).arrayBuffer();
                const writable = await (await sessionDir.getFileHandle(to, { create: true })).createWritable();
                await writable.write(content);
                await writable.close();
                await sessionDir.removeEntry(from);
            },
        }, this.fileRenames);
        this.migratedSessions.add(sessionId);
    }

    async loadSession(sessionId: string): Promise<SessionData> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
        await this.migrateSessionFiles(sessionId, sessionDir);
        const metaFile = await sessionDir.getFileHandle(STORAGE_SESSION_FILE);
        const file = await metaFile.getFile();
        const text = await file.text();
        const data: SessionData = migrateSessionData(JSON.parse(text));

        // sessionId is required - will throw if missing
        if (!data.sessionId) {
            throw new Error(`Session ${sessionId} is missing required sessionId field. Please migrate the session or regenerate it.`);
        }

        return data;
    }

    async saveSessionManifest(sessionId: string, data: SessionData): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), true);
        const metaFile = await sessionDir.getFileHandle(STORAGE_SESSION_FILE, { create: true });
        const writable = await metaFile.createWritable();
        await writable.write(JSON.stringify(data, null, 2));
        await writable.close();

        await this.upsertSessionEntry({ path: sessionId, storageType: StorageBackendType.OPFS });
        await this.regenerateSessionIndex(sessionId);
    }

    async regenerateSessionIndex(sessionId: string): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), true);
        const indexFile = await sessionDir.getFileHandle(STORAGE_SESSION_INDEX_FILE, { create: true });
        const writable = await indexFile.createWritable();
        await writable.write(serializeSessionIndex(await this.loadScripts(sessionId), await this.listDataFiles(sessionId)));
        await writable.close();
    }

    async ensureSessionIndex(sessionId: string): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
        try {
            await sessionDir.getFileHandle(STORAGE_SESSION_INDEX_FILE, { create: false });
        } catch (error) {
            if ((error as any).name !== 'NotFoundError') throw error;
            await this.regenerateSessionIndex(sessionId);
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.deleteSessionFiles(sessionId);
        // Always try to update the manifest even if the session files weren't found
        // (in case the manifest still has a stale reference).
        await this.removeSessionEntry(sessionId);
    }

    /// Delete a session's files only, leaving the registry entry intact.
    async deleteSessionFiles(sessionId: string): Promise<void> {
        const relativePath = this.sessionRelPath(sessionId);
        const root = this.ensureInitialized();

        try {
            // Navigate to the parent directory, then remove the session entry
            const parts = relativePath.split('/').filter(p => p);
            if (parts.length > 0) {
                let parentDir: FileSystemDirectoryHandle = root;
                for (let i = 0; i < parts.length - 1; i++) {
                    parentDir = await parentDir.getDirectoryHandle(parts[i], { create: false });
                }
                await parentDir.removeEntry(parts[parts.length - 1], { recursive: true });
            }
        } catch (error) {
            // If sessions folder or session doesn't exist, that's fine - it's already deleted
            if ((error as any).name !== 'NotFoundError') {
                throw error;
            }
        }
    }

    async loadSessionSchema(sessionId: string): Promise<string | null> {
        try {
            const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
            const schemaFile = await sessionDir.getFileHandle(STORAGE_CATALOG_RELATIONS, { create: false });
            const file = await schemaFile.getFile();
            return await file.text();
        } catch {
            return null;
        }
    }

    async saveSessionSchema(sessionId: string, sql: string): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), true);
        const schemaFile = await sessionDir.getFileHandle(STORAGE_CATALOG_RELATIONS, { create: true });
        const writable = await schemaFile.createWritable();
        await writable.write(sql);
        await writable.close();
    }

    async loadSessionCatalogChanges(sessionId: string): Promise<string | null> {
        try {
            const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
            const changesFile = await sessionDir.getFileHandle(STORAGE_CATALOG_CHANGES, { create: false });
            const file = await changesFile.getFile();
            return await file.text();
        } catch {
            return null;
        }
    }

    async saveSessionCatalogChanges(sessionId: string, sql: string): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), true);
        const changesFile = await sessionDir.getFileHandle(STORAGE_CATALOG_CHANGES, { create: true });
        const writable = await changesFile.createWritable();
        await writable.write(sql);
        await writable.close();
    }

    async loadSessionFunctions(sessionId: string): Promise<string | null> {
        try {
            const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
            const functionsFile = await sessionDir.getFileHandle(STORAGE_CATALOG_FUNCTIONS, { create: false });
            const file = await functionsFile.getFile();
            return await file.text();
        } catch {
            return null;
        }
    }

    async saveSessionFunctions(sessionId: string, sql: string): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), true);
        const functionsFile = await sessionDir.getFileHandle(STORAGE_CATALOG_FUNCTIONS, { create: true });
        const writable = await functionsFile.createWritable();
        await writable.write(sql);
        await writable.close();
    }

    async loadScripts(sessionId: string): Promise<ScriptData[]> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false).catch((error) => {
            if ((error as any).name === 'NotFoundError') return null;
            throw error;
        });
        if (!sessionDir) {
            return [];
        }
        let scriptsDir: FileSystemDirectoryHandle;
        try {
            scriptsDir = await sessionDir.getDirectoryHandle(STORAGE_SCRIPTS_FOLDER, { create: false });
        } catch (error) {
            if ((error as any).name === 'NotFoundError') {
                return [];
            }
            throw error;
        }
        const scripts: ScriptData[] = [];

        for await (const [name, handle] of scriptsDir.entries()) {
            if (handle.kind === 'directory') {
                throw new Error(`Invalid V2 session layout: nested scripts directory ${name}`);
            }
            if (name.toLowerCase() === 'dashql-draft.sql') {
                throw new Error('Invalid V2 session layout: dashql-draft.sql is not supported');
            }
            if (handle.kind === 'file' && name.toLowerCase().endsWith('.sql')) {
                const file = await (handle as FileSystemFileHandle).getFile();
                scripts.push({ name, sql: await file.text() });
            }
        }
        scripts.sort((a, b) => this.naturalSort(a.name, b.name));
        return scripts;
    }

    /// Move a single file between (or within) OPFS directories, preserving its contents byte-for-byte.
    ///
    /// Prefers the non-standard `FileSystemFileHandle.move()` (Chromium) for a true in-place move, and
    /// falls back to copy-then-delete where it is unavailable (Safari/Firefox). The same-directory case
    /// (`srcDir === destDir`) is a pure rename.
    private async moveFile(
        srcDir: FileSystemDirectoryHandle,
        srcName: string,
        destDir: FileSystemDirectoryHandle,
        destName: string,
    ): Promise<void> {
        if (srcDir === destDir && srcName === destName) {
            return;
        }
        const srcHandle = await srcDir.getFileHandle(srcName, { create: false });
        const move = (srcHandle as any).move as ((...args: any[]) => Promise<void>) | undefined;
        if (typeof move === 'function') {
            // move(name) renames in place; move(destDir, name) relocates across directories.
            await (srcDir === destDir ? move.call(srcHandle, destName) : move.call(srcHandle, destDir, destName));
            return;
        }
        // Fallback: stream the source File (a Blob, so this is binary-safe) into the new handle, then
        // drop the original.
        const file = await srcHandle.getFile();
        const destHandle = await destDir.getFileHandle(destName, { create: true });
        const writable = await destHandle.createWritable();
        await writable.write(file);
        await writable.close();
        await srcDir.removeEntry(srcName);
    }


    async loadScript(sessionId: string, scriptName: string): Promise<ScriptData> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
        const scriptsDir = await sessionDir.getDirectoryHandle(STORAGE_SCRIPTS_FOLDER, { create: false });

        try {
            const fileHandle = await scriptsDir.getFileHandle(scriptName);
            const file = await fileHandle.getFile();
            const sql = await file.text();
            return { name: scriptName, sql };
        } catch {
            throw new Error(`Script not found: session ${sessionId}, script ${scriptName}`);
        }
    }

    async saveScript(
        sessionId: string,
        scriptName: string,
        sql: string
    ): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), true);
        const scriptsDir = await sessionDir.getDirectoryHandle(STORAGE_SCRIPTS_FOLDER, { create: true });
        let isNew = false;
        try {
            await scriptsDir.getFileHandle(scriptName, { create: false });
        } catch (error) {
            if ((error as any).name !== 'NotFoundError') throw error;
            isNew = true;
        }
        const fileHandle = await scriptsDir.getFileHandle(scriptName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(sql);
        await writable.close();
        if (isNew) {
            await this.regenerateSessionIndex(sessionId);
        }
    }

    async deleteScript(sessionId: string, scriptName: string): Promise<void> {
        const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
        const scriptsDir = await sessionDir.getDirectoryHandle(STORAGE_SCRIPTS_FOLDER, { create: false });
        await scriptsDir.removeEntry(scriptName);
        await this.regenerateSessionIndex(sessionId);
    }

    async renameScript(sessionId: string, oldScriptName: string, newScriptName: string): Promise<void> {
        if (oldScriptName === newScriptName) {
            return;
        }
        // Navigate without creating anything: if the session, page, or source file isn't flushed yet,
        // the pending write under the new name creates them, so there is nothing to move. The
        // scripts/folder/file handles surface a raw OPFS NotFoundError, but getSessionDir re-wraps that
        // into a generic "Directory not found" Error, so the no-op guard has to recognise both forms.
        let scriptsDir: FileSystemDirectoryHandle;
        try {
            const sessionDir = await this.getSessionDir(this.sessionRelPath(sessionId), false);
            scriptsDir = await sessionDir.getDirectoryHandle(STORAGE_SCRIPTS_FOLDER, { create: false });
            await scriptsDir.getFileHandle(oldScriptName, { create: false });
        } catch (error) {
            if ((error as any).name === 'NotFoundError' || ((error as any).message ?? '').startsWith('Directory not found')) {
                return;
            }
            throw error;
        }
        await this.moveFile(scriptsDir, oldScriptName, scriptsDir, newScriptName);
        await this.regenerateSessionIndex(sessionId);
    }

    /// The relative folder that holds a session's cached query results, e.g. "sessions/<uuid>/cache"
    private cacheRelPath(sessionId: string): string {
        return `${this.sessionRelPath(sessionId)}/${STORAGE_CACHE_FOLDER}`;
    }

    private async dataDir(sessionId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
        const root = this.ensureInitialized();
        try {
            const sessions = await root.getDirectoryHandle(STORAGE_SESSIONS_FOLDER, { create });
            const session = await sessions.getDirectoryHandle(sessionId, { create });
            return await session.getDirectoryHandle(STORAGE_ATTACHMENTS_FOLDER, { create });
        } catch (error) {
            if (!create && (error as Error).name === 'NotFoundError') return null;
            throw error;
        }
    }

    async listDataFiles(sessionId: string): Promise<DataFile[]> {
        const dir = await this.dataDir(sessionId, false);
        if (!dir) return [];
        const files: DataFile[] = [];
        for await (const [name, handle] of dir.entries()) {
            validateDataFileName(name);
            if (handle.kind === 'directory') throw new Error(`Invalid session layout: nested data directory ${name}`);
            const file = await (handle as FileSystemFileHandle).getFile();
            files.push({ name, sizeBytes: file.size });
        }
        return files.sort((a, b) => this.naturalSort(a.name, b.name));
    }

    async loadDataFile(sessionId: string, name: string): Promise<Uint8Array> {
        validateDataFileName(name);
        const dir = await this.dataDir(sessionId, false);
        if (!dir) throw new Error(`Data file not found: ${name}`);
        const handle = await dir.getFileHandle(name, { create: false });
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    }

    async saveDataFile(sessionId: string, name: string, content: DataFileContent): Promise<void> {
        validateDataFileName(name);
        const dir = (await this.dataDir(sessionId, true))!;
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        // FileSystemWritableFileStream accepts Blob directly and streams it into OPFS without
        // materializing a second full attachment buffer in the renderer.
        if (content instanceof Blob) {
            await writable.write(content);
        } else {
            const buffer = new ArrayBuffer(content.byteLength);
            new Uint8Array(buffer).set(content);
            await writable.write(buffer);
        }
        await writable.close();
        await this.regenerateSessionIndex(sessionId);
    }

    async deleteDataFile(sessionId: string, name: string): Promise<void> {
        validateDataFileName(name);
        const dir = await this.dataDir(sessionId, false);
        if (!dir) return;
        try {
            await dir.removeEntry(name);
        } catch (error) {
            if ((error as Error).name === 'NotFoundError') return;
            throw error;
        }
        await this.regenerateSessionIndex(sessionId);
    }

    async renameDataFile(sessionId: string, oldName: string, newName: string): Promise<void> {
        validateDataFileName(oldName);
        validateDataFileName(newName);
        if (oldName === newName) return;
        const dir = await this.dataDir(sessionId, false);
        if (!dir) return;
        await this.moveFile(dir, oldName, dir, newName);
        await this.regenerateSessionIndex(sessionId);
    }

    async loadQueryResultCache(sessionId: string, hash: string): Promise<CachedQueryResult | null> {
        try {
            const cacheDir = await this.getSessionDir(this.cacheRelPath(sessionId), false);
            const fileHandle = await cacheDir.getFileHandle(`${hash}${STORAGE_CACHE_EXTENSION}`, { create: false });
            const file = await fileHandle.getFile();
            return {
                bytes: new Uint8Array(await file.arrayBuffer()),
                cachedAtMs: file.lastModified,
            };
        } catch {
            // Missing cache folder or entry — a plain miss.
            return null;
        }
    }

    /// Build the eviction store over an already-resolved cache directory. Pairs each `<hash>.arrow`
    /// payload with its `<hash>.arrow.last_access` marker (an empty file whose mtime is the last
    /// access time), falling back to the payload's own mtime when the marker is absent. The marker
    /// files are not themselves cache entries, so they are skipped by the listing and their `.arrow`
    /// sibling is removed alongside them on delete.
    ///
    /// The listing also reaps orphaned markers — a marker whose payload no longer exists. Deletion is
    /// payload-then-marker, so a crash in between (or any external cache tampering) can strand a
    /// zero-byte marker; folding the reap into this scan (which runs on every save, before eviction)
    /// cleans them up with no extra directory walk and no background timer. Orphan reaping is
    /// best-effort: a failed delete is ignored (the marker is harmless and will be retried next save).
    private cacheStoreForDir(cacheDir: FileSystemDirectoryHandle): QueryResultCacheStore {
        return {
            listCacheFiles: async (): Promise<CacheFileStat[]> => {
                // First pass: collect marker mtimes keyed by their payload name, and payload stats.
                const accessMs = new Map<string, number>();
                const payloads: { name: string; size: number; mtimeMs: number }[] = [];
                for await (const [name, handle] of cacheDir.entries()) {
                    if (handle.kind !== 'file') {
                        continue;
                    }
                    if (name.endsWith(STORAGE_CACHE_ACCESS_SUFFIX)) {
                        const file = await (handle as FileSystemFileHandle).getFile();
                        accessMs.set(name.slice(0, -STORAGE_CACHE_ACCESS_SUFFIX.length), file.lastModified);
                    } else if (name.endsWith(STORAGE_CACHE_EXTENSION)) {
                        const file = await (handle as FileSystemFileHandle).getFile();
                        payloads.push({ name, size: file.size, mtimeMs: file.lastModified });
                    }
                }
                // Reap markers whose payload is gone (best-effort).
                const payloadNames = new Set(payloads.map(p => p.name));
                for (const payloadName of accessMs.keys()) {
                    if (!payloadNames.has(payloadName)) {
                        try {
                            await cacheDir.removeEntry(`${payloadName}${STORAGE_CACHE_ACCESS_SUFFIX}`);
                        } catch {
                            // Ignore: a harmless empty file; retried on the next save.
                        }
                    }
                }
                return payloads.map(p => ({
                    ...p,
                    lastAccessMs: accessMs.get(p.name) ?? p.mtimeMs,
                }));
            },
            deleteCacheFile: async (_sessionId: string, name: string): Promise<void> => {
                // Drop the payload and its access marker together; tolerate either being gone.
                for (const entry of [name, `${name}${STORAGE_CACHE_ACCESS_SUFFIX}`]) {
                    try {
                        await cacheDir.removeEntry(entry);
                    } catch (error) {
                        if ((error as any).name !== 'NotFoundError') {
                            throw error;
                        }
                    }
                }
            },
        };
    }

    /// Write an empty file (creating or truncating it), which advances its mtime.
    private async writeEmptyFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(new ArrayBuffer(0));
        await writable.close();
    }

    async saveQueryResultCache(sessionId: string, hash: string, bytes: Uint8Array): Promise<void> {
        const cacheDir = await this.getSessionDir(this.cacheRelPath(sessionId), true);

        // Evict least-recently-used entries first so the new file fits under the thresholds.
        await evictToFit(this.cacheStoreForDir(cacheDir), sessionId, bytes.byteLength);

        const fileHandle = await cacheDir.getFileHandle(`${hash}${STORAGE_CACHE_EXTENSION}`, { create: true });
        const writable = await fileHandle.createWritable();
        // Copy into a plain ArrayBuffer to write binary bytes (a Uint8Array's backing buffer may be
        // typed as SharedArrayBuffer, which the write chunk type rejects).
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        await writable.write(buffer);
        await writable.close();

        // Seed the access marker so a freshly written (never-hit) entry has a last-access time.
        await this.writeEmptyFile(cacheDir, `${hash}${STORAGE_CACHE_EXTENSION}${STORAGE_CACHE_ACCESS_SUFFIX}`);
    }

    async listQueryResultCache(sessionId: string): Promise<CacheFileStat[]> {
        let cacheDir: FileSystemDirectoryHandle;
        try {
            cacheDir = await this.getSessionDir(this.cacheRelPath(sessionId), false);
        } catch {
            // No cache folder yet — nothing cached.
            return [];
        }
        return this.cacheStoreForDir(cacheDir).listCacheFiles(sessionId);
    }

    async touchQueryResultCacheAccess(sessionId: string, hash: string): Promise<void> {
        // Bump only the empty marker's mtime — never the payload — so this stays cheap regardless of
        // result size and leaves the payload's "cached at" write time intact.
        const cacheDir = await this.getSessionDir(this.cacheRelPath(sessionId), false);
        await this.writeEmptyFile(cacheDir, `${hash}${STORAGE_CACHE_EXTENSION}${STORAGE_CACHE_ACCESS_SUFFIX}`);
    }

    async hasCachedQueryResult(sessionId: string, hash: string): Promise<boolean> {
        try {
            const cacheDir = await this.getSessionDir(this.cacheRelPath(sessionId), false);
            await cacheDir.getFileHandle(`${hash}${STORAGE_CACHE_EXTENSION}${STORAGE_CACHE_ACCESS_SUFFIX}`, {
                create: false
            });
            return true;
        } catch {
            return false;
        }
    }

    async deleteQueryResultCache(sessionId: string, hash: string): Promise<void> {
        let cacheDir: FileSystemDirectoryHandle;
        try {
            cacheDir = await this.getSessionDir(this.cacheRelPath(sessionId), false);
        } catch (error) {
            // Missing cache folder — nothing to delete.
            if ((error as any).name === 'NotFoundError' || ((error as any).message ?? '').startsWith('Directory not found')) {
                return;
            }
            throw error;
        }
        // Remove the payload and its access marker together; tolerate either being gone.
        for (const entry of [`${hash}${STORAGE_CACHE_EXTENSION}`, `${hash}${STORAGE_CACHE_EXTENSION}${STORAGE_CACHE_ACCESS_SUFFIX}`]) {
            try {
                await cacheDir.removeEntry(entry);
            } catch (error) {
                if ((error as any).name !== 'NotFoundError') {
                    throw error;
                }
            }
        }
    }

    async clearAllStorage(): Promise<void> {
        const root = this.ensureInitialized();

        // Step 1: Clear the manifest (reset sessions to empty array) FIRST.
        // This ensures the app won't try to restore sessions even if directory cleanup fails.
        try {
            await this.withManifestLock(() => this.writeManifest(root, { sessions: [] }));
        } catch (error) {
            console.warn('Failed to clear manifest:', error);
        }

        // Step 2: Delete app-owned data folders while leaving unrelated origin storage untouched.
        for (const folder of [STORAGE_SESSIONS_FOLDER, STORAGE_CONNECTIONS_FOLDER, STORAGE_SHELL_FOLDER]) {
            try {
                await root.removeEntry(folder, { recursive: true });
            } catch (error) {
                if ((error as DOMException).name !== 'NotFoundError') {
                    console.warn(`Failed to delete ${folder} folder:`, error);
                }
            }
        }
    }

    async loadAppSettings(): Promise<AppSettings | null> {
        const root = this.ensureInitialized();
        try {
            const indexFile = await root.getFileHandle(STORAGE_MANIFEST_FILE, { create: false });
            const file = await indexFile.getFile();
            const text = await file.text();
            const manifest: StorageManifest = JSON.parse(text);
            return manifest.appSettings ?? null;
        } catch (error) {
            if ((error as any).name === 'NotFoundError') {
                return null;
            }
            throw error;
        }
    }

    async saveAppSettings(settings: AppSettings): Promise<void> {
        await this.mutateManifest(manifest => {
            manifest.appSettings = settings;
        });
    }

    async loadManifest(): Promise<StorageManifest> {
        const root = this.ensureInitialized();
        return await this.withManifestLock(() => this.readManifest(root));
    }

    async updateConnections(update: (connections: ConnectionEntry[] | undefined) => ConnectionEntry[] | null): Promise<void> {
        await this.mutateManifest(manifest => {
            const next = update(manifest.connections);
            if (next == null) {
                return false;
            }
            manifest.connections = next;
            return true;
        });
    }

    /// The folder of a connection's files, e.g. "connections/<uuid>"
    private connectionRelPath(connectionId: string): string {
        return `${STORAGE_CONNECTIONS_FOLDER}/${connectionId}`;
    }

    async loadConnectionFile(connectionId: string, fileName: string): Promise<string | null> {
        try {
            const dir = await this.getSessionDir(this.connectionRelPath(connectionId), false);
            const handle = await dir.getFileHandle(fileName, { create: false });
            return await (await handle.getFile()).text();
        } catch {
            return null;
        }
    }

    async saveConnectionFile(connectionId: string, fileName: string, text: string): Promise<void> {
        const dir = await this.getSessionDir(this.connectionRelPath(connectionId), true);
        const handle = await dir.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
    }

    async deleteConnectionFiles(connectionId: string): Promise<void> {
        const root = this.ensureInitialized();
        try {
            const connections = await root.getDirectoryHandle(STORAGE_CONNECTIONS_FOLDER, { create: false });
            await connections.removeEntry(connectionId, { recursive: true });
        } catch (error) {
            if ((error as any).name !== 'NotFoundError') {
                throw error;
            }
        }
    }

    private async readManifest(root: FileSystemDirectoryHandle): Promise<StorageManifest> {
        try {
            const indexFile = await root.getFileHandle(STORAGE_MANIFEST_FILE, { create: false });
            const file = await indexFile.getFile();
            const text = await file.text();
            const manifest: StorageManifest = JSON.parse(text);
            if (!manifest.sessions || !Array.isArray(manifest.sessions)) {
                throw new Error('Invalid manifest format: sessions must be an array');
            }
            return manifest;
        } catch (error) {
            if ((error as any).name === 'NotFoundError') {
                return { sessions: [] };
            }
            throw error;
        }
    }

    private async writeManifest(root: FileSystemDirectoryHandle, manifest: StorageManifest): Promise<void> {
        const indexFile = await root.getFileHandle(STORAGE_MANIFEST_FILE, { create: true });
        const writable = await indexFile.createWritable();
        await writable.write(JSON.stringify(manifest, null, 2));
        await writable.close();
    }

    /// Insert or replace a session's registry entry (matched by UUID), without touching files.
    ///
    /// The array order is the user-facing session order (surfaced in the selector, reorderable by
    /// drag-and-drop via `reorderSessions`), so we deliberately preserve it: a new session appends to
    /// the end and an existing one is updated in place. We never re-sort.
    async upsertSessionEntry(entry: SessionEntry): Promise<void> {
        await this.mutateManifest(manifest => {
            const existingIndex = manifest.sessions.findIndex(s => s.path === entry.path);
            if (existingIndex < 0) {
                manifest.sessions.push(entry);
            } else {
                manifest.sessions[existingIndex] = entry;
            }
        });
    }

    /// Remove a session's registry entry (matched by UUID), without touching files.
    async removeSessionEntry(sessionId: string): Promise<void> {
        await this.mutateManifest(manifest => {
            manifest.sessions = manifest.sessions.filter(s => s.path !== sessionId);
        });
    }

    /// Reorder the registry entries to match `orderedIds` (a permutation of the existing session
    /// UUIDs), without touching files. Entries are re-emitted in the given order; any UUID not present
    /// in the manifest is ignored, and any manifest entry missing from `orderedIds` is appended at the
    /// end in its current relative order (so a stale/racing id list can never drop a session).
    async reorderSessions(orderedIds: string[]): Promise<void> {
        await this.mutateManifest(manifest => {
            this.reorderManifestSessions(manifest, orderedIds);
        });
    }

    private reorderManifestSessions(manifest: StorageManifest, orderedIds: string[]): void {
        const byId = new Map(manifest.sessions.map(s => [s.path, s]));
        const reordered: SessionEntry[] = [];
        const taken = new Set<string>();
        for (const id of orderedIds) {
            const entry = byId.get(id);
            if (entry && !taken.has(id)) {
                reordered.push(entry);
                taken.add(id);
            }
        }
        // Preserve any entries the caller didn't mention, keeping their existing relative order.
        for (const entry of manifest.sessions) {
            if (!taken.has(entry.path)) {
                reordered.push(entry);
            }
        }

        manifest.sessions = reordered;
    }

    private async getSessionDir(
        relativePath: string,
        create: boolean
    ): Promise<FileSystemDirectoryHandle> {
        const root = this.ensureInitialized();
        const parts = relativePath.split('/');
        let currentDir = root;
        let accumulated = '';
        for (const part of parts) {
            if (part) {
                accumulated = accumulated ? `${accumulated}/${part}` : part;
                try {
                    currentDir = await currentDir.getDirectoryHandle(part, { create });
                } catch (error) {
                    if ((error as any).name === 'NotFoundError') {
                        throw new Error(`Directory not found: opfs://${accumulated}`);
                    }
                    throw error;
                }
            }
        }
        return currentDir;
    }

    private async getFolderDir(
        sessionId: string,
        folderName: string,
        create: boolean
    ): Promise<FileSystemDirectoryHandle> {
        const sessionDir = await this.getSessionDir(sessionId, create);
        try {
            const scriptsDir = await sessionDir.getDirectoryHandle(STORAGE_SCRIPTS_FOLDER, { create });
            return await scriptsDir.getDirectoryHandle(folderName, { create });
        } catch (error) {
            if ((error as any).name === 'NotFoundError') {
                throw new Error(`Directory not found: opfs://${sessionId}/${STORAGE_SCRIPTS_FOLDER}/${folderName}`);
            }
            throw error;
        }
    }
}
