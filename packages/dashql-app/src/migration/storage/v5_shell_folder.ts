import type { StorageMigrationStep } from '../storage_migration.js';

/// The folder of the shell files up to storage version 4
const LEGACY_SHELL_FOLDER = 'dashql-shell';
/// The folder of the shell files from storage version 5
const SHELL_FOLDER = 'shell';

/// Copy the files of a directory recursively, files that the target has already are kept.
async function copyDirectory(source: FileSystemDirectoryHandle, target: FileSystemDirectoryHandle): Promise<void> {
    for await (const [name, handle] of source.entries()) {
        if (handle.kind === 'directory') {
            await copyDirectory(handle as FileSystemDirectoryHandle, await target.getDirectoryHandle(name, { create: true }));
            continue;
        }
        try {
            await target.getFileHandle(name, { create: false });
            continue;
        } catch (error) {
            if ((error as DOMException).name !== 'NotFoundError') throw error;
        }
        const bytes = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
        const writable = await (await target.getFileHandle(name, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
    }
}

/// The shell keeps its files in `dashql-shell` up to storage version 4, the step moves them to `shell`.
/// OPFS has no portable directory rename, the step copies the files and then removes the old folder.
export const shellFolder: StorageMigrationStep = {
    version: 5,
    description: 'Move the files of the shell from dashql-shell to shell',
    async migrate({ root }) {
        let source: FileSystemDirectoryHandle;
        try {
            source = await root.getDirectoryHandle(LEGACY_SHELL_FOLDER, { create: false });
        } catch (error) {
            if ((error as DOMException).name === 'NotFoundError') return;
            throw error;
        }
        await copyDirectory(source, await root.getDirectoryHandle(SHELL_FOLDER, { create: true }));
        await root.removeEntry(LEGACY_SHELL_FOLDER, { recursive: true });
    },
};
