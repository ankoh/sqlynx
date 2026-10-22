import { exists, join, readTextFile, rename, writeTextFile } from '../platform/electron_fs.js';

/// The top-level files of a session folder, as the session migrations see them.
///
/// Session migrations only touch the top-level files of a session folder (the metadata and the
/// catalog files), never the scripts or the attachments. A folder that must stay untouched is
/// therefore migrated in memory with an `OverlayFolder`, while its scripts and attachments are read
/// as they are.
export interface MigrationFolder {
    /// Does the folder contain the file?
    exists(name: string): Promise<boolean>;
    /// Read a file, null if the folder does not contain it
    readText(name: string): Promise<string | null>;
    /// Write a file
    writeText(name: string, text: string): Promise<void>;
    /// Rename a file, an existing target is replaced
    rename(from: string, to: string): Promise<void>;
}

/// Rename a file while it exists and the target does not. A folder that has both files keeps both,
/// the target wins. Returns whether the file was renamed.
export async function renameFileIfPresent(folder: MigrationFolder, from: string, to: string): Promise<boolean> {
    if (!(await folder.exists(from)) || await folder.exists(to)) {
        return false;
    }
    await folder.rename(from, to);
    return true;
}

/// A folder in memory, e.g. the top-level files of an import
export class MemoryFolder implements MigrationFolder {
    /// The files by name
    readonly files: Map<string, string>;

    constructor(files: Iterable<[string, string]> = []) {
        this.files = new Map(files);
    }

    async exists(name: string): Promise<boolean> {
        return this.files.has(name);
    }

    async readText(name: string): Promise<string | null> {
        return this.files.get(name) ?? null;
    }

    async writeText(name: string, text: string): Promise<void> {
        this.files.set(name, text);
    }

    async rename(from: string, to: string): Promise<void> {
        const text = this.files.get(from);
        if (text === undefined) {
            throw new Error(`Cannot rename missing file ${from}`);
        }
        this.files.delete(from);
        this.files.set(to, text);
    }
}

/// A folder whose changes stay in memory, the base folder is only read
export class OverlayFolder implements MigrationFolder {
    /// The folder that is read
    private readonly base: MigrationFolder;
    /// The changed files, null for removed ones
    private readonly changes: Map<string, string | null>;

    constructor(base: MigrationFolder) {
        this.base = base;
        this.changes = new Map();
    }

    async exists(name: string): Promise<boolean> {
        const change = this.changes.get(name);
        return change === undefined ? await this.base.exists(name) : change !== null;
    }

    async readText(name: string): Promise<string | null> {
        const change = this.changes.get(name);
        return change === undefined ? await this.base.readText(name) : change;
    }

    async writeText(name: string, text: string): Promise<void> {
        this.changes.set(name, text);
    }

    async rename(from: string, to: string): Promise<void> {
        const text = await this.readText(from);
        if (text === null) {
            throw new Error(`Cannot rename missing file ${from}`);
        }
        this.changes.set(to, text);
        this.changes.set(from, null);
    }
}

/// A session folder in the Origin Private File System
export class OPFSFolder implements MigrationFolder {
    /// The directory of the session
    private readonly dir: FileSystemDirectoryHandle;

    constructor(dir: FileSystemDirectoryHandle) {
        this.dir = dir;
    }

    async exists(name: string): Promise<boolean> {
        try {
            await this.dir.getFileHandle(name, { create: false });
            return true;
        } catch (error) {
            if ((error as DOMException).name === 'NotFoundError' || (error as DOMException).name === 'TypeMismatchError') {
                return false;
            }
            throw error;
        }
    }

    async readText(name: string): Promise<string | null> {
        if (!(await this.exists(name))) {
            return null;
        }
        return await (await (await this.dir.getFileHandle(name)).getFile()).text();
    }

    async writeText(name: string, text: string): Promise<void> {
        const writable = await (await this.dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
    }

    // OPFS cannot rename files everywhere, the content is copied
    async rename(from: string, to: string): Promise<void> {
        const content = await (await (await this.dir.getFileHandle(from)).getFile()).arrayBuffer();
        const writable = await (await this.dir.getFileHandle(to, { create: true })).createWritable();
        await writable.write(content);
        await writable.close();
        await this.dir.removeEntry(from);
    }
}

/// A session folder on the native file system
export class NativeFolder implements MigrationFolder {
    /// The absolute directory of the session
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    async exists(name: string): Promise<boolean> {
        return await exists(await join(this.dir, name));
    }

    async readText(name: string): Promise<string | null> {
        const path = await join(this.dir, name);
        return await exists(path) ? await readTextFile(path) : null;
    }

    async writeText(name: string, text: string): Promise<void> {
        await writeTextFile(await join(this.dir, name), text);
    }

    async rename(from: string, to: string): Promise<void> {
        await rename(await join(this.dir, from), await join(this.dir, to));
    }
}
