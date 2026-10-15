import { StorageBackendType, STORAGE_MANIFEST_FILE, type NotebookEntry } from './storage_backend.js';
import {
    type NotebookBundle,
    notebookBundlesEqual,
} from './notebook_bundle.js';
import {
    type CompositeStorageBackend,
    type NotebookImportConflict,
    type PreparedNativeNotebook,
} from './composite_storage_backend.js';

export type { NotebookImportConflict, PreparedNativeNotebook } from './composite_storage_backend.js';

export interface NotebookImportTransactionOptions {
    randomUUID?: () => string;
}

export async function findNotebookImportConflict(
    backend: CompositeStorageBackend,
    notebookId: string,
): Promise<NotebookImportConflict | null> {
    return await backend.findNotebookImportConflict(notebookId);
}

export async function prepareNativeNotebookImport(
    backend: CompositeStorageBackend,
    dir: string,
): Promise<PreparedNativeNotebook> {
    return await backend.prepareNativeNotebook(dir);
}

/// Write a new portable notebook under an explicit UUID and verify every durable field.
export async function writePortableNotebookFresh(
    backend: CompositeStorageBackend,
    bundle: NotebookBundle,
    targetNotebookId: string = bundle.notebook.notebookId,
): Promise<string> {
    const conflict = await backend.findNotebookImportConflict(targetNotebookId);
    if (conflict) {
        throw new Error(`Notebook ${conflict.notebookId} is already registered`);
    }
    await requireUniqueDatabaseIds(backend, bundle, targetNotebookId);

    try {
        await backend.writePortableNotebookBundle(bundle, targetNotebookId, true);
        await verifyPortableBundle(backend, bundle, targetNotebookId);
    } catch (error) {
        try {
            await backend.deletePortableNotebook(targetNotebookId);
        } catch {
            // Preserve the import failure when best-effort cleanup also fails.
        }
        throw error;
    }
    return targetNotebookId;
}

/// Replace a registered notebook with a portable OPFS copy using a verified staging UUID.
export async function replaceNotebookWithPortableBundle(
    backend: CompositeStorageBackend,
    bundle: NotebookBundle,
    conflict: NotebookImportConflict,
    options: NotebookImportTransactionOptions = {},
): Promise<string> {
    const targetNotebookId = conflict.notebookId;
    requireMatchingSource(bundle, targetNotebookId);
    await requireUniqueDatabaseIds(backend, bundle, targetNotebookId);
    const oldEntry = await findManifestEntry(backend, targetNotebookId);
    // A replacement is also the recovery path for registered notebooks that the current format can
    // no longer read (for example V1 notebooks containing dashql-draft.sql). Keep rollback data when
    // possible, but do not prevent the explicitly confirmed replacement when it is unavailable.
    const oldBundle = await tryReadBundle(backend, targetNotebookId);
    const stagingId = (options.randomUUID ?? (() => crypto.randomUUID()))();
    if (await backend.findNotebookImportConflict(stagingId)) {
        throw new Error(`Staging notebook ${stagingId} is already registered`);
    }

    let operationError: unknown = null;
    let targetMutationStarted = false;
    try {
        await backend.writePortableNotebookBundle(bundle, stagingId, true);
        await verifyPortableBundle(backend, bundle, stagingId);

        // Upsert first to retain the existing manifest position and route subsequent live accesses
        // to OPFS. Deleting the OPFS directory then removes every stale durable/cache file at once.
        await backend.upsertNotebookEntry({ path: targetNotebookId, storageType: StorageBackendType.OPFS });
        targetMutationStarted = true;
        await backend.deletePortableNotebookFiles(targetNotebookId);
        await backend.writePortableNotebookBundle(bundle, targetNotebookId, false);
        await verifyPortableBundle(backend, bundle, targetNotebookId);
        return targetNotebookId;
    } catch (error) {
        operationError = error;
        if (targetMutationStarted) {
            await rollbackPortableReplacement(backend, targetNotebookId, oldEntry, oldBundle);
        }
        throw error;
    } finally {
        try {
            await backend.deletePortableNotebook(stagingId);
        } catch (cleanupError) {
            if (operationError == null) {
                throw cleanupError;
            }
        }
    }
}

/// Register a validated selected folder directly, preserving its UUID and all folder/cache contents.
export async function registerNativeNotebook(
    backend: CompositeStorageBackend,
    prepared: PreparedNativeNotebook,
): Promise<string> {
    const notebookId = prepared.bundle.notebook.notebookId;
    const conflict = await backend.findNotebookImportConflict(notebookId);
    if (conflict) {
        throw new Error(`Notebook ${conflict.notebookId} is already registered`);
    }
    await requireUniqueDatabaseIds(backend, prepared.bundle, notebookId);
    await backend.registerPreparedNativeNotebook(prepared, notebookId);
    return notebookId;
}

/// Replace a registration with a validated selected native folder. User-owned native folders are
/// never changed; an old OPFS directory is removed only after the manifest flip succeeds.
export async function replaceNotebookWithNativeFolder(
    backend: CompositeStorageBackend,
    prepared: PreparedNativeNotebook,
    conflict: NotebookImportConflict,
): Promise<string> {
    const targetNotebookId = conflict.notebookId;
    requireMatchingSource(prepared.bundle, targetNotebookId);
    if (conflict.location.type === StorageBackendType.Native
        && conflict.location.nativePath === prepared.dir) {
        return targetNotebookId;
    }
    await requireUniqueDatabaseIds(backend, prepared.bundle, targetNotebookId);

    const oldEntry = await findManifestEntry(backend, targetNotebookId);
    let manifestFlipped = false;
    try {
        await backend.registerPreparedNativeNotebook(prepared, targetNotebookId);
        manifestFlipped = true;
        if (conflict.location.type === StorageBackendType.OPFS) {
            await backend.deletePortableNotebookFiles(targetNotebookId);
        }
        return targetNotebookId;
    } catch (error) {
        if (manifestFlipped) {
            try {
                await backend.upsertNotebookEntry(oldEntry);
            } catch {
                // Preserve the replacement error if manifest rollback also fails.
            }
        }
        throw error;
    }
}

async function rollbackPortableReplacement(
    backend: CompositeStorageBackend,
    targetNotebookId: string,
    oldEntry: NotebookEntry,
    oldBundle: NotebookBundle | null,
): Promise<void> {
    await backend.deletePortableNotebookFiles(targetNotebookId);
    if (oldEntry.storageType !== StorageBackendType.Native && oldBundle) {
        await backend.writePortableNotebookBundle(oldBundle, targetNotebookId, false);
    }
    await backend.upsertNotebookEntry(oldEntry);
}

async function findManifestEntry(
    backend: CompositeStorageBackend,
    notebookId: string,
): Promise<NotebookEntry> {
    const entries = await backend.listNotebooks(STORAGE_MANIFEST_FILE);
    const entry = entries.find(candidate => candidate.path.toLowerCase() === notebookId.toLowerCase());
    if (!entry) {
        throw new Error(`Notebook ${notebookId} is no longer registered`);
    }
    return { ...entry };
}

/// Database UUIDs key global runtime maps, so two notebooks cannot safely share one. Ignore the
/// destination notebook during replacement, but inspect every other readable manifest before any
/// import write starts. An unreadable notebook cannot contribute live database state at startup.
async function requireUniqueDatabaseIds(
    backend: CompositeStorageBackend,
    bundle: NotebookBundle,
    targetNotebookId: string,
): Promise<void> {
    const incomingIds = new Set(
        [bundle.notebook.mainDatabase, ...bundle.notebook.attachedDatabases]
            .map(database => database.databaseId.toLowerCase()),
    );
    const entries = await backend.listNotebooks(STORAGE_MANIFEST_FILE);
    for (const entry of entries) {
        if (entry.path.toLowerCase() === targetNotebookId.toLowerCase()) continue;
        let notebook;
        try {
            notebook = await backend.loadNotebook(entry.path);
        } catch {
            continue;
        }
        for (const database of [notebook.mainDatabase, ...(notebook.attachedDatabases ?? [])]) {
            if (database?.databaseId && incomingIds.has(database.databaseId.toLowerCase())) {
                throw new Error(
                    `Database ${database.databaseId} is already used by notebook ${entry.path}`,
                );
            }
        }
    }
}

async function tryReadBundle(
    backend: CompositeStorageBackend,
    notebookId: string,
): Promise<NotebookBundle | null> {
    try {
        return await backend.readNotebookBundle(notebookId);
    } catch {
        return null;
    }
}

async function verifyPortableBundle(
    backend: CompositeStorageBackend,
    source: NotebookBundle,
    targetNotebookId: string,
): Promise<void> {
    const expected = normalizePortableBundle(source, targetNotebookId);
    const actual = await backend.readPortableNotebookBundle(targetNotebookId);
    if (!notebookBundlesEqual(expected, actual)) {
        throw new Error(`Notebook import verification failed for ${targetNotebookId}`);
    }
}

function normalizePortableBundle(bundle: NotebookBundle, notebookId: string): NotebookBundle {
    const notebook = { ...bundle.notebook, notebookId };
    delete notebook.notebookPath;
    delete notebook.storageType;
    delete notebook.nativePath;
    return {
        notebook,
        schemaSql: bundle.schemaSql,
        functionsSql: bundle.functionsSql ?? '',
        scripts: bundle.scripts,
        data: bundle.data,
    };
}

function requireMatchingSource(bundle: NotebookBundle, targetNotebookId: string): void {
    if (bundle.notebook.notebookId.toLowerCase() !== targetNotebookId.toLowerCase()) {
        throw new Error(
            `Source notebook ${bundle.notebook.notebookId} does not match replacement ${targetNotebookId}`,
        );
    }
}
