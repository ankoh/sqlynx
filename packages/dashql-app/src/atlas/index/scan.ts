/// A .sql file of the selected folder
export interface SqlFile {
    /// Path relative to the selected folder, with '/' separators
    id: string;
    text: string;
    /// sha256 of the UTF-8 text, hex
    hash: string;
    handle: FileSystemFileHandle;
}

const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/// Collect the .sql files below a directory. Dot-directories and node_modules are skipped.
export async function scanSqlFiles(
    root: FileSystemDirectoryHandle,
    onFile?: (count: number) => void,
): Promise<SqlFile[]> {
    const files: SqlFile[] = [];
    async function walk(directory: FileSystemDirectoryHandle, prefix: string): Promise<void> {
        for await (const [name, entry] of directory.entries()) {
            if (entry.kind === 'directory') {
                if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) continue;
                await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
            } else if (name.toLowerCase().endsWith('.sql')) {
                const handle = entry as FileSystemFileHandle;
                const text = await (await handle.getFile()).text();
                files.push({ id: `${prefix}${name}`, text, hash: await sha256Hex(text), handle });
                onFile?.(files.length);
            }
        }
    }
    await walk(root, '');
    files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return files;
}

/// Read a script by its relative path
export async function readSqlFile(root: FileSystemDirectoryHandle, id: string): Promise<string> {
    const parts = id.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(part);
    }
    return await (await (await directory.getFileHandle(parts[parts.length - 1])).getFile()).text();
}
