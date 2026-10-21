import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPFSStorageBackend } from './opfs_storage_backend.js';
import { STORAGE_MANIFEST_FILE } from './storage_backend.js';
import { TEST_NOTEBOOK_ID, testNotebook } from './notebook_test_backend.js';

class FileHandle {
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

class DirectoryHandle {
    readonly kind = 'directory' as const;
    constructor(readonly name: string, private files: Map<string, string | ArrayBuffer>, private dirs: Set<string>) {}
    private path(child: string) { return this.name ? `${this.name}/${child}` : child; }
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle> {
        const path = this.path(name);
        if (!this.files.has(path) && !options?.create) throw notFound();
        if (options?.create && !this.files.has(path)) this.files.set(path, '');
        return new FileHandle(path, this.files);
    }
    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle> {
        const path = this.path(name);
        if (!this.dirs.has(path) && !options?.create) throw notFound();
        if (options?.create) this.dirs.add(path);
        return new DirectoryHandle(path, this.files, this.dirs);
    }
    async removeEntry(name: string, options?: { recursive?: boolean }) {
        const path = this.path(name);
        if (!this.files.delete(path) && !this.dirs.delete(path) && ![...this.files, ...this.dirs].some(([candidate]: any) => candidate.startsWith(`${path}/`))) throw notFound();
        if (options?.recursive) {
            for (const file of [...this.files.keys()]) if (file.startsWith(`${path}/`)) this.files.delete(file);
            for (const dir of [...this.dirs]) if (dir.startsWith(`${path}/`)) this.dirs.delete(dir);
        }
    }
    async *entries(): AsyncIterableIterator<[string, FileHandle | DirectoryHandle]> {
        const prefix = this.name ? `${this.name}/` : '';
        for (const dir of this.dirs) {
            if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) {
                const name = dir.slice(prefix.length);
                yield [name, new DirectoryHandle(dir, this.files, this.dirs)];
            }
        }
        for (const file of this.files.keys()) {
            if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) {
                const name = file.slice(prefix.length);
                yield [name, new FileHandle(file, this.files)];
            }
        }
    }
}

function notFound(): Error { const error = new Error('not found'); error.name = 'NotFoundError'; return error; }

describe('OPFSStorageBackend V2 flat storage', () => {
    let backend: OPFSStorageBackend;
    let files: Map<string, string | ArrayBuffer>;
    let dirs: Set<string>;

    beforeEach(async () => {
        files = new Map();
        dirs = new Set();
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => new DirectoryHandle('', files, dirs) } });
        backend = new OPFSStorageBackend();
        await backend.initialize();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('round-trips flat scripts and regenerates a scripts-only index', async () => {
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await backend.saveScript(TEST_NOTEBOOK_ID, '10_last.sql', 'SELECT 10');
        await backend.saveScript(TEST_NOTEBOOK_ID, '2_first.sql', 'SELECT 2');
        expect(await backend.loadScripts(TEST_NOTEBOOK_ID)).toEqual([
            { name: '2_first.sql', sql: 'SELECT 2' },
            { name: '10_last.sql', sql: 'SELECT 10' },
        ]);
        expect(JSON.parse(files.get(`notebooks/${TEST_NOTEBOOK_ID}/dashql-notebook-index.json`)! as string)).toEqual({
            scripts: [{ name: '2_first.sql' }, { name: '10_last.sql' }],
        });
        expect(await backend.listNotebooks(STORAGE_MANIFEST_FILE)).toEqual([{ path: TEST_NOTEBOOK_ID, storageType: 'opfs' }]);
    });

    it('rejects nested and draft entries instead of importing V1 data', async () => {
        dirs.add('notebooks');
        dirs.add(`notebooks/${TEST_NOTEBOOK_ID}`);
        dirs.add(`notebooks/${TEST_NOTEBOOK_ID}/scripts`);
        dirs.add(`notebooks/${TEST_NOTEBOOK_ID}/scripts/page`);
        await expect(backend.loadScripts(TEST_NOTEBOOK_ID)).rejects.toThrow('nested scripts directory');
        dirs.delete(`notebooks/${TEST_NOTEBOOK_ID}/scripts/page`);
        files.set(`notebooks/${TEST_NOTEBOOK_ID}/scripts/dashql-draft.sql`, 'SELECT 1');
        await expect(backend.loadScripts(TEST_NOTEBOOK_ID)).rejects.toThrow('dashql-draft.sql is not supported');
    });
    it('preserves binary data through rename fallback and deletion', async () => {
        const bytes = new Uint8Array([0, 255, 128, 195, 40]);
        await backend.saveDataFile(TEST_NOTEBOOK_ID, 'payload.bin', bytes);
        expect(await backend.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([{ name: 'payload.bin', sizeBytes: 5 }]);
        expect(await backend.loadDataFile(TEST_NOTEBOOK_ID, 'payload.bin')).toEqual(bytes);
        await backend.renameDataFile(TEST_NOTEBOOK_ID, 'payload.bin', 'renamed.bin');
        expect(await backend.loadDataFile(TEST_NOTEBOOK_ID, 'renamed.bin')).toEqual(bytes);
        await backend.deleteDataFile(TEST_NOTEBOOK_ID, 'renamed.bin');
        expect(await backend.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([]);
        await expect(backend.saveDataFile(TEST_NOTEBOOK_ID, 'bad\\name', bytes)).rejects.toThrow('basename');
    });

    it('preserves app settings while refusing obsolete session registration', async () => {
        files.set(STORAGE_MANIFEST_FILE, JSON.stringify({ sessions: [{ path: 'old' }], appSettings: { theme: 'dark' } }));
        await backend.initialize();
        expect(await backend.listNotebooks(STORAGE_MANIFEST_FILE)).toEqual([]);
        expect(await backend.loadAppSettings()).toEqual({ theme: 'dark' });
    });

    it('round-trips the SQL keyword case preference in the app manifest', async () => {
        await backend.saveAppSettings({ keywordCase: 'upper' });
        expect(await backend.loadAppSettings()).toEqual({ keywordCase: 'upper' });
        expect(JSON.parse(files.get(STORAGE_MANIFEST_FILE)! as string).appSettings.keywordCase).toBe('upper');
    });

    it('round-trips the narrow screen layout override in the app manifest', async () => {
        await backend.saveAppSettings({ narrowScreenLayout: true });
        expect(await backend.loadAppSettings()).toEqual({ narrowScreenLayout: true });
        expect(JSON.parse(files.get(STORAGE_MANIFEST_FILE)! as string).appSettings.narrowScreenLayout).toBe(true);
        await backend.saveAppSettings({ narrowScreenLayout: false });
        expect(await backend.loadAppSettings()).toEqual({ narrowScreenLayout: false });
    });

    it('round-trips the AI provider settings in the app manifest', async () => {
        const aiProvider = {
            enabled: true,
            endpointUrl: 'http://localhost:11434',
            model: 'llama3',
            headers: [{ name: 'Authorization', value: 'Bearer token' }],
        };
        await backend.saveAppSettings({ aiProvider });
        expect(await backend.loadAppSettings()).toEqual({ aiProvider });
        expect(JSON.parse(files.get(STORAGE_MANIFEST_FILE)! as string).appSettings.aiProvider).toEqual(aiProvider);
    });
});
