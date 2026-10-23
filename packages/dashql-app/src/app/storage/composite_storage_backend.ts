import {
    type StorageBackend,
    type SessionRegistryBackend,
    type SessionData,
    type ScriptData,
    type DataFile,
    type DataFileContent,
    type SessionEntry,
    type AppSettings,
    type CachedQueryResult,
    type ConnectionEntry,
    type StorageManifest,
    StorageBackendType,
    STORAGE_MANIFEST_FILE,
} from './storage_backend.js';
import { type CacheFileStat } from './query_result_cache_eviction.js';
import { NativeStorageBackend } from './native_storage_backend.js';
import { type SessionLocation, locationFromEntry } from './session_locator.js';
import { grantFsScope } from './native_fs_scope.js';
import { copySession, verifySession } from './storage_migration.js';
import { validateSessionData, describeSessionValidationError } from './session_validation.js';
import {
    assembleSessionBundle,
    readSessionBundle,
    readSessionBundleHead,
    reconcileStoredSessionFiles,
    writeSessionBundle,
    type SessionBundle,
} from './session_bundle.js';
import type { Logger } from '../../platform/logger/logger.js';
import { NativeFolder, OverlayFolder } from '../../migration/migration_folder.js';
import { migrateSessionFolder } from '../../migration/session_migration.js';

const LOG_CTX = 'composite_storage_backend';

export interface SessionImportConflict {
    /// The manifest key, preserving its registered spelling/casing.
    sessionId: string;
    location: SessionLocation;
}

export interface PreparedNativeSession {
    bundle: SessionBundle;
    dir: string;
}

/// A storage backend that routes by per-session location.
///
/// The OPFS root manifest is the single registry of *every* session; registry-level operations
/// (listing sessions, app settings, clear-all) therefore always go to OPFS. Per-session operations
/// are routed by the session UUID to whichever backend physically holds that session's files:
///   - OPFS sessions -> the shared OPFS backend (`sessions/<uuid>/…`).
///   - Native sessions -> a per-session `NativeStorageBackend` bound to the recorded directory.
///
/// Native filesystem scope is re-granted lazily (and idempotently) the first time a native session
/// is touched. The compatibility scope hook is currently a no-op under Electron.
export class CompositeStorageBackend implements SessionRegistryBackend {
    /// The OPFS backend, which owns the session registry
    private readonly opfs: SessionRegistryBackend;
    /// uuid -> physical location, built from the manifest at init and kept in sync on writes
    private readonly locations: Map<string, SessionLocation>;
    /// Cached per-session native backends, keyed by uuid
    private readonly nativeCache: Map<string, NativeStorageBackend>;
    /// Native directories whose fs scope has already been granted this session
    private readonly grantedScopes: Set<string>;
    /// The logger
    private readonly logger: Logger;

    constructor(opfs: SessionRegistryBackend, logger: Logger) {
        this.opfs = opfs;
        this.locations = new Map();
        this.nativeCache = new Map();
        this.grantedScopes = new Set();
        this.logger = logger;
    }

    getBackendType(): StorageBackendType {
        return StorageBackendType.OPFS;
    }

    async initialize(): Promise<void> {
        await this.opfs.initialize?.();
        await this.refreshLocations();
    }

    /// Rebuild the uuid -> location map from the OPFS root manifest and re-grant native fs scopes.
    ///
    /// Called at init (and after relocate, before reload re-runs init). Granting scope here, before
    /// any native session is read, satisfies "grant before read" without a separate boot step.
    async refreshLocations(): Promise<void> {
        const sessions = await this.opfs.listSessions(STORAGE_MANIFEST_FILE);
        this.locations.clear();
        for (const entry of sessions) {
            this.locations.set(entry.path, locationFromEntry(entry));
        }
        for (const loc of this.locations.values()) {
            if (loc.type === StorageBackendType.Native && loc.nativePath) {
                await this.ensureScope(loc.nativePath);
            }
        }
    }

    /// Grant the native fs scope for a directory exactly once per session.
    private async ensureScope(dir: string): Promise<void> {
        if (this.grantedScopes.has(dir)) {
            return;
        }
        try {
            await grantFsScope(dir);
            this.grantedScopes.add(dir);
        } catch (e: any) {
            // A failed grant means subsequent native reads/writes for this directory will fail with
            // a permission error. Log it, but don't poison the whole restore - other sessions are
            // independent. We deliberately don't mark the scope as granted so a later access retries.
            this.logger.warn('failed to grant native fs scope', { dir, error: String(e?.message ?? e) }, LOG_CTX);
        }
    }

    /// The current known location for a session (defaulting to OPFS for unknown UUIDs).
    private locationOf(sessionId: string): SessionLocation {
        return this.locations.get(sessionId) ?? { type: StorageBackendType.OPFS };
    }

    /// Resolve the backend that physically holds a session's files, granting scope as needed.
    private async backendFor(sessionId: string): Promise<StorageBackend> {
        const loc = this.locationOf(sessionId);
        if (loc.type === StorageBackendType.Native && loc.nativePath) {
            await this.ensureScope(loc.nativePath);
            let native = this.nativeCache.get(sessionId);
            if (!native) {
                native = new NativeStorageBackend(loc.nativePath);
                this.nativeCache.set(sessionId, native);
            }
            return native;
        }
        return this.opfs;
    }

    // ---- Registry-level operations (always OPFS) ----------------------------------------------

    listSessions(manifestPath: string): Promise<SessionEntry[]> {
        return this.opfs.listSessions(manifestPath);
    }
    loadAppSettings(): Promise<AppSettings | null> {
        return this.opfs.loadAppSettings();
    }
    saveAppSettings(settings: AppSettings): Promise<void> {
        return this.opfs.saveAppSettings(settings);
    }
    loadManifest(): Promise<StorageManifest> {
        return this.opfs.loadManifest();
    }
    updateConnections(update: (connections: ConnectionEntry[] | undefined) => ConnectionEntry[] | null): Promise<void> {
        return this.opfs.updateConnections(update);
    }
    loadConnectionFile(connectionId: string, fileName: string): Promise<string | null> {
        return this.opfs.loadConnectionFile(connectionId, fileName);
    }
    saveConnectionFile(connectionId: string, fileName: string, text: string): Promise<void> {
        return this.opfs.saveConnectionFile(connectionId, fileName, text);
    }
    deleteConnectionFiles(connectionId: string): Promise<void> {
        return this.opfs.deleteConnectionFiles(connectionId);
    }

    async upsertSessionEntry(entry: SessionEntry): Promise<void> {
        await this.opfs.upsertSessionEntry(entry);
        this.locations.set(entry.path, locationFromEntry(entry));
    }
    async removeSessionEntry(sessionId: string): Promise<void> {
        await this.opfs.removeSessionEntry(sessionId);
        this.locations.delete(sessionId);
        this.nativeCache.delete(sessionId);
    }
    async reorderSessions(orderedIds: string[]): Promise<void> {
        // Keep the in-memory location map's iteration order (the source of `getSessionOrder`) in
        // lockstep with what we persist, applying the exact same "listed ids first, unlisted kept at
        // the end in current order" rule the OPFS backend uses.
        await this.opfs.reorderSessions(orderedIds);

        const previous = this.locations;
        const reordered = new Map<string, SessionLocation>();
        for (const id of orderedIds) {
            const loc = previous.get(id);
            if (loc && !reordered.has(id)) {
                reordered.set(id, loc);
            }
        }
        for (const [id, loc] of previous) {
            if (!reordered.has(id)) {
                reordered.set(id, loc);
            }
        }
        this.locations.clear();
        for (const [id, loc] of reordered) {
            this.locations.set(id, loc);
        }
    }

    /// The user-facing session order (the manifest array order), as session UUIDs.
    getSessionOrder(): string[] {
        return [...this.locations.keys()];
    }
    deleteSessionFiles(sessionId: string): Promise<void> {
        return this.backendFor(sessionId).then(b => {
            if (b === this.opfs) {
                return this.opfs.deleteSessionFiles(sessionId);
            }
            // For native sessions, the directory *is* the session.
            return b.deleteSession(sessionId);
        });
    }

    // ---- Per-session operations (routed by uuid) ----------------------------------------------

    async loadSession(sessionId: string): Promise<SessionData> {
        const backend = await this.backendFor(sessionId);
        const session = await backend.loadSession(sessionId);
        await this.syncNativeAttachments(sessionId, backend);
        return session;
    }

    private async syncNativeAttachments(sessionId: string, backend: StorageBackend): Promise<void> {
        if (backend === this.opfs) {
            return;
        }
        // HyperDB-WASM reads attachments from OPFS even when the native folder owns the session.
        const files = await backend.listDataFiles(sessionId);
        const names = new Set(files.map(file => file.name));
        for (const file of files) {
            await this.opfs.saveDataFile(sessionId, file.name, await backend.loadDataFile(sessionId, file.name));
        }
        for (const file of await this.opfs.listDataFiles(sessionId)) {
            if (!names.has(file.name)) {
                await this.opfs.deleteDataFile(sessionId, file.name);
            }
        }
    }

    async saveSessionManifest(sessionId: string, data: SessionData): Promise<void> {
        const backend = await this.backendFor(sessionId);
        await backend.saveSessionManifest(sessionId, data);
        const loc = this.locationOf(sessionId);
        if (loc.type === StorageBackendType.Native && loc.nativePath) {
            // The native backend does not touch the registry, so keep its OPFS entry in sync here.
            await this.opfs.upsertSessionEntry({
                path: sessionId,
                storageType: StorageBackendType.Native,
                nativePath: loc.nativePath,
            });
        } else if (!this.locations.has(sessionId)) {
            // The OPFS backend registered a newly-created session. Mirror that append in memory so
            // getSessionOrder() can include it immediately, before the next app initialization.
            this.locations.set(sessionId, loc);
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        const loc = this.locationOf(sessionId);
        if (loc.type === StorageBackendType.Native) {
            // Native: the files live in a user-owned folder on disk, so we never delete them —
            // deleting just unregisters the session by dropping the registry entry kept in OPFS.
            //
            // We deliberately do NOT route through `backendFor` here. The native backend's
            // `deleteSession` is a no-op, but resolving it would `initialize()` the directory, which
            // re-creates it via `mkdir`. For a session whose folder was moved/deleted on disk (the
            // exact case that makes it deletable-because-invalid) that would either resurrect an empty
            // folder or throw before we ever dropped the stale manifest entry — leaving it to error
            // again on the next launch. Dropping the entry is all that's needed and can't fail on a
            // missing folder.
            await this.opfs.removeSessionEntry(sessionId);
            // Native files remain user-owned, but their OPFS attachment mirror belongs to DashQL.
            await this.opfs.deleteSessionFiles(sessionId);
        } else {
            // OPFS deletes files and removes the registry entry in one step.
            await this.opfs.deleteSession(sessionId);
        }
        this.locations.delete(sessionId);
        this.nativeCache.delete(sessionId);
    }

    async loadSessionSchema(sessionId: string): Promise<string | null> {
        return (await this.backendFor(sessionId)).loadSessionSchema(sessionId);
    }
    async saveSessionSchema(sessionId: string, sql: string): Promise<void> {
        return (await this.backendFor(sessionId)).saveSessionSchema(sessionId, sql);
    }
    async loadSessionCatalogChanges(sessionId: string): Promise<string | null> {
        return (await this.backendFor(sessionId)).loadSessionCatalogChanges(sessionId);
    }
    async saveSessionCatalogChanges(sessionId: string, sql: string): Promise<void> {
        return (await this.backendFor(sessionId)).saveSessionCatalogChanges(sessionId, sql);
    }
    async loadSessionFunctions(sessionId: string): Promise<string | null> {
        return (await this.backendFor(sessionId)).loadSessionFunctions(sessionId);
    }
    async saveSessionFunctions(sessionId: string, sql: string): Promise<void> {
        return (await this.backendFor(sessionId)).saveSessionFunctions(sessionId, sql);
    }
    async loadScripts(sessionId: string): Promise<ScriptData[]> {
        return (await this.backendFor(sessionId)).loadScripts(sessionId);
    }
    async loadScript(sessionId: string, scriptName: string): Promise<ScriptData> {
        return (await this.backendFor(sessionId)).loadScript(sessionId, scriptName);
    }
    async saveScript(sessionId: string, scriptName: string, sql: string): Promise<void> {
        return (await this.backendFor(sessionId)).saveScript(sessionId, scriptName, sql);
    }
    async deleteScript(sessionId: string, scriptName: string): Promise<void> {
        return (await this.backendFor(sessionId)).deleteScript(sessionId, scriptName);
    }
    async renameScript(sessionId: string, oldScriptName: string, newScriptName: string): Promise<void> {
        return (await this.backendFor(sessionId)).renameScript(sessionId, oldScriptName, newScriptName);
    }
    async loadQueryResultCache(sessionId: string, hash: string): Promise<CachedQueryResult | null> {
        return (await this.backendFor(sessionId)).loadQueryResultCache(sessionId, hash);
    }
    async listDataFiles(sessionId: string): Promise<DataFile[]> {
        return (await this.backendFor(sessionId)).listDataFiles(sessionId);
    }
    async loadDataFile(sessionId: string, name: string): Promise<Uint8Array> {
        return (await this.backendFor(sessionId)).loadDataFile(sessionId, name);
    }
    async saveDataFile(sessionId: string, name: string, content: DataFileContent): Promise<void> {
        const backend = await this.backendFor(sessionId);
        await backend.saveDataFile(sessionId, name, content);
        await this.syncNativeAttachments(sessionId, backend);
    }
    async deleteDataFile(sessionId: string, name: string): Promise<void> {
        const backend = await this.backendFor(sessionId);
        await backend.deleteDataFile(sessionId, name);
        await this.syncNativeAttachments(sessionId, backend);
    }
    async renameDataFile(sessionId: string, oldName: string, newName: string): Promise<void> {
        const backend = await this.backendFor(sessionId);
        await backend.renameDataFile(sessionId, oldName, newName);
        await this.syncNativeAttachments(sessionId, backend);
    }
    async saveQueryResultCache(sessionId: string, hash: string, bytes: Uint8Array): Promise<void> {
        return (await this.backendFor(sessionId)).saveQueryResultCache(sessionId, hash, bytes);
    }
    async touchQueryResultCacheAccess(sessionId: string, hash: string): Promise<void> {
        return (await this.backendFor(sessionId)).touchQueryResultCacheAccess(sessionId, hash);
    }
    async listQueryResultCache(sessionId: string): Promise<CacheFileStat[]> {
        return (await this.backendFor(sessionId)).listQueryResultCache(sessionId);
    }
    async hasCachedQueryResult(sessionId: string, hash: string): Promise<boolean> {
        return (await this.backendFor(sessionId)).hasCachedQueryResult(sessionId, hash);
    }
    async deleteQueryResultCache(sessionId: string, hash: string): Promise<void> {
        return (await this.backendFor(sessionId)).deleteQueryResultCache(sessionId, hash);
    }

    async clearAllStorage(): Promise<void> {
        // Only the OPFS root is wiped (registry + OPFS-backed sessions). Native sessions live in
        // user-owned folders on disk that we never delete; they're simply unregistered when the
        // OPFS manifest is reset. We drop the in-memory location/backend caches to match.
        this.nativeCache.clear();
        this.locations.clear();
        await this.opfs.clearAllStorage?.();
    }

    /// The recorded location for a session (used by the UI to render a display path).
    getSessionLocation(sessionId: string): SessionLocation {
        return this.locationOf(sessionId);
    }

    /// Find a registered UUID collision without attempting to read the session itself.
    ///
    /// The root manifest is authoritative, including entries whose files or metadata are invalid.
    /// UUID comparison is case-insensitive, but the returned id preserves the actual registry key.
    async findSessionImportConflict(sessionId: string): Promise<SessionImportConflict | null> {
        const normalizedId = sessionId.toLowerCase();
        const entries = await this.opfs.listSessions(STORAGE_MANIFEST_FILE);
        const entry = entries.find(candidate => candidate.path.toLowerCase() === normalizedId);
        return entry == null
            ? null
            : { sessionId: entry.path, location: locationFromEntry(entry) };
    }

    /// Read and validate a selected native folder without creating or modifying anything in it.
    ///
    /// A folder of an older version is migrated in memory, the folder itself is migrated once it is
    /// registered.
    async prepareNativeSession(dir: string): Promise<PreparedNativeSession> {
        await this.ensureScope(dir);
        const head = await readSessionBundleHead(new OverlayFolder(new NativeFolder(dir)), `Invalid session folder ${dir}`);

        let bundle: SessionBundle;
        try {
            // Native reads do not require initialize(); avoiding it keeps a missing selected folder
            // from being created as a side effect of validation.
            const native = new NativeStorageBackend(dir);
            const scripts = await native.loadScripts(dir);
            const data = await Promise.all((await native.listDataFiles(dir))
                .map(async file => ({ name: file.name, bytes: await native.loadDataFile(dir, file.name) })));
            bundle = assembleSessionBundle(head, scripts, data);
        } catch (error) {
            throw new Error(`Failed to read session in ${dir}: ${(error as Error)?.message ?? String(error)}`);
        }
        return { bundle, dir };
    }

    /// Read durable data from the physical location currently registered for a session.
    readSessionBundle(sessionId: string): Promise<SessionBundle> {
        return readSessionBundle(sessionId, this, true);
    }

    /// Read durable data explicitly from OPFS, bypassing composite location routing.
    readPortableSessionBundle(sessionId: string): Promise<SessionBundle> {
        return readSessionBundle(sessionId, this.opfs, true);
    }

    /// Write a complete bundle explicitly to OPFS, bypassing a current native route.
    ///
    /// `targetIsFresh` enables writeSessionBundle's whole-session rollback. The in-memory route is
    /// changed only after every durable write succeeds.
    async writePortableSessionBundle(
        bundle: SessionBundle,
        targetSessionId: string,
        targetIsFresh: boolean,
    ): Promise<void> {
        await writeSessionBundle(bundle, this.opfs, { targetSessionId, targetIsFresh });
        this.setLocationAfterPortableWrite(targetSessionId);
        this.nativeCache.delete(targetSessionId);
    }

    private setLocationAfterPortableWrite(sessionId: string): void {
        const registeredId = [...this.locations.keys()]
            .find(candidate => candidate.toLowerCase() === sessionId.toLowerCase());
        if (registeredId == null || registeredId === sessionId) {
            this.locations.set(sessionId, { type: StorageBackendType.OPFS });
            return;
        }

        // Preserve the manifest key and its list position when the source UUID differs only by case.
        const reordered = new Map<string, SessionLocation>();
        for (const [id, location] of this.locations) {
            reordered.set(id, id === registeredId ? { type: StorageBackendType.OPFS } : location);
        }
        this.locations.clear();
        for (const [id, location] of reordered) {
            this.locations.set(id, location);
        }
    }

    /// Delete the complete OPFS session directory (durable files and derived cache), preserving its
    /// registry entry and any native folder registered under the same UUID.
    deletePortableSessionFiles(sessionId: string): Promise<void> {
        return this.opfs.deleteSessionFiles(sessionId);
    }

    /// Delete an OPFS session directory and registry entry. Used for fresh staging UUID cleanup.
    async deletePortableSession(sessionId: string): Promise<void> {
        await this.opfs.deleteSession(sessionId);
        this.locations.delete(sessionId);
        this.nativeCache.delete(sessionId);
    }

    /// Register an already-prepared native folder and reconcile its file lists with its files.
    async registerPreparedNativeSession(prepared: PreparedNativeSession, sessionId: string): Promise<void> {
        const validation = validateSessionData(prepared.bundle.session);
        if (!validation.ok) {
            throw new Error(`Session in ${prepared.dir} is invalid: ${describeSessionValidationError(validation.error)}`);
        }
        await migrateSessionFolder(new NativeFolder(prepared.dir));
        const native = new NativeStorageBackend(prepared.dir);
        await reconcileStoredSessionFiles(native, sessionId);
        await this.upsertSessionEntry({
            path: sessionId,
            storageType: StorageBackendType.Native,
            nativePath: prepared.dir,
        });
        this.nativeCache.set(sessionId, native);
    }

    /// Relocate a single OPFS session's files into a native directory.
    ///
    /// The registry entry stays in OPFS; only the files move. Steps:
    ///   1. Grant scope for, and initialize, the target directory.
    ///   2. Copy the session's files OPFS -> native (UUID preserved).
    ///   3. Verify the copy; on failure throw without touching OPFS.
    ///   4. Flip the OPFS registry entry to `location=native, nativePath=dir` and persist the
    ///      session manifest's `storageType`/`nativePath`.
    ///   5. Delete the OPFS copy of the session's files (NOT the registry entry).
    ///
    /// On any failure before step 4 the OPFS copy is left fully intact, so the caller can recover.
    async relocateSessionToNative(uuid: string, dir: string): Promise<void> {
        if (this.locationOf(uuid).type !== StorageBackendType.OPFS) {
            throw new Error(`Session ${uuid} is not an OPFS session`);
        }

        await this.ensureScope(dir);
        const native = new NativeStorageBackend(dir);
        await native.initialize();

        // 2. Copy. Stamp the session manifest with its new physical location as we write it.
        const sessionData = await this.opfs.loadSession(uuid);
        await copySession(uuid, this.opfs, native, this.logger);
        await native.saveSessionManifest(uuid, {
            ...sessionData,
            storageType: StorageBackendType.Native,
            nativePath: dir,
        });

        // 3. Verify before we touch OPFS.
        const ok = await verifySession(uuid, this.opfs, native);
        if (!ok) {
            throw new Error(`Relocation verification failed for session ${uuid} - keeping OPFS copy`);
        }

        // 4. Flip the registry entry + cache the new location/backend.
        await this.opfs.upsertSessionEntry({
            path: uuid,
            storageType: StorageBackendType.Native,
            nativePath: dir,
        });
        this.locations.set(uuid, { type: StorageBackendType.Native, nativePath: dir });
        this.nativeCache.set(uuid, native);

        // 5. Now it's safe to drop the OPFS copy of the files (registry entry stays).
        await this.opfs.deleteSessionFiles(uuid);
        this.logger.info('relocated session to native storage', { sessionId: uuid, dir }, LOG_CTX);
    }

    /// Load a pre-existing native session directory into the registry.
    ///
    /// Unlike `relocateSessionToNative`, this copies nothing: the directory already holds a complete
    /// session written by a previous run (or another machine). We simply read its session manifest,
    /// validate the metadata up front (the same fail-fast gate the loader uses), and record a
    /// `location=native` entry in the OPFS root manifest so the next restore picks it up.
    ///
    /// Returns the loaded session's UUID. Throws if the directory holds no readable session, the
    /// metadata is invalid, or a session with the same UUID is already registered (we never silently
    /// overwrite an existing entry — the caller surfaces the error).
    async loadNativeSession(dir: string): Promise<string> {
        const prepared = await this.prepareNativeSession(dir);
        const uuid = prepared.bundle.session.sessionId;

        // Never clobber a session that's already registered (same folder added twice, or a UUID
        // collision with an existing OPFS/native session).
        if (await this.findSessionImportConflict(uuid)) {
            throw new Error(`Session ${uuid} is already registered`);
        }

        await this.registerPreparedNativeSession(prepared, uuid);

        this.logger.info('loaded native session', { sessionId: uuid, dir }, LOG_CTX);
        return uuid;
    }
}
