import {
    LEGACY_STORAGE_CATALOG_FUNCTIONS,
    LEGACY_STORAGE_CATALOG_RELATIONS,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from './storage_backend.js';

/// The files of a notebook folder, as far as the file migration needs them
export interface NotebookFiles {
    /// Does the notebook folder contain the file?
    exists(fileName: string): Promise<boolean>;
    /// Rename a file of the notebook folder
    rename(from: string, to: string): Promise<void>;
}

/// A rename of a notebook file
export interface NotebookFileRename {
    /// The old file name
    from: string;
    /// The new file name
    to: string;
}

/// The renames that bring a notebook folder to the current file layout, in order.
/// Steps are never removed, a notebook may skip any number of app versions.
export const NOTEBOOK_FILE_RENAMES: readonly NotebookFileRename[] = [
    // The catalog files share the dashql-catalog prefix
    { from: LEGACY_STORAGE_CATALOG_RELATIONS, to: STORAGE_CATALOG_RELATIONS },
    { from: LEGACY_STORAGE_CATALOG_FUNCTIONS, to: STORAGE_CATALOG_FUNCTIONS },
];

/// The current name of a notebook file followed by its names in older versions, newest first.
/// Readers of folders that are not migrated try them in this order.
export function notebookFileNames(fileName: string, renames: readonly NotebookFileRename[] = NOTEBOOK_FILE_RENAMES): string[] {
    const names = [fileName];
    for (let i = renames.length - 1; i >= 0; --i) {
        if (names.includes(renames[i].to) && !names.includes(renames[i].from)) {
            names.push(renames[i].from);
        }
    }
    return names;
}

/// Bring the files of a notebook folder to the current layout.
///
/// A rename applies only while the old file exists and the new one does not, so the migration is
/// idempotent and an interrupted migration simply continues. A notebook that has both files keeps
/// both, the new one wins. Returns the applied renames.
export async function migrateNotebookFiles(files: NotebookFiles, renames: readonly NotebookFileRename[] = NOTEBOOK_FILE_RENAMES): Promise<NotebookFileRename[]> {
    const applied: NotebookFileRename[] = [];
    for (const rename of renames) {
        if (!(await files.exists(rename.from)) || await files.exists(rename.to)) {
            continue;
        }
        await files.rename(rename.from, rename.to);
        applied.push(rename);
    }
    return applied;
}
