import { StorageBackendType, STORAGE_MANIFEST_FILE, type SessionEntry } from './storage_backend.js';
import {
    type SessionBundle,
    sessionBundlesEqual,
} from './session_bundle.js';
import {
    type CompositeStorageBackend,
    type SessionImportConflict,
    type PreparedNativeSession,
} from './composite_storage_backend.js';

export type { SessionImportConflict, PreparedNativeSession } from './composite_storage_backend.js';

export interface SessionImportTransactionOptions {
    randomUUID?: () => string;
}

export async function findSessionImportConflict(
    backend: CompositeStorageBackend,
    sessionId: string,
): Promise<SessionImportConflict | null> {
    return await backend.findSessionImportConflict(sessionId);
}

export async function prepareNativeSessionImport(
    backend: CompositeStorageBackend,
    dir: string,
): Promise<PreparedNativeSession> {
    return await backend.prepareNativeSession(dir);
}

/// Write a new portable session under an explicit UUID and verify every durable field.
export async function writePortableSessionFresh(
    backend: CompositeStorageBackend,
    bundle: SessionBundle,
    targetSessionId: string = bundle.session.sessionId,
): Promise<string> {
    const conflict = await backend.findSessionImportConflict(targetSessionId);
    if (conflict) {
        throw new Error(`Session ${conflict.sessionId} is already registered`);
    }
    await requireUniqueDatabaseIds(backend, bundle, targetSessionId);

    try {
        await backend.writePortableSessionBundle(bundle, targetSessionId, true);
        await verifyPortableBundle(backend, bundle, targetSessionId);
    } catch (error) {
        try {
            await backend.deletePortableSession(targetSessionId);
        } catch {
            // Preserve the import failure when best-effort cleanup also fails.
        }
        throw error;
    }
    return targetSessionId;
}

/// Replace a registered session with a portable OPFS copy using a verified staging UUID.
export async function replaceSessionWithPortableBundle(
    backend: CompositeStorageBackend,
    bundle: SessionBundle,
    conflict: SessionImportConflict,
    options: SessionImportTransactionOptions = {},
): Promise<string> {
    const targetSessionId = conflict.sessionId;
    requireMatchingSource(bundle, targetSessionId);
    await requireUniqueDatabaseIds(backend, bundle, targetSessionId);
    const oldEntry = await findManifestEntry(backend, targetSessionId);
    // A replacement is also the recovery path for registered sessions that the current format can
    // no longer read (for example V1 sessions containing dashql-draft.sql). Keep rollback data when
    // possible, but do not prevent the explicitly confirmed replacement when it is unavailable.
    const oldBundle = await tryReadBundle(backend, targetSessionId);
    const stagingId = (options.randomUUID ?? (() => crypto.randomUUID()))();
    if (await backend.findSessionImportConflict(stagingId)) {
        throw new Error(`Staging session ${stagingId} is already registered`);
    }

    let operationError: unknown = null;
    let targetMutationStarted = false;
    try {
        await backend.writePortableSessionBundle(bundle, stagingId, true);
        await verifyPortableBundle(backend, bundle, stagingId);

        // Upsert first to retain the existing manifest position and route subsequent live accesses
        // to OPFS. Deleting the OPFS directory then removes every stale durable/cache file at once.
        await backend.upsertSessionEntry({ path: targetSessionId, storageType: StorageBackendType.OPFS });
        targetMutationStarted = true;
        await backend.deletePortableSessionFiles(targetSessionId);
        await backend.writePortableSessionBundle(bundle, targetSessionId, false);
        await verifyPortableBundle(backend, bundle, targetSessionId);
        return targetSessionId;
    } catch (error) {
        operationError = error;
        if (targetMutationStarted) {
            await rollbackPortableReplacement(backend, targetSessionId, oldEntry, oldBundle);
        }
        throw error;
    } finally {
        try {
            await backend.deletePortableSession(stagingId);
        } catch (cleanupError) {
            if (operationError == null) {
                throw cleanupError;
            }
        }
    }
}

/// Register a validated selected folder directly, preserving its UUID and all folder/cache contents.
export async function registerNativeSession(
    backend: CompositeStorageBackend,
    prepared: PreparedNativeSession,
): Promise<string> {
    const sessionId = prepared.bundle.session.sessionId;
    const conflict = await backend.findSessionImportConflict(sessionId);
    if (conflict) {
        throw new Error(`Session ${conflict.sessionId} is already registered`);
    }
    await requireUniqueDatabaseIds(backend, prepared.bundle, sessionId);
    await backend.registerPreparedNativeSession(prepared, sessionId);
    return sessionId;
}

/// Replace a registration with a validated selected native folder. User-owned native folders are
/// never changed; an old OPFS directory is removed only after the manifest flip succeeds.
export async function replaceSessionWithNativeFolder(
    backend: CompositeStorageBackend,
    prepared: PreparedNativeSession,
    conflict: SessionImportConflict,
): Promise<string> {
    const targetSessionId = conflict.sessionId;
    requireMatchingSource(prepared.bundle, targetSessionId);
    if (conflict.location.type === StorageBackendType.Native
        && conflict.location.nativePath === prepared.dir) {
        return targetSessionId;
    }
    await requireUniqueDatabaseIds(backend, prepared.bundle, targetSessionId);

    const oldEntry = await findManifestEntry(backend, targetSessionId);
    let manifestFlipped = false;
    try {
        await backend.registerPreparedNativeSession(prepared, targetSessionId);
        manifestFlipped = true;
        if (conflict.location.type === StorageBackendType.OPFS) {
            await backend.deletePortableSessionFiles(targetSessionId);
        }
        return targetSessionId;
    } catch (error) {
        if (manifestFlipped) {
            try {
                await backend.upsertSessionEntry(oldEntry);
            } catch {
                // Preserve the replacement error if manifest rollback also fails.
            }
        }
        throw error;
    }
}

async function rollbackPortableReplacement(
    backend: CompositeStorageBackend,
    targetSessionId: string,
    oldEntry: SessionEntry,
    oldBundle: SessionBundle | null,
): Promise<void> {
    await backend.deletePortableSessionFiles(targetSessionId);
    if (oldEntry.storageType !== StorageBackendType.Native && oldBundle) {
        await backend.writePortableSessionBundle(oldBundle, targetSessionId, false);
    }
    await backend.upsertSessionEntry(oldEntry);
}

async function findManifestEntry(
    backend: CompositeStorageBackend,
    sessionId: string,
): Promise<SessionEntry> {
    const entries = await backend.listSessions(STORAGE_MANIFEST_FILE);
    const entry = entries.find(candidate => candidate.path.toLowerCase() === sessionId.toLowerCase());
    if (!entry) {
        throw new Error(`Session ${sessionId} is no longer registered`);
    }
    return { ...entry };
}

/// Database UUIDs key global runtime maps, so two sessions cannot safely share one. Ignore the
/// destination session during replacement, but inspect every other readable manifest before any
/// import write starts. An unreadable session cannot contribute live database state at startup.
async function requireUniqueDatabaseIds(
    backend: CompositeStorageBackend,
    bundle: SessionBundle,
    targetSessionId: string,
): Promise<void> {
    const incomingIds = new Set(
        [bundle.session.mainDatabase, ...bundle.session.attachedDatabases]
            .map(database => database.databaseId.toLowerCase()),
    );
    const entries = await backend.listSessions(STORAGE_MANIFEST_FILE);
    for (const entry of entries) {
        if (entry.path.toLowerCase() === targetSessionId.toLowerCase()) continue;
        let session;
        try {
            session = await backend.loadSession(entry.path);
        } catch {
            continue;
        }
        for (const database of [session.mainDatabase, ...(session.attachedDatabases ?? [])]) {
            if (database?.databaseId && incomingIds.has(database.databaseId.toLowerCase())) {
                throw new Error(
                    `Database ${database.databaseId} is already used by session ${entry.path}`,
                );
            }
        }
    }
}

async function tryReadBundle(
    backend: CompositeStorageBackend,
    sessionId: string,
): Promise<SessionBundle | null> {
    try {
        return await backend.readSessionBundle(sessionId);
    } catch {
        return null;
    }
}

async function verifyPortableBundle(
    backend: CompositeStorageBackend,
    source: SessionBundle,
    targetSessionId: string,
): Promise<void> {
    const expected = normalizePortableBundle(source, targetSessionId);
    const actual = await backend.readPortableSessionBundle(targetSessionId);
    if (!sessionBundlesEqual(expected, actual)) {
        throw new Error(`Session import verification failed for ${targetSessionId}`);
    }
}

function normalizePortableBundle(bundle: SessionBundle, sessionId: string): SessionBundle {
    const session = { ...bundle.session, sessionId };
    delete session.sessionPath;
    delete session.storageType;
    delete session.nativePath;
    return {
        session,
        schemaSql: bundle.schemaSql,
        functionsSql: bundle.functionsSql ?? '',
        scripts: bundle.scripts,
        data: bundle.data,
    };
}

function requireMatchingSource(bundle: SessionBundle, targetSessionId: string): void {
    if (bundle.session.sessionId.toLowerCase() !== targetSessionId.toLowerCase()) {
        throw new Error(
            `Source session ${bundle.session.sessionId} does not match replacement ${targetSessionId}`,
        );
    }
}
