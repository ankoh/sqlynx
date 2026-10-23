import type { Logger } from '../platform/logger/logger.js';
import { stringifyError } from '../platform/logger/logger.js';
import { OPFS_MANIFEST_LOCK } from '../app/storage/opfs_storage_backend.js';
import { listSessionFolders, readManifestJson, writeManifestJson } from './storage_root.js';
import { migrateSessionFolder, SessionMigrationResult } from './session_migration.js';
import { notebooksToSessions } from './storage/v2_notebooks_to_sessions.js';
import { globalConnections } from './storage/v3_global_connections.js';
import { sessionCatalogsToConnections } from './storage/v4_session_catalogs_to_connections.js';
import { shellFolder } from './storage/v5_shell_folder.js';

const LOG_CTX = 'storage_migration';

/// What a storage migration step works on
export interface StorageMigrationContext {
    /// The storage root (the OPFS root)
    root: FileSystemDirectoryHandle;
    /// The logger
    logger: Logger;
}

/// A step that brings the storage from the previous version to `version`.
///
/// A step spells out every file, folder and field it touches, it never uses the storage constants
/// of the app. Those describe the current layout while a step describes the layout of its own
/// version. Steps are idempotent: the version is written after a step, an interrupted migration
/// repeats the step.
export interface StorageMigrationStep {
    /// The storage version the step produces
    version: number;
    /// What the step changes
    description: string;
    /// Migrate the storage
    migrate(context: StorageMigrationContext): Promise<void>;
}

/// The steps in order. Steps are never removed, a storage may skip any number of app versions.
export const STORAGE_MIGRATION_STEPS: readonly StorageMigrationStep[] = [
    notebooksToSessions,
    globalConnections,
    sessionCatalogsToConnections,
    shellFolder,
];

/// Run an operation while holding the manifest lock, which the tabs of the app share
async function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    return locks != null ? await locks.request(OPFS_MANIFEST_LOCK, fn) : await fn();
}

/// Bring the storage of the app to the current version.
///
/// The app runs this at startup before anything reads the storage. The storage steps bring the
/// storage root to the current version, then every reachable session folder is brought to the
/// current session format. Session folders that become reachable later are migrated when they are
/// registered. A storage of a newer app version is refused.
export async function migrateStorage(
    logger: Logger,
    root?: FileSystemDirectoryHandle,
    steps: readonly StorageMigrationStep[] = STORAGE_MIGRATION_STEPS,
): Promise<void> {
    const storageRoot = root ?? await navigator.storage.getDirectory();
    await withManifestLock(async () => {
        let manifest = await readManifestJson(storageRoot);
        if (manifest == null) {
            // A fresh storage, the first write of the manifest stamps the current version
            return;
        }
        const version = manifest.storageVersion ?? 1;
        if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
            throw new Error(`Invalid storage version: ${JSON.stringify(version)}`);
        }
        const latestVersion = steps.reduce((latest, step) => Math.max(latest, step.version), 1);
        if (version > latestVersion) {
            throw new Error(`The storage was written by a newer version of DashQL (storage version ${version}, this version supports ${latestVersion})`);
        }

        for (const step of steps) {
            if (step.version <= version) {
                continue;
            }
            logger.info('Migrating the storage', { version: step.version.toString(), step: step.description }, LOG_CTX);
            await step.migrate({ root: storageRoot, logger });
            manifest = await readManifestJson(storageRoot) ?? {};
            await writeManifestJson(storageRoot, { ...manifest, storageVersion: step.version });
        }

        manifest = await readManifestJson(storageRoot) ?? {};
        for (const { sessionId, folder } of await listSessionFolders(storageRoot, manifest)) {
            try {
                const result = await migrateSessionFolder(folder);
                if (result === SessionMigrationResult.Migrated) {
                    logger.info('Migrated a session', { sessionId }, LOG_CTX);
                } else if (result !== SessionMigrationResult.Current) {
                    logger.warn('Session cannot be migrated', { sessionId, result }, LOG_CTX);
                }
            } catch (error) {
                // The session is surfaced as invalid when it is loaded
                logger.warn('Failed to migrate a session', { sessionId, error: stringifyError(error) }, LOG_CTX);
            }
        }
    });
}
