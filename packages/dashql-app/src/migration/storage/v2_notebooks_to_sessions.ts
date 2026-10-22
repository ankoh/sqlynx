import type { StorageMigrationStep } from '../storage_migration.js';
import { readManifestJson, writeManifestJson } from '../storage_root.js';

/// Copy the files and folders of a directory into another one, existing files are replaced.
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

/// Notebooks are called sessions: the session folders move from `notebooks/<uuid>` to
/// `sessions/<uuid>` and the manifest lists them as `sessions` instead of `notebooks`. The files
/// inside the folders are renamed by the session migration.
///
/// A notebook folder is removed only after it was copied completely, the manifest is rewritten last.
export const notebooksToSessions: StorageMigrationStep = {
    version: 2,
    description: 'Rename notebooks as sessions',
    async migrate({ root }) {
        let notebooks: FileSystemDirectoryHandle | null = null;
        try {
            notebooks = await root.getDirectoryHandle('notebooks', { create: false });
        } catch (error) {
            if ((error as DOMException).name !== 'NotFoundError') {
                throw error;
            }
        }
        if (notebooks != null) {
            const sessions = await root.getDirectoryHandle('sessions', { create: true });
            const ids: string[] = [];
            for await (const [name, handle] of notebooks.entries()) {
                if (handle.kind === 'directory') {
                    ids.push(name);
                }
            }
            for (const id of ids) {
                const notebook = await notebooks.getDirectoryHandle(id, { create: false });
                await copyDirectory(notebook, await sessions.getDirectoryHandle(id, { create: true }));
                await notebooks.removeEntry(id, { recursive: true });
            }
            await root.removeEntry('notebooks', { recursive: true });
        }

        const manifest = await readManifestJson(root);
        if (manifest != null && Array.isArray(manifest.notebooks) && !Array.isArray(manifest.sessions)) {
            const { notebooks: sessions, ...rest } = manifest;
            await writeManifestJson(root, { sessions, ...rest });
        }
    },
};
