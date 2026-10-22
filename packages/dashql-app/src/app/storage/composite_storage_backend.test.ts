import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestLogger } from '../../platform/logger/test_logger.js';
import { CompositeStorageBackend } from './composite_storage_backend.js';
import { NativeStorageBackend } from './native_storage_backend.js';
import { OPFSStorageBackend } from './opfs_storage_backend.js';
import type { SessionEntry, SessionRegistryBackend } from './storage_backend.js';
import { StorageBackendType } from './storage_backend.js';
import { SessionTestBackend, TEST_SESSION_ID, testSession } from './session_test_backend.js';
import { fsStore, makeFsMock, resetFsStore } from './test_fs_mock.js';
import {
    registerNativeSession,
    replaceSessionWithNativeFolder,
    replaceSessionWithPortableBundle,
    writePortableSessionFresh,
} from './session_import_transaction.js';

const OTHER_SESSION_ID = '22222222-3333-4444-8555-666666666666';
const THIRD_SESSION_ID = '33333333-4444-4555-8666-777777777777';

class Registry extends SessionTestBackend implements SessionRegistryBackend {
    manifest: SessionEntry[] = [];
    legacyDrafts = new Set<string>();
    override async listSessions(): Promise<SessionEntry[]> { return [...this.manifest]; }
    override async loadScripts(id: string) {
        if (this.legacyDrafts.has(id)) {
            throw new Error('Invalid V2 session layout: dashql-draft.sql is not supported');
        }
        return await super.loadScripts(id);
    }
    override async saveSessionManifest(id: string, data: any): Promise<void> {
        await super.saveSessionManifest(id, data);
        await this.upsertSessionEntry({ path: id, storageType: StorageBackendType.OPFS });
    }
    async upsertSessionEntry(entry: SessionEntry): Promise<void> {
        const index = this.manifest.findIndex(value => value.path === entry.path);
        if (index < 0) this.manifest.push(entry); else this.manifest[index] = entry;
    }
    async removeSessionEntry(id: string): Promise<void> { this.manifest = this.manifest.filter(entry => entry.path !== id); }
    async reorderSessions(ids: string[]): Promise<void> {
        const byId = new Map(this.manifest.map(entry => [entry.path, entry]));
        this.manifest = ids.flatMap(id => byId.get(id) ?? []).concat(this.manifest.filter(entry => !ids.includes(entry.path)));
    }
    async deleteSessionFiles(id: string): Promise<void> {
        this.legacyDrafts.delete(id);
        await super.deleteSession(id);
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

    it('routes unknown and OPFS sessions to the registry backend', async () => {
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        await backend.saveScript(TEST_SESSION_ID, '01_query.sql', 'SELECT 1');
        expect(await backend.loadScripts(TEST_SESSION_ID)).toEqual([{ name: '01_query.sql', sql: 'SELECT 1' }]);
        expect(registry.manifest).toEqual([{ path: TEST_SESSION_ID, storageType: StorageBackendType.OPFS }]);
        expect(fsStore.files.size).toBe(0);
    });

    it('mirrors native attachment bytes into the OPFS UUID namespace before returning a session', async () => {
        const opfs = new OPFSStorageBackend();
        const composite = new CompositeStorageBackend(opfs, new TestLogger());
        await composite.initialize();
        const native = new NativeStorageBackend('/tmp/native-attachments');
        const bytes = new Uint8Array([0, 128, 255, 10]);
        await native.saveSessionManifest(TEST_SESSION_ID, testSession());
        await native.saveDataFile(TEST_SESSION_ID, 'data.bin', bytes);
        try {
            await composite.upsertSessionEntry({ path: TEST_SESSION_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
            await composite.loadSession(TEST_SESSION_ID);
            await expect(opfs.loadDataFile(TEST_SESSION_ID, 'data.bin')).resolves.toEqual(bytes);
            const root = await navigator.storage.getDirectory();
            const sessions = await root.getDirectoryHandle('sessions');
            const session = await sessions.getDirectoryHandle(TEST_SESSION_ID);
            const attachments = await session.getDirectoryHandle('attachments');
            const file = await attachments.getFileHandle('data.bin');
            expect(new Uint8Array(await (await file.getFile()).arrayBuffer())).toEqual(bytes);
        } finally {
            await opfs.deleteSession(TEST_SESSION_ID);
        }
    });

    it('refreshes the complete native attachment mirror and removes stale files without native writes', async () => {
        const native = new NativeStorageBackend('/tmp/native-refresh');
        await native.saveSessionManifest(TEST_SESSION_ID, testSession());
        await native.saveDataFile(TEST_SESSION_ID, 'first.bin', new Uint8Array([1]));
        await native.saveDataFile(TEST_SESSION_ID, 'second.bin', new Uint8Array([2]));
        await registry.saveDataFile(TEST_SESSION_ID, 'first.bin', new Uint8Array([0]));
        await registry.saveDataFile(TEST_SESSION_ID, 'stale.bin', new Uint8Array([3]));
        await backend.upsertSessionEntry({ path: TEST_SESSION_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
        const before = { files: new Map(fsStore.files), bytes: new Map(fsStore.binFiles), dirs: new Set(fsStore.dirs), mtimes: new Map(fsStore.mtimes) };
        await backend.loadSession(TEST_SESSION_ID);
        expect(await registry.listDataFiles(TEST_SESSION_ID)).toEqual([{ name: 'first.bin', sizeBytes: 1 }, { name: 'second.bin', sizeBytes: 1 }]);
        expect(await registry.loadDataFile(TEST_SESSION_ID, 'first.bin')).toEqual(new Uint8Array([1]));
        expect(await registry.loadDataFile(TEST_SESSION_ID, 'second.bin')).toEqual(new Uint8Array([2]));
        expect({ files: fsStore.files, bytes: fsStore.binFiles, dirs: fsStore.dirs, mtimes: fsStore.mtimes }).toEqual(before);
        await native.deleteDataFile(TEST_SESSION_ID, 'first.bin');
        await native.deleteDataFile(TEST_SESSION_ID, 'second.bin');
        await backend.loadSession(TEST_SESSION_ID);
        expect(await registry.listDataFiles(TEST_SESSION_ID)).toEqual([]);
    });

    it('mirrors native attachment saves through the composite backend', async () => {
        await backend.upsertSessionEntry({ path: TEST_SESSION_ID, storageType: StorageBackendType.Native, nativePath: '/tmp/native-save' });
        const bytes = new Uint8Array([0, 255]);
        await backend.saveDataFile(TEST_SESSION_ID, 'saved.bin', bytes);
        await expect(registry.loadDataFile(TEST_SESSION_ID, 'saved.bin')).resolves.toEqual(bytes);
        expect(await backend.loadDataFile(TEST_SESSION_ID, 'saved.bin')).toEqual(bytes);
    });

    it('mirrors native attachment deletes through the composite backend', async () => {
        const native = new NativeStorageBackend('/tmp/native-delete');
        await native.saveDataFile(TEST_SESSION_ID, 'deleted.bin', new Uint8Array([1]));
        await registry.saveDataFile(TEST_SESSION_ID, 'deleted.bin', new Uint8Array([1]));
        await backend.upsertSessionEntry({ path: TEST_SESSION_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
        await backend.deleteDataFile(TEST_SESSION_ID, 'deleted.bin');
        expect(await registry.listDataFiles(TEST_SESSION_ID)).toEqual([]);
        expect(await native.listDataFiles(TEST_SESSION_ID)).toEqual([]);
    });

    it('mirrors native attachment renames even when the source has not been mirrored', async () => {
        const native = new NativeStorageBackend('/tmp/native-rename');
        const bytes = new Uint8Array([128, 255]);
        await native.saveDataFile(TEST_SESSION_ID, 'old.bin', bytes);
        await registry.saveDataFile(TEST_SESSION_ID, 'new.bin', new Uint8Array([0]));
        await backend.upsertSessionEntry({ path: TEST_SESSION_ID, storageType: StorageBackendType.Native, nativePath: native.getDir() });
        await backend.renameDataFile(TEST_SESSION_ID, 'old.bin', 'new.bin');
        await expect(registry.loadDataFile(TEST_SESSION_ID, 'new.bin')).resolves.toEqual(bytes);
        expect(await registry.listDataFiles(TEST_SESSION_ID)).toEqual([{ name: 'new.bin', sizeBytes: 2 }]);
        expect(await native.listDataFiles(TEST_SESSION_ID)).toEqual([{ name: 'new.bin', sizeBytes: 2 }]);
    });

    it('routes flat CRUD to a registered native directory and preserves files on unregister', async () => {
        const dir = '/tmp/native-v2';
        await backend.upsertSessionEntry({ path: TEST_SESSION_ID, storageType: StorageBackendType.Native, nativePath: dir });
        await backend.saveSessionManifest(TEST_SESSION_ID, { ...testSession(), storageType: StorageBackendType.Native, nativePath: dir });
        await backend.saveScript(TEST_SESSION_ID, '01_query.sql', 'SELECT 1');
        await backend.renameScript(TEST_SESSION_ID, '01_query.sql', '02_renamed.sql');
        expect(await backend.loadScripts(TEST_SESSION_ID)).toEqual([{ name: '02_renamed.sql', sql: 'SELECT 1' }]);
        expect(fsStore.files.get(`${dir}/scripts/02_renamed.sql`)).toBe('SELECT 1');
        const before = new Map(fsStore.files);
        await backend.deleteSession(TEST_SESSION_ID);
        expect(registry.manifest).toEqual([]);
        expect(fsStore.files).toEqual(before);
    });

    it('replaces a persisted V1 session with a legacy draft under the same stable UUID', async () => {
        await registry.saveSessionManifest(TEST_SESSION_ID, {
            ...testSession(),
            formatVersion: 1,
        } as any);
        await registry.saveScript(TEST_SESSION_ID, 'legacy.sql', 'SELECT 0');
        registry.legacyDrafts.add(TEST_SESSION_ID);
        await backend.refreshLocations();

        const source = {
            session: testSession(),
            schemaSql: null,
            functionsSql: null,
            scripts: [{ name: '01_query.sql', sql: 'SELECT 1' }],
        };
        await replaceSessionWithPortableBundle(backend, source, {
            sessionId: TEST_SESSION_ID,
            location: { type: StorageBackendType.OPFS },
        }, { randomUUID: () => '99999999-8888-4777-8666-555555555555' });

        expect(await backend.loadSession(TEST_SESSION_ID)).toEqual(testSession());
        expect(await backend.loadScripts(TEST_SESSION_ID)).toEqual([{ name: '01_query.sql', sql: 'SELECT 1' }]);
    });

    it('rejects a fresh import whose database UUID is already used by another session', async () => {
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        const source = {
            session: testSession({ sessionId: OTHER_SESSION_ID }),
            schemaSql: null,
            functionsSql: null,
            scripts: [],
        };

        await expect(writePortableSessionFresh(backend, source)).rejects.toThrow(
            `Database ${testSession().mainDatabase.databaseId} is already used by session ${TEST_SESSION_ID}`,
        );
        expect(registry.sessions.has(OTHER_SESSION_ID)).toBe(false);
    });

    it('allows a replacement to retain its own database UUID but rejects one owned by a third session', async () => {
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        await backend.saveSessionManifest(THIRD_SESSION_ID, testSession({
            sessionId: THIRD_SESSION_ID,
            mainDatabase: {
                ...testSession().mainDatabase,
                databaseId: testSession().mainDatabase.databaseId.toUpperCase(),
            },
        }));
        const ownDatabaseId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
        await backend.saveSessionManifest(OTHER_SESSION_ID, testSession({
            sessionId: OTHER_SESSION_ID,
            mainDatabase: { ...testSession().mainDatabase, databaseId: ownDatabaseId },
        }));
        await backend.refreshLocations();

        const ownSource = {
            session: testSession({
                sessionId: OTHER_SESSION_ID,
                mainDatabase: { ...testSession().mainDatabase, databaseId: ownDatabaseId },
            }),
            schemaSql: null,
            functionsSql: null,
            scripts: [],
        };
        await expect(replaceSessionWithPortableBundle(backend, ownSource, {
            sessionId: OTHER_SESSION_ID,
            location: { type: StorageBackendType.OPFS },
        }, { randomUUID: () => '99999999-8888-4777-8666-555555555555' })).resolves.toBe(OTHER_SESSION_ID);

        const collidingSource = {
            ...ownSource,
            session: testSession({ sessionId: OTHER_SESSION_ID }),
        };
        await expect(replaceSessionWithPortableBundle(backend, collidingSource, {
            sessionId: OTHER_SESSION_ID,
            location: { type: StorageBackendType.OPFS },
        })).rejects.toThrow(`already used by session ${TEST_SESSION_ID}`);
    });

    it('rejects native registration and replacement when another session owns a database UUID', async () => {
        await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
        await backend.saveSessionManifest(THIRD_SESSION_ID, testSession({
            sessionId: THIRD_SESSION_ID,
            mainDatabase: {
                ...testSession().mainDatabase,
                databaseId: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb',
            },
        }));
        await backend.refreshLocations();
        const prepared = {
            dir: '/tmp/imported-native',
            bundle: {
                session: testSession({ sessionId: OTHER_SESSION_ID }),
                schemaSql: null,
                functionsSql: null,
                scripts: [],
            },
        };

        await expect(registerNativeSession(backend, prepared)).rejects.toThrow(
            `already used by session ${TEST_SESSION_ID}`,
        );
        const replacement = {
            ...prepared,
            bundle: {
                ...prepared.bundle,
                session: testSession({ sessionId: THIRD_SESSION_ID }),
            },
        };
        await expect(replaceSessionWithNativeFolder(backend, replacement, {
            sessionId: THIRD_SESSION_ID,
            location: { type: StorageBackendType.OPFS },
        })).rejects.toThrow(`already used by session ${TEST_SESSION_ID}`);
    });
});
