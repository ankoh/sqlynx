import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestLogger } from '../../../platform/logger/test_logger.js';
import { CompositeStorageBackend } from './composite_storage_backend.js';
import { NativeStorageBackend } from './native_storage_backend.js';
import { OPFSStorageBackend } from './opfs_storage_backend.js';
import type { NotebookEntry, NotebookRegistryBackend } from './storage_backend.js';
import { StorageBackendType } from './storage_backend.js';
import { NotebookTestBackend, TEST_NOTEBOOK_ID, testNotebook } from './notebook_test_backend.js';
import { fsStore, makeFsMock, resetFsStore } from './test_fs_mock.js';
import {
    registerNativeNotebook,
    replaceNotebookWithNativeFolder,
    replaceNotebookWithPortableBundle,
    writePortableNotebookFresh,
} from './notebook_import_transaction.js';

const OTHER_NOTEBOOK_ID = '22222222-3333-4444-8555-666666666666';
const THIRD_NOTEBOOK_ID = '33333333-4444-4555-8666-777777777777';

class Registry extends NotebookTestBackend implements NotebookRegistryBackend {
    manifest: NotebookEntry[] = [];
    legacyDrafts = new Set<string>();
    override async listNotebooks(): Promise<NotebookEntry[]> { return [...this.manifest]; }
    override async loadScripts(id: string) {
        if (this.legacyDrafts.has(id)) {
            throw new Error('Invalid V2 notebook layout: dashql-draft.sql is not supported');
        }
        return await super.loadScripts(id);
    }
    override async saveNotebookManifest(id: string, data: any): Promise<void> {
        await super.saveNotebookManifest(id, data);
        await this.upsertNotebookEntry({ path: id, storageType: StorageBackendType.OPFS });
    }
    async upsertNotebookEntry(entry: NotebookEntry): Promise<void> {
        const index = this.manifest.findIndex(value => value.path === entry.path);
        if (index < 0) this.manifest.push(entry); else this.manifest[index] = entry;
    }
    async removeNotebookEntry(id: string): Promise<void> { this.manifest = this.manifest.filter(entry => entry.path !== id); }
    async reorderNotebooks(ids: string[]): Promise<void> {
        const byId = new Map(this.manifest.map(entry => [entry.path, entry]));
        this.manifest = ids.flatMap(id => byId.get(id) ?? []).concat(this.manifest.filter(entry => !ids.includes(entry.path)));
    }
    async deleteNotebookFiles(id: string): Promise<void> {
        this.legacyDrafts.delete(id);
        await super.deleteNotebook(id);
    }
}

describe('CompositeStorageBackend V2 flat routing', () => {
    let registry: Registry;
    let backend: CompositeStorageBackend;

    beforeEach(async () => {
        resetFsStore();
        globalThis.dashqlElectron = { fs: makeFsMock() } as unknown as DashQLElectronBridge;
        registry = new Registry();
        backend = new CompositeStorageBackend(registry, new TestLogger());
        await backend.initialize();
    });

    afterEach(() => {
        delete globalThis.dashqlElectron;
    });

    it('routes unknown and OPFS notebooks to the registry backend', async () => {
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await backend.saveScript(TEST_NOTEBOOK_ID, '01_query.sql', 'SELECT 1');
        expect(await backend.loadScripts(TEST_NOTEBOOK_ID)).toEqual([{ name: '01_query.sql', sql: 'SELECT 1' }]);
        expect(registry.manifest).toEqual([{ path: TEST_NOTEBOOK_ID, storageType: StorageBackendType.OPFS }]);
        expect(fsStore.files.size).toBe(0);
    });

    it('mirrors native attachment bytes into the OPFS UUID namespace before returning a notebook', async () => {
        const opfs = new OPFSStorageBackend();
        const composite = new CompositeStorageBackend(opfs, new TestLogger());
        await composite.initialize();
        const native = new NativeStorageBackend('/tmp/native-attachments');
        const bytes = new Uint8Array([0, 128, 255, 10]);
        await native.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await native.saveDataFile(TEST_NOTEBOOK_ID, 'data.bin', bytes);
        try {
            await composite.upsertNotebookEntry({ path: TEST_NOTEBOOK_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
            await composite.loadNotebook(TEST_NOTEBOOK_ID);
            await expect(opfs.loadDataFile(TEST_NOTEBOOK_ID, 'data.bin')).resolves.toEqual(bytes);
            const root = await navigator.storage.getDirectory();
            const notebooks = await root.getDirectoryHandle('notebooks');
            const notebook = await notebooks.getDirectoryHandle(TEST_NOTEBOOK_ID);
            const attachments = await notebook.getDirectoryHandle('attachments');
            const file = await attachments.getFileHandle('data.bin');
            expect(new Uint8Array(await (await file.getFile()).arrayBuffer())).toEqual(bytes);
        } finally {
            await opfs.deleteNotebook(TEST_NOTEBOOK_ID);
        }
    });

    it('refreshes the complete native attachment mirror and removes stale files without native writes', async () => {
        const native = new NativeStorageBackend('/tmp/native-refresh');
        await native.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await native.saveDataFile(TEST_NOTEBOOK_ID, 'first.bin', new Uint8Array([1]));
        await native.saveDataFile(TEST_NOTEBOOK_ID, 'second.bin', new Uint8Array([2]));
        await registry.saveDataFile(TEST_NOTEBOOK_ID, 'first.bin', new Uint8Array([0]));
        await registry.saveDataFile(TEST_NOTEBOOK_ID, 'stale.bin', new Uint8Array([3]));
        await backend.upsertNotebookEntry({ path: TEST_NOTEBOOK_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
        const before = { files: new Map(fsStore.files), bytes: new Map(fsStore.binFiles), dirs: new Set(fsStore.dirs), mtimes: new Map(fsStore.mtimes) };
        await backend.loadNotebook(TEST_NOTEBOOK_ID);
        expect(await registry.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([{ name: 'first.bin', sizeBytes: 1 }, { name: 'second.bin', sizeBytes: 1 }]);
        expect(await registry.loadDataFile(TEST_NOTEBOOK_ID, 'first.bin')).toEqual(new Uint8Array([1]));
        expect(await registry.loadDataFile(TEST_NOTEBOOK_ID, 'second.bin')).toEqual(new Uint8Array([2]));
        expect({ files: fsStore.files, bytes: fsStore.binFiles, dirs: fsStore.dirs, mtimes: fsStore.mtimes }).toEqual(before);
        await native.deleteDataFile(TEST_NOTEBOOK_ID, 'first.bin');
        await native.deleteDataFile(TEST_NOTEBOOK_ID, 'second.bin');
        await backend.loadNotebook(TEST_NOTEBOOK_ID);
        expect(await registry.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([]);
    });

    it('mirrors native attachment saves through the composite backend', async () => {
        await backend.upsertNotebookEntry({ path: TEST_NOTEBOOK_ID, storageType: StorageBackendType.Native, nativePath: '/tmp/native-save' });
        const bytes = new Uint8Array([0, 255]);
        await backend.saveDataFile(TEST_NOTEBOOK_ID, 'saved.bin', bytes);
        await expect(registry.loadDataFile(TEST_NOTEBOOK_ID, 'saved.bin')).resolves.toEqual(bytes);
        expect(await backend.loadDataFile(TEST_NOTEBOOK_ID, 'saved.bin')).toEqual(bytes);
    });

    it('mirrors native attachment deletes through the composite backend', async () => {
        const native = new NativeStorageBackend('/tmp/native-delete');
        await native.saveDataFile(TEST_NOTEBOOK_ID, 'deleted.bin', new Uint8Array([1]));
        await registry.saveDataFile(TEST_NOTEBOOK_ID, 'deleted.bin', new Uint8Array([1]));
        await backend.upsertNotebookEntry({ path: TEST_NOTEBOOK_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
        await backend.deleteDataFile(TEST_NOTEBOOK_ID, 'deleted.bin');
        expect(await registry.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([]);
        expect(await native.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([]);
    });

    it('mirrors native attachment renames even when the source has not been mirrored', async () => {
        const native = new NativeStorageBackend('/tmp/native-rename');
        const bytes = new Uint8Array([128, 255]);
        await native.saveDataFile(TEST_NOTEBOOK_ID, 'old.bin', bytes);
        await registry.saveDataFile(TEST_NOTEBOOK_ID, 'new.bin', new Uint8Array([0]));
        await backend.upsertNotebookEntry({ path: TEST_NOTEBOOK_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
        await backend.renameDataFile(TEST_NOTEBOOK_ID, 'old.bin', 'new.bin');
        await expect(registry.loadDataFile(TEST_NOTEBOOK_ID, 'new.bin')).resolves.toEqual(bytes);
        expect(await registry.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([{ name: 'new.bin', sizeBytes: 2 }]);
        expect(await native.listDataFiles(TEST_NOTEBOOK_ID)).toEqual([{ name: 'new.bin', sizeBytes: 2 }]);
    });

    it('routes flat CRUD to a registered native directory and preserves files on unregister', async () => {
        const dir = '/tmp/native-v2';
        await backend.upsertNotebookEntry({ path: TEST_NOTEBOOK_ID, storageType: StorageBackendType.Native, nativePath: dir });
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, { ...testNotebook(), storageType: StorageBackendType.Native, nativePath: dir });
        await backend.saveScript(TEST_NOTEBOOK_ID, '01_query.sql', 'SELECT 1');
        await backend.renameScript(TEST_NOTEBOOK_ID, '01_query.sql', '02_renamed.sql');
        expect(await backend.loadScripts(TEST_NOTEBOOK_ID)).toEqual([{ name: '02_renamed.sql', sql: 'SELECT 1' }]);
        expect(fsStore.files.get(`${dir}/scripts/02_renamed.sql`)).toBe('SELECT 1');
        const before = new Map(fsStore.files);
        await backend.deleteNotebook(TEST_NOTEBOOK_ID);
        expect(registry.manifest).toEqual([]);
        expect(fsStore.files).toEqual(before);
    });

    it('replaces a persisted V1 notebook with a legacy draft under the same stable UUID', async () => {
        await registry.saveNotebookManifest(TEST_NOTEBOOK_ID, {
            ...testNotebook(),
            formatVersion: 1,
        } as any);
        await registry.saveScript(TEST_NOTEBOOK_ID, 'legacy.sql', 'SELECT 0');
        registry.legacyDrafts.add(TEST_NOTEBOOK_ID);
        await backend.refreshLocations();

        const source = {
            notebook: testNotebook(),
            schemaSql: null,
            functionsSql: null,
            scripts: [{ name: '01_query.sql', sql: 'SELECT 1' }],
        };
        await replaceNotebookWithPortableBundle(backend, source, {
            notebookId: TEST_NOTEBOOK_ID,
            location: { type: StorageBackendType.OPFS },
        }, { randomUUID: () => '99999999-8888-4777-8666-555555555555' });

        expect(await backend.loadNotebook(TEST_NOTEBOOK_ID)).toEqual(testNotebook());
        expect(await backend.loadScripts(TEST_NOTEBOOK_ID)).toEqual([{ name: '01_query.sql', sql: 'SELECT 1' }]);
    });

    it('rejects a fresh import whose database UUID is already used by another notebook', async () => {
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        const source = {
            notebook: testNotebook({ notebookId: OTHER_NOTEBOOK_ID }),
            schemaSql: null,
            functionsSql: null,
            scripts: [],
        };

        await expect(writePortableNotebookFresh(backend, source)).rejects.toThrow(
            `Database ${testNotebook().mainDatabase.databaseId} is already used by notebook ${TEST_NOTEBOOK_ID}`,
        );
        expect(registry.notebooks.has(OTHER_NOTEBOOK_ID)).toBe(false);
    });

    it('allows a replacement to retain its own database UUID but rejects one owned by a third notebook', async () => {
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await backend.saveNotebookManifest(THIRD_NOTEBOOK_ID, testNotebook({
            notebookId: THIRD_NOTEBOOK_ID,
            mainDatabase: {
                ...testNotebook().mainDatabase,
                databaseId: testNotebook().mainDatabase.databaseId.toUpperCase(),
            },
        }));
        const ownDatabaseId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
        await backend.saveNotebookManifest(OTHER_NOTEBOOK_ID, testNotebook({
            notebookId: OTHER_NOTEBOOK_ID,
            mainDatabase: { ...testNotebook().mainDatabase, databaseId: ownDatabaseId },
        }));
        await backend.refreshLocations();

        const ownSource = {
            notebook: testNotebook({
                notebookId: OTHER_NOTEBOOK_ID,
                mainDatabase: { ...testNotebook().mainDatabase, databaseId: ownDatabaseId },
            }),
            schemaSql: null,
            functionsSql: null,
            scripts: [],
        };
        await expect(replaceNotebookWithPortableBundle(backend, ownSource, {
            notebookId: OTHER_NOTEBOOK_ID,
            location: { type: StorageBackendType.OPFS },
        }, { randomUUID: () => '99999999-8888-4777-8666-555555555555' })).resolves.toBe(OTHER_NOTEBOOK_ID);

        const collidingSource = {
            ...ownSource,
            notebook: testNotebook({ notebookId: OTHER_NOTEBOOK_ID }),
        };
        await expect(replaceNotebookWithPortableBundle(backend, collidingSource, {
            notebookId: OTHER_NOTEBOOK_ID,
            location: { type: StorageBackendType.OPFS },
        })).rejects.toThrow(`already used by notebook ${TEST_NOTEBOOK_ID}`);
    });

    it('rejects native registration and replacement when another notebook owns a database UUID', async () => {
        await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
        await backend.saveNotebookManifest(THIRD_NOTEBOOK_ID, testNotebook({
            notebookId: THIRD_NOTEBOOK_ID,
            mainDatabase: {
                ...testNotebook().mainDatabase,
                databaseId: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb',
            },
        }));
        await backend.refreshLocations();
        const prepared = {
            dir: '/tmp/imported-native',
            bundle: {
                notebook: testNotebook({ notebookId: OTHER_NOTEBOOK_ID }),
                schemaSql: null,
                functionsSql: null,
                scripts: [],
            },
        };

        await expect(registerNativeNotebook(backend, prepared)).rejects.toThrow(
            `already used by notebook ${TEST_NOTEBOOK_ID}`,
        );
        const replacement = {
            ...prepared,
            bundle: {
                ...prepared.bundle,
                notebook: testNotebook({ notebookId: THIRD_NOTEBOOK_ID }),
            },
        };
        await expect(replaceNotebookWithNativeFolder(backend, replacement, {
            notebookId: THIRD_NOTEBOOK_ID,
            location: { type: StorageBackendType.OPFS },
        })).rejects.toThrow(`already used by notebook ${TEST_NOTEBOOK_ID}`);
    });
});
