import {
    LEGACY_STORAGE_CATALOG_FUNCTIONS,
    LEGACY_STORAGE_CATALOG_RELATIONS,
    LEGACY_STORAGE_SESSION_FILE,
    LEGACY_STORAGE_SESSION_INDEX_FILE,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
    STORAGE_SESSION_FILE,
    STORAGE_SESSION_INDEX_FILE,
} from './storage_backend.js';

/// The current format version of the session metadata
export const SESSION_FORMAT_VERSION = 3;

/// The files of a session folder, as far as the file migration needs them
export interface SessionFiles {
    /// Does the session folder contain the file?
    exists(fileName: string): Promise<boolean>;
    /// Rename a file of the session folder
    rename(from: string, to: string): Promise<void>;
}

/// A rename of a session file
export interface SessionFileRename {
    /// The old file name
    from: string;
    /// The new file name
    to: string;
}

/// The renames that bring a session folder to the current file layout, in order.
/// Steps are never removed, a session may skip any number of app versions.
export const SESSION_FILE_RENAMES: readonly SessionFileRename[] = [
    // The catalog files share the dashql-catalog prefix
    { from: LEGACY_STORAGE_CATALOG_RELATIONS, to: STORAGE_CATALOG_RELATIONS },
    { from: LEGACY_STORAGE_CATALOG_FUNCTIONS, to: STORAGE_CATALOG_FUNCTIONS },
    // Sessions were called notebooks
    { from: LEGACY_STORAGE_SESSION_FILE, to: STORAGE_SESSION_FILE },
    { from: LEGACY_STORAGE_SESSION_INDEX_FILE, to: STORAGE_SESSION_INDEX_FILE },
];

/// The current name of a session file followed by its names in older versions, newest first.
/// Readers of folders that are not migrated try them in this order.
export function sessionFileNames(fileName: string, renames: readonly SessionFileRename[] = SESSION_FILE_RENAMES): string[] {
    const names = [fileName];
    for (let i = renames.length - 1; i >= 0; --i) {
        if (names.includes(renames[i].to) && !names.includes(renames[i].from)) {
            names.push(renames[i].from);
        }
    }
    return names;
}

/// Bring the files of a session folder to the current layout.
///
/// A rename applies only while the old file exists and the new one does not, so the migration is
/// idempotent and an interrupted migration simply continues. A session that has both files keeps
/// both, the new one wins. Returns the applied renames.
export async function migrateSessionFiles(files: SessionFiles, renames: readonly SessionFileRename[] = SESSION_FILE_RENAMES): Promise<SessionFileRename[]> {
    const applied: SessionFileRename[] = [];
    for (const rename of renames) {
        if (!(await files.exists(rename.from)) || await files.exists(rename.to)) {
            continue;
        }
        await files.rename(rename.from, rename.to);
        applied.push(rename);
    }
    return applied;
}

/// Bring parsed session metadata to the current format version.
///
/// Format version 2 is the format of notebooks, it names the identity `notebookId` and the display
/// path `notebookPath`. Metadata of any other version is returned unchanged, the validation rejects
/// what is not supported.
export function migrateSessionData<T>(data: T): T {
    if (data == null || typeof data !== 'object' || (data as { formatVersion?: unknown }).formatVersion !== 2) {
        return data;
    }
    const { notebookId, notebookPath, ...rest } = data as Record<string, unknown>;
    return {
        ...rest,
        formatVersion: SESSION_FORMAT_VERSION,
        sessionId: notebookId,
        ...(notebookPath !== undefined ? { sessionPath: notebookPath } : {}),
    } as T;
}
