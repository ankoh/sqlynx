import { exists } from '../platform/electron_fs.js';
import { type MigrationFolder, NativeFolder, OPFSFolder } from './migration_folder.js';

/// The manifest of the storage root, it registers the sessions and holds the storage version
export const MANIFEST_FILE = 'dashql-manifest.json';

/// A manifest as it is stored, of any storage version
export type ManifestJson = Record<string, unknown>;

/// A session folder that a manifest registers
export interface RegisteredSessionFolder {
    /// The session id, the path of the manifest entry
    sessionId: string;
    /// The top-level files of the session
    folder: MigrationFolder;
}

/// Read the manifest, null if the storage has none
export async function readManifestJson(root: FileSystemDirectoryHandle): Promise<ManifestJson | null> {
    let text: string;
    try {
        text = await (await (await root.getFileHandle(MANIFEST_FILE, { create: false })).getFile()).text();
    } catch (error) {
        if ((error as DOMException).name === 'NotFoundError') {
            return null;
        }
        throw error;
    }
    const manifest: unknown = JSON.parse(text);
    if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`Invalid ${MANIFEST_FILE}: not a JSON object`);
    }
    return manifest as ManifestJson;
}

/// Write the manifest
export async function writeManifestJson(root: FileSystemDirectoryHandle, manifest: ManifestJson): Promise<void> {
    const writable = await (await root.getFileHandle(MANIFEST_FILE, { create: true })).createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
}

/// The session folders that a manifest of storage version 2 or later registers and that can be
/// reached: OPFS sessions live in `sessions/<uuid>`, native sessions in their own directory, which
/// may be missing or unavailable outside of the native app.
export async function listSessionFolders(root: FileSystemDirectoryHandle, manifest: ManifestJson): Promise<RegisteredSessionFolder[]> {
    const entries = Array.isArray(manifest.sessions) ? manifest.sessions as unknown[] : [];
    const folders: RegisteredSessionFolder[] = [];
    for (const entry of entries) {
        const { path, storageType, nativePath } = (entry ?? {}) as { path?: unknown; storageType?: unknown; nativePath?: unknown };
        if (typeof path !== 'string' || path.length === 0) {
            continue;
        }
        if (storageType === 'native') {
            if (typeof nativePath !== 'string' || globalThis.dashqlElectron === undefined || !(await exists(nativePath))) {
                continue;
            }
            folders.push({ sessionId: path, folder: new NativeFolder(nativePath) });
            continue;
        }
        try {
            const dir = await (await root.getDirectoryHandle('sessions', { create: false })).getDirectoryHandle(path, { create: false });
            folders.push({ sessionId: path, folder: new OPFSFolder(dir) });
        } catch (error) {
            if ((error as DOMException).name !== 'NotFoundError') {
                throw error;
            }
        }
    }
    return folders;
}
