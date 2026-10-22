/// An in-memory Origin Private File System for tests.
///
/// Files and directories are keyed by their path from the root, e.g. `sessions/<uuid>/dashql-session.json`.
/// A directory exists only if its path is in `dirs`, files do not create their directories.
export class OPFSFileMock {
    readonly kind = 'file' as const;
    constructor(readonly name: string, private files: Map<string, string | ArrayBuffer>) {}
    async getFile(): Promise<File> { return new File([this.files.get(this.name) ?? ''], this.name); }
    async createWritable() {
        return { write: async (value: string | Blob | ArrayBuffer) => {
            if (typeof value === 'string') this.files.set(this.name, value);
            else if (value instanceof Blob) this.files.set(this.name, await value.arrayBuffer());
            else this.files.set(this.name, value.slice(0));
        }, close: async () => {} };
    }
}

export class OPFSDirectoryMock {
    readonly kind = 'directory' as const;
    constructor(readonly name: string, private files: Map<string, string | ArrayBuffer>, private dirs: Set<string>) {}
    private path(child: string) { return this.name ? `${this.name}/${child}` : child; }
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<OPFSFileMock> {
        const path = this.path(name);
        if (!this.files.has(path) && !options?.create) throw notFound();
        if (options?.create && !this.files.has(path)) this.files.set(path, '');
        return new OPFSFileMock(path, this.files);
    }
    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OPFSDirectoryMock> {
        const path = this.path(name);
        if (!this.dirs.has(path) && !options?.create) throw notFound();
        if (options?.create) this.dirs.add(path);
        return new OPFSDirectoryMock(path, this.files, this.dirs);
    }
    async removeEntry(name: string, options?: { recursive?: boolean }) {
        const path = this.path(name);
        if (!this.files.delete(path) && !this.dirs.delete(path) && ![...this.files, ...this.dirs].some(([candidate]: any) => candidate.startsWith(`${path}/`))) throw notFound();
        if (options?.recursive) {
            for (const file of [...this.files.keys()]) if (file.startsWith(`${path}/`)) this.files.delete(file);
            for (const dir of [...this.dirs]) if (dir.startsWith(`${path}/`)) this.dirs.delete(dir);
        }
    }
    async *entries(): AsyncIterableIterator<[string, OPFSFileMock | OPFSDirectoryMock]> {
        const prefix = this.name ? `${this.name}/` : '';
        for (const dir of this.dirs) {
            if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) {
                const name = dir.slice(prefix.length);
                yield [name, new OPFSDirectoryMock(dir, this.files, this.dirs)];
            }
        }
        for (const file of this.files.keys()) {
            if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) {
                const name = file.slice(prefix.length);
                yield [name, new OPFSFileMock(file, this.files)];
            }
        }
    }
}

export function notFound(): Error { const error = new Error('not found'); error.name = 'NotFoundError'; return error; }
