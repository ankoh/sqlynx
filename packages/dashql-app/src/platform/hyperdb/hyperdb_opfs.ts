// HyperDB owns this OPFS mount. Application paths are relative to this root.
export const HYPER_OPFS_ROOT = '/mnt/fs';
export const SHELL_FILES_DIRECTORY = 'imported';

export async function ensureHyperDBOPFSDirectories(
    getOPFSRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): Promise<void> {
    const root = await getOPFSRoot();
    await root.getDirectoryHandle(SHELL_FILES_DIRECTORY, { create: true });
}
