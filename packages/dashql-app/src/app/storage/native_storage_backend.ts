import { type StorageBackend, type SessionData, type ScriptData, type SessionEntry, type AppSettings, type CachedQueryResult, StorageBackendType, STORAGE_SESSION_FILE, STORAGE_SESSION_INDEX_FILE, STORAGE_SCRIPTS_FOLDER, STORAGE_CATALOG_RELATIONS, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_CHANGES, STORAGE_CACHE_FOLDER, STORAGE_CACHE_EXTENSION, STORAGE_CACHE_ACCESS_SUFFIX } from './storage_backend.js';
import { type CacheFileStat, type QueryResultCacheStore, evictToFit } from './query_result_cache_eviction.js';
import { serializeSessionIndex } from './session_index.js';
import { type DataFile, type DataFileContent, STORAGE_ATTACHMENTS_FOLDER, validateDataFileName } from './storage_backend.js';

import { exists, join, mkdir, readDir, readFile, readTextFile, remove, rename, stat, writeFile, writeTextFile } from '../../platform/electron_fs.js';

/// The name of the session-level .gitignore that excludes the cache folder from version control.
const GITIGNORE_FILE = '.gitignore';

/// Native filesystem storage backend for a single Electron session.
///
/// One directory holds exactly one session. Unlike OPFS, there is no `sessions/<uuid>` nesting and
/// no manifest file in the directory: the session's files (`dashql-session.json`,
/// `dashql-catalog-relations.sql`, `dashql-catalog-functions.sql`, `scripts/…`) are written *directly* under the
/// configured directory. The session UUID passed to each method identifies the session for the
/// caller's routing, but does not affect the on-disk layout (the directory already is the session).
///
/// The session *registry* (which sessions exist, and where each lives) is owned by the OPFS root
/// manifest, not here. The registry-level methods on this backend are therefore inert; the
/// composite backend always routes those to OPFS.
export class NativeStorageBackend implements StorageBackend {
    /// The absolute directory on disk that holds this session's files
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    getBackendType(): StorageBackendType {
        return StorageBackendType.Native;
    }

    /// The absolute directory backing this session
    getDir(): string {
        return this.dir;
    }

    async initialize(): Promise<void> {
        if (!(await exists(this.dir))) {
            await mkdir(this.dir, { recursive: true });
        }
    }

    /// Resolve a relative storage path against the absolute directory using OS-correct separators
    private async abs(relative: string): Promise<string> {
        const parts = relative.split('/').filter(p => p.length > 0);
        return await join(this.dir, ...parts);
    }

    /// Ensure a directory (given as a relative path) exists
    private async ensureDir(relative: string): Promise<void> {
        const dir = relative.length > 0 ? await this.abs(relative) : this.dir;
        if (!(await exists(dir))) {
            await mkdir(dir, { recursive: true });
        }
    }

    /// Natural sort for strings with numeric components (e.g., "page-1" < "page-2" < "page-10")
    private naturalSort(a: string, b: string): number {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    }

    // ---- Registry-level operations (owned by OPFS; inert here) -------------------------------

    async listSessions(_manifestPath: string): Promise<SessionEntry[]> {
        // The registry lives in the OPFS root manifest, never in a native session directory.
        return [];
    }

    async loadAppSettings(): Promise<AppSettings | null> {
        return null;
    }

    async saveAppSettings(_settings: AppSettings): Promise<void> {
        // No-op: app settings live on the OPFS root manifest.
    }

    // ---- Per-session operations ---------------------------------------------------------------

    /// Read a file of the session folder, null if it does not exist
    private async readSessionFile(fileName: string): Promise<string | null> {
        const path = await this.abs(fileName);
        return await exists(path) ? await readTextFile(path) : null;
    }

    async loadSession(sessionId: string): Promise<SessionData> {
        const text = await this.readSessionFile(STORAGE_SESSION_FILE);
        if (text == null) {
            throw new Error(`Missing ${STORAGE_SESSION_FILE} in ${this.dir}`);
        }
        return JSON.parse(text) as SessionData;
    }

    async saveSessionManifest(_sessionId: string, data: SessionData): Promise<void> {
        await this.ensureDir('');
        const metaFile = await this.abs(STORAGE_SESSION_FILE);
        await writeTextFile(metaFile, JSON.stringify(data, null, 2));
        await this.regenerateSessionIndex(_sessionId);
    }

    async regenerateSessionIndex(sessionId: string): Promise<void> {
        const indexFile = await this.abs(STORAGE_SESSION_INDEX_FILE);
        await writeTextFile(indexFile, serializeSessionIndex(await this.loadScripts(sessionId), await this.listDataFiles(sessionId)));
    }

    async ensureSessionIndex(sessionId: string): Promise<void> {
        const indexFile = await this.abs(STORAGE_SESSION_INDEX_FILE);
        if (!(await exists(indexFile))) {
            await this.regenerateSessionIndex(sessionId);
        }
    }

    async deleteSession(_sessionId: string): Promise<void> {
        // No-op: a native session lives in a user-owned folder on disk. Deleting the session in
        // dashql only unregisters it — the registry entry lives in the OPFS root manifest and is
        // dropped by the composite backend. The files on disk are deliberately left intact so the
        // folder can be re-loaded later (and so we never destroy data the user put there).
    }

    async loadSessionSchema(_sessionId: string): Promise<string | null> {
        return await this.readSessionFile(STORAGE_CATALOG_RELATIONS);
    }

    async saveSessionSchema(_sessionId: string, sql: string): Promise<void> {
        await this.ensureDir('');
        const schemaFile = await this.abs(STORAGE_CATALOG_RELATIONS);
        await writeTextFile(schemaFile, sql);
    }

    async loadSessionCatalogChanges(_sessionId: string): Promise<string | null> {
        const changesFile = await this.abs(STORAGE_CATALOG_CHANGES);
        if (!(await exists(changesFile))) {
            return null;
        }
        return await readTextFile(changesFile);
    }

    async saveSessionCatalogChanges(_sessionId: string, sql: string): Promise<void> {
        await this.ensureDir('');
        const changesFile = await this.abs(STORAGE_CATALOG_CHANGES);
        await writeTextFile(changesFile, sql);
    }

    async loadSessionFunctions(_sessionId: string): Promise<string | null> {
        return await this.readSessionFile(STORAGE_CATALOG_FUNCTIONS);
    }

    async saveSessionFunctions(_sessionId: string, sql: string): Promise<void> {
        await this.ensureDir('');
        const functionsFile = await this.abs(STORAGE_CATALOG_FUNCTIONS);
        await writeTextFile(functionsFile, sql);
    }

    async loadScripts(_sessionId: string): Promise<ScriptData[]> {
        const scriptsDir = await this.abs(STORAGE_SCRIPTS_FOLDER);
        if (!(await exists(scriptsDir))) {
            return [];
        }

        const entries = await readDir(scriptsDir);
        const scripts: ScriptData[] = [];
        for (const entry of entries) {
            if (entry.isDirectory) {
                throw new Error(`Invalid V2 session layout: nested scripts directory ${entry.name}`);
            }
            if (entry.isFile && entry.name.toLowerCase() === 'dashql-draft.sql') {
                throw new Error('Invalid V2 session layout: dashql-draft.sql is not supported');
            }
            if (entry.isFile && entry.name.toLowerCase().endsWith('.sql')) {
                const sql = await readTextFile(await this.abs(`${STORAGE_SCRIPTS_FOLDER}/${entry.name}`));
                scripts.push({ name: entry.name, sql });
            }
        }
        scripts.sort((a, b) => this.naturalSort(a.name, b.name));
        return scripts;
    }

    async loadScript(sessionId: string, scriptName: string): Promise<ScriptData> {
        const scriptFile = await this.abs(`${STORAGE_SCRIPTS_FOLDER}/${scriptName}`);
        if (!(await exists(scriptFile))) {
            throw new Error(`Script not found: session ${sessionId}, script ${scriptName}`);
        }
        const sql = await readTextFile(scriptFile);
        return { name: scriptName, sql };
    }

    async saveScript(
        _sessionId: string,
        scriptName: string,
        sql: string
    ): Promise<void> {
        await this.ensureDir(STORAGE_SCRIPTS_FOLDER);
        const scriptFile = await this.abs(`${STORAGE_SCRIPTS_FOLDER}/${scriptName}`);
        const isNew = !(await exists(scriptFile));
        await writeTextFile(scriptFile, sql);
        if (isNew) {
            await this.regenerateSessionIndex(_sessionId);
        }
    }

    async deleteScript(_sessionId: string, scriptName: string): Promise<void> {
        const scriptFile = await this.abs(`${STORAGE_SCRIPTS_FOLDER}/${scriptName}`);
        if (await exists(scriptFile)) {
            await remove(scriptFile);
            await this.regenerateSessionIndex(_sessionId);
        }
    }

    async renameScript(_sessionId: string, oldScriptName: string, newScriptName: string): Promise<void> {
        if (oldScriptName === newScriptName) {
            return;
        }
        const oldFile = await this.abs(`${STORAGE_SCRIPTS_FOLDER}/${oldScriptName}`);
        const newFile = await this.abs(`${STORAGE_SCRIPTS_FOLDER}/${newScriptName}`);
        // A missing source means the script hasn't been flushed yet; the pending write under the new
        // name will create it, so there is nothing to move here.
        if (!(await exists(oldFile))) {
            return;
        }
        // Atomic file rename. The new clean base is disambiguated unique within the folder, so the
        // destination is free.
        await rename(oldFile, newFile);
        await this.regenerateSessionIndex(_sessionId);
    }

    async loadQueryResultCache(_sessionId: string, hash: string): Promise<CachedQueryResult | null> {
        const file = await this.abs(`${STORAGE_CACHE_FOLDER}/${hash}${STORAGE_CACHE_EXTENSION}`);
        if (!(await exists(file))) {
            return null;
        }
        const bytes = await readFile(file);
        // Read the file's write time so the UI can show how old the cached result is.
        const meta = await stat(file);
        return {
            bytes,
            cachedAtMs: meta.mtime ? meta.mtime.getTime() : 0,
        };
    }

    async listDataFiles(_sessionId: string): Promise<DataFile[]> {
        const dir = await this.abs(STORAGE_ATTACHMENTS_FOLDER);
        if (!(await exists(dir))) return [];
        const files: DataFile[] = [];
        for (const entry of await readDir(dir)) {
            validateDataFileName(entry.name);
            if (entry.isDirectory) throw new Error(`Invalid session layout: nested data directory ${entry.name}`);
            if (entry.isFile) {
                const meta = await stat(await this.abs(`${STORAGE_ATTACHMENTS_FOLDER}/${entry.name}`));
                files.push({ name: entry.name, sizeBytes: meta.size });
            }
        }
        return files.sort((a, b) => this.naturalSort(a.name, b.name));
    }

    async loadDataFile(_sessionId: string, name: string): Promise<Uint8Array> {
        validateDataFileName(name);
        return await readFile(await this.abs(`${STORAGE_ATTACHMENTS_FOLDER}/${name}`));
    }

    async saveDataFile(sessionId: string, name: string, content: DataFileContent): Promise<void> {
        validateDataFileName(name);
        await this.ensureDir(STORAGE_ATTACHMENTS_FOLDER);
        const bytes = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content;
        await writeFile(await this.abs(`${STORAGE_ATTACHMENTS_FOLDER}/${name}`), bytes);
        await this.regenerateSessionIndex(sessionId);
    }

    async deleteDataFile(sessionId: string, name: string): Promise<void> {
        validateDataFileName(name);
        const path = await this.abs(`${STORAGE_ATTACHMENTS_FOLDER}/${name}`);
        if (!(await exists(path))) return;
        await remove(path);
        await this.regenerateSessionIndex(sessionId);
    }

    async renameDataFile(sessionId: string, oldName: string, newName: string): Promise<void> {
        validateDataFileName(oldName);
        validateDataFileName(newName);
        if (oldName === newName) return;
        const oldPath = await this.abs(`${STORAGE_ATTACHMENTS_FOLDER}/${oldName}`);
        if (!(await exists(oldPath))) return;
        await rename(oldPath, await this.abs(`${STORAGE_ATTACHMENTS_FOLDER}/${newName}`));
        await this.regenerateSessionIndex(sessionId);
    }

    async saveQueryResultCache(sessionId: string, hash: string, bytes: Uint8Array): Promise<void> {
        await this.ensureDir(STORAGE_CACHE_FOLDER);
        // Keep the cache out of version control. Write the ignore file lazily and only when absent so
        // we never clobber a user-authored .gitignore in their session folder.
        const gitignore = await this.abs(GITIGNORE_FILE);
        if (!(await exists(gitignore))) {
            await writeTextFile(gitignore, `${STORAGE_CACHE_FOLDER}/\n`);
        }

        const cacheDir = await this.abs(STORAGE_CACHE_FOLDER);
        await evictToFit(this.cacheStoreForDir(cacheDir), sessionId, bytes.byteLength);

        const file = await this.abs(`${STORAGE_CACHE_FOLDER}/${hash}${STORAGE_CACHE_EXTENSION}`);
        await writeFile(file, bytes);
        // Seed the access marker so a freshly written (never-hit) entry has a last-access time.
        await writeFile(await join(cacheDir, `${hash}${STORAGE_CACHE_EXTENSION}${STORAGE_CACHE_ACCESS_SUFFIX}`), new Uint8Array(0));
    }

    /// Build the eviction store over the cache directory. The native readDir entry carries no
    /// size/mtime, so eviction has to `stat()` each file. Pairs each `<hash>.arrow` payload with its
    /// `<hash>.arrow.last_access` marker (an empty file whose mtime is the last access time), falling
    /// back to the payload's own mtime when the marker is absent. Marker files are skipped by the
    /// listing and removed alongside their `.arrow` sibling on delete.
    ///
    /// The listing also reaps orphaned markers — a marker whose payload no longer exists. Deletion is
    /// payload-then-marker, so a crash in between (or any external cache tampering) can strand a
    /// zero-byte marker; folding the reap into this scan (which runs on every save, before eviction)
    /// cleans them up with no extra directory walk and no background timer. Orphan reaping is
    /// best-effort: a failed delete is ignored (the marker is harmless and will be retried next save).
    private cacheStoreForDir(cacheDir: string): QueryResultCacheStore {
        return {
            listCacheFiles: async (): Promise<CacheFileStat[]> => {
                const entries = await readDir(cacheDir);
                // First pass: collect marker mtimes keyed by their payload name, and payload stats.
                const accessMs = new Map<string, number>();
                const payloads: { name: string; size: number; mtimeMs: number }[] = [];
                for (const entry of entries) {
                    if (!entry.isFile) {
                        continue;
                    }
                    if (entry.name.endsWith(STORAGE_CACHE_ACCESS_SUFFIX)) {
                        const meta = await stat(await join(cacheDir, entry.name));
                        accessMs.set(entry.name.slice(0, -STORAGE_CACHE_ACCESS_SUFFIX.length), meta.mtime ? meta.mtime.getTime() : 0);
                    } else if (entry.name.endsWith(STORAGE_CACHE_EXTENSION)) {
                        const meta = await stat(await join(cacheDir, entry.name));
                        payloads.push({ name: entry.name, size: meta.size, mtimeMs: meta.mtime ? meta.mtime.getTime() : 0 });
                    }
                }
                // Reap markers whose payload is gone (best-effort).
                const payloadNames = new Set(payloads.map(p => p.name));
                for (const payloadName of accessMs.keys()) {
                    if (!payloadNames.has(payloadName)) {
                        try {
                            await remove(await join(cacheDir, `${payloadName}${STORAGE_CACHE_ACCESS_SUFFIX}`));
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
                    const path = await join(cacheDir, entry);
                    if (await exists(path)) {
                        await remove(path);
                    }
                }
            },
        };
    }

    async listQueryResultCache(sessionId: string): Promise<CacheFileStat[]> {
        const cacheDir = await this.abs(STORAGE_CACHE_FOLDER);
        if (!(await exists(cacheDir))) {
            // No cache folder yet — nothing cached.
            return [];
        }
        return this.cacheStoreForDir(cacheDir).listCacheFiles(sessionId);
    }

    async touchQueryResultCacheAccess(_sessionId: string, hash: string): Promise<void> {
        // Bump only the empty marker's mtime — never the payload — so this stays cheap regardless of
        // result size and leaves the payload's "cached at" write time intact.
        const marker = await this.abs(`${STORAGE_CACHE_FOLDER}/${hash}${STORAGE_CACHE_EXTENSION}${STORAGE_CACHE_ACCESS_SUFFIX}`);
        await writeFile(marker, new Uint8Array(0));
    }

    async hasCachedQueryResult(_sessionId: string, hash: string): Promise<boolean> {
        const marker = await this.abs(`${STORAGE_CACHE_FOLDER}/${hash}${STORAGE_CACHE_EXTENSION}`);
        return await exists(marker);
    }

    async deleteQueryResultCache(_sessionId: string, hash: string): Promise<void> {
        // Remove the payload and its access marker together.
        for (const suffix of ['', STORAGE_CACHE_ACCESS_SUFFIX]) {
            const file = await this.abs(`${STORAGE_CACHE_FOLDER}/${hash}${STORAGE_CACHE_EXTENSION}${suffix}`);
            if (await exists(file)) {
                await remove(file);
            }
        }
    }

    async clearAllStorage(): Promise<void> {
        // No-op: like deleteSession, this never touches the user-owned folder on disk. "Clear all
        // storage" only resets the OPFS root (registry + OPFS-backed sessions); native sessions are
        // simply unregistered when the manifest is wiped, and their files stay put on disk.
    }
}
