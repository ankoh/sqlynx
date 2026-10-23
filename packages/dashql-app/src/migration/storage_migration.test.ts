import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Logger } from '../platform/logger/logger.js';
import { OPFSDirectoryMock } from '../tests/opfs_mock.js';
import { fsStore, makeFsMock, resetFsStore } from '../app/storage/test_fs_mock.js';
import { migrateStorage, STORAGE_MIGRATION_STEPS } from './storage_migration.js';
import { SESSION_FORMAT_VERSION, STORAGE_VERSION } from './versions.js';

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

const SESSION_A = '11111111-0000-4000-8000-00000000000a';
const SESSION_B = '11111111-0000-4000-8000-00000000000b';
const DB_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const DB_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const WASM = { hyper: { protocol: 'WASM' } };
const NATIVE_DIR = '/home/user/session';

/// The metadata of a notebook of format version 2
function notebook(notebookId: string, databaseId: string): string {
    return JSON.stringify({
        formatVersion: 2,
        notebookId,
        mainDatabase: { databaseId, params: WASM },
        attachedDatabases: [],
        metadata: {},
    });
}

describe('storage migration', () => {
    let files: Map<string, string | ArrayBuffer>;
    let dirs: Set<string>;
    let root: FileSystemDirectoryHandle;
    const text = (path: string) => {
        const value = files.get(path);
        return typeof value === 'string' || value === undefined ? value : new TextDecoder().decode(value);
    };
    const json = (path: string) => JSON.parse(text(path)!);

    beforeEach(() => {
        files = new Map();
        dirs = new Set();
        root = new OPFSDirectoryMock('', files, dirs) as unknown as FileSystemDirectoryHandle;
        resetFsStore();
        globalThis.dashqlElectron = { fs: makeFsMock() } as unknown as DashQLElectronBridge;
    });

    afterEach(() => {
        delete globalThis.dashqlElectron;
    });

    it('ends with the current storage version', () => {
        expect(STORAGE_MIGRATION_STEPS.map(step => step.version))
            .toEqual(Array.from({ length: STORAGE_VERSION - 1 }, (_, i) => i + 2));
    });

    it('leaves a fresh storage untouched', async () => {
        await migrateStorage(new NullLogger(), root);
        expect(files.size).toBe(0);
        expect(dirs.size).toBe(0);
    });

    it('brings a notebook storage to the current version', async () => {
        files.set('dashql-manifest.json', JSON.stringify({
            notebooks: [{ path: SESSION_A }, { path: SESSION_B, storageType: 'native', nativePath: NATIVE_DIR }],
            appSettings: { keywordCase: 'upper' },
        }));
        dirs.add('notebooks');
        dirs.add(`notebooks/${SESSION_A}`);
        dirs.add(`notebooks/${SESSION_A}/scripts`);
        files.set(`notebooks/${SESSION_A}/dashql-notebook.json`, notebook(SESSION_A, DB_A));
        files.set(`notebooks/${SESSION_A}/dashql-relations.sql`, 'CREATE TABLE a(id int);');
        files.set(`notebooks/${SESSION_A}/scripts/1_a.sql`, 'SELECT 1');
        fsStore.dirs.add(NATIVE_DIR);
        fsStore.files.set(`${NATIVE_DIR}/dashql-notebook.json`, notebook(SESSION_B, DB_B));

        await migrateStorage(new NullLogger(), root);

        // The manifest lists sessions and the consolidated connections
        const manifest = json('dashql-manifest.json');
        expect(manifest.sessions).toEqual([{ path: SESSION_A }, { path: SESSION_B, storageType: 'native', nativePath: NATIVE_DIR }]);
        expect(manifest.notebooks).toBeUndefined();
        expect(manifest.appSettings).toEqual({ keywordCase: 'upper' });
        expect(manifest.storageVersion).toBe(STORAGE_VERSION);
        expect(manifest.connections.map((entry: { id: string; aliases?: string[] }) => [entry.id, entry.aliases])).toEqual([[DB_A, [DB_B]]]);
        expect(text(`connections/${DB_A}/dashql-catalog-relations.sql`)).toBe('CREATE TABLE a(id int);');

        // The OPFS session moved and is at the current format
        expect([...dirs].filter(dir => dir.startsWith('notebooks'))).toEqual([]);
        expect([...files.keys()].filter(file => file.startsWith('notebooks'))).toEqual([]);
        const sessionA = json(`sessions/${SESSION_A}/dashql-session.json`);
        expect(sessionA.formatVersion).toBe(SESSION_FORMAT_VERSION);
        expect(sessionA.sessionId).toBe(SESSION_A);
        expect(text(`sessions/${SESSION_A}/dashql-catalog-relations.sql`)).toBe('CREATE TABLE a(id int);');
        expect(text(`sessions/${SESSION_A}/scripts/1_a.sql`)).toBe('SELECT 1');

        // The native session references the consolidated connection
        expect(fsStore.files.has(`${NATIVE_DIR}/dashql-notebook.json`)).toBe(false);
        const sessionB = JSON.parse(fsStore.files.get(`${NATIVE_DIR}/dashql-session.json`)!);
        expect(sessionB.formatVersion).toBe(SESSION_FORMAT_VERSION);
        expect(sessionB.sessionId).toBe(SESSION_B);
        expect(sessionB.defaultConnectionId).toBe(DB_A);
        expect(sessionB.connections.map((connection: { connectionId: string }) => connection.connectionId)).toEqual([DB_A]);

        // A migrated storage stays as it is
        const before = text('dashql-manifest.json');
        await migrateStorage(new NullLogger(), root);
        expect(text('dashql-manifest.json')).toBe(before);
    });

    it('keeps the connections of a storage that has them already', async () => {
        const connections = [{ id: DB_B, params: WASM, createdAt: '2026-10-22T00:00:00.000Z' }];
        files.set('dashql-manifest.json', JSON.stringify({ notebooks: [{ path: SESSION_A }], connections }));
        dirs.add('notebooks');
        dirs.add(`notebooks/${SESSION_A}`);
        files.set(`notebooks/${SESSION_A}/dashql-notebook.json`, notebook(SESSION_A, DB_B));

        await migrateStorage(new NullLogger(), root);
        expect(json('dashql-manifest.json').connections).toEqual(connections);
        expect(json(`sessions/${SESSION_A}/dashql-session.json`).sessionId).toBe(SESSION_A);
    });

    it('migrates the sessions of a current storage', async () => {
        files.set('dashql-manifest.json', JSON.stringify({ sessions: [{ path: SESSION_A }], connections: [], storageVersion: STORAGE_VERSION }));
        dirs.add('sessions');
        dirs.add(`sessions/${SESSION_A}`);
        files.set(`sessions/${SESSION_A}/dashql-notebook.json`, notebook(SESSION_A, DB_A));

        await migrateStorage(new NullLogger(), root);
        expect(json(`sessions/${SESSION_A}/dashql-session.json`).formatVersion).toBe(SESSION_FORMAT_VERSION);
    });

    it('refuses a storage of a newer version', async () => {
        const manifest = JSON.stringify({ sessions: [], storageVersion: STORAGE_VERSION + 1 });
        files.set('dashql-manifest.json', manifest);
        await expect(migrateStorage(new NullLogger(), root)).rejects.toThrow('newer version of DashQL');
        expect(text('dashql-manifest.json')).toBe(manifest);
    });
});
