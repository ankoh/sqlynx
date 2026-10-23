import { describe, expect, it } from 'vitest';

import { MemoryFolder, OverlayFolder } from './migration_folder.js';
import { migrateSessionFolder, SESSION_MIGRATION_STEPS, SessionMigrationResult, type SessionMigrationStep } from './session_migration.js';
import { SESSION_FORMAT_VERSION } from './versions.js';
import { scriptsInSessionFile } from './session/v5_scripts_in_session_file.js';
import { sessionConnections } from './session/v6_session_connections.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

/// A session folder as notebooks wrote it, before the catalog files had their prefix
function notebookFolder(): MemoryFolder {
    return new MemoryFolder([
        ['dashql-notebook.json', JSON.stringify({ formatVersion: 2, notebookId: SESSION_ID, notebookPath: 'opfs://notebooks/x', name: 'n' })],
        ['dashql-notebook-index.json', '{"scripts":[]}'],
        ['dashql-relations.sql', 'relations'],
        ['dashql-functions.sql', 'functions'],
    ]);
}

describe('session migration', () => {
    it('ends with the current format version', () => {
        expect(SESSION_MIGRATION_STEPS.map(step => step.version))
            .toEqual(Array.from({ length: SESSION_FORMAT_VERSION - 2 }, (_, i) => i + 3));
    });

    it('brings a notebook folder to the current format', async () => {
        const folder = notebookFolder();
        expect(await migrateSessionFolder(folder)).toBe(SessionMigrationResult.Migrated);
        // The catalog copies are gone, the catalog belongs to the connection
        expect([...folder.files.keys()]).toEqual(['dashql-session.json']);
        const metadata = JSON.parse(folder.files.get('dashql-session.json')!);
        expect(metadata).toEqual({
            formatVersion: SESSION_FORMAT_VERSION, sessionId: SESSION_ID, sessionPath: 'opfs://notebooks/x', name: 'n',
            scripts: [], attachments: [], defaultConnectionId: null, connections: [],
        });
        expect(Object.keys(metadata)).toEqual([
            'formatVersion', 'sessionId', 'sessionPath', 'name', 'scripts', 'attachments', 'defaultConnectionId', 'connections',
        ]);

        // A migrated folder stays as it is
        const before = new Map(folder.files);
        expect(await migrateSessionFolder(folder)).toBe(SessionMigrationResult.Current);
        expect(folder.files).toEqual(before);
    });

    it('stops at a target version', async () => {
        const folder = notebookFolder();
        expect(await migrateSessionFolder(folder, 3)).toBe(SessionMigrationResult.Migrated);
        expect(JSON.parse(folder.files.get('dashql-notebook.json')!).formatVersion).toBe(3);
        expect(folder.files.has('dashql-catalog-relations.sql')).toBe(true);
        expect(folder.files.has('dashql-session.json')).toBe(false);
    });

    it.each([
        ['missing metadata', [], SessionMigrationResult.Missing],
        ['metadata without a version', [['dashql-session.json', '{}']], SessionMigrationResult.Unsupported],
        ['metadata of version 1', [['dashql-notebook.json', '{"formatVersion":1}']], SessionMigrationResult.Unsupported],
        ['invalid metadata', [['dashql-session.json', '{']], SessionMigrationResult.Unsupported],
        ['metadata of a newer version', [['dashql-session.json', `{"formatVersion":${SESSION_FORMAT_VERSION + 1}}`]], SessionMigrationResult.Newer],
    ] as Array<[string, Array<[string, string]>, SessionMigrationResult]>)('leaves a folder with %s untouched', async (_label, files, result) => {
        const folder = new MemoryFolder([...files, ['dashql-relations.sql', 'relations']]);
        const before = new Map(folder.files);
        expect(await migrateSessionFolder(folder)).toBe(result);
        expect(folder.files).toEqual(before);
    });

    it('repeats an interrupted step', async () => {
        let attempts = 0;
        const steps: SessionMigrationStep[] = [
            { version: 3, description: 'first', migrate: async folder => { await folder.writeText('a', 'a'); } },
            {
                version: 4, description: 'second', migrate: async folder => {
                    if (++attempts === 1) throw new Error('interrupted');
                    await folder.writeText('b', 'b');
                },
            },
        ];
        const folder = new MemoryFolder([['dashql-session.json', '{"formatVersion":2}']]);
        await expect(migrateSessionFolder(folder, 4, steps)).rejects.toThrow('interrupted');
        expect(JSON.parse(folder.files.get('dashql-session.json')!).formatVersion).toBe(3);
        expect(await migrateSessionFolder(folder, 4, steps)).toBe(SessionMigrationResult.Migrated);
        expect(JSON.parse(folder.files.get('dashql-session.json')!).formatVersion).toBe(4);
        expect(folder.files.get('b')).toBe('b');
    });

    it('lists the main and the attached databases as connections in place of the main database', async () => {
        const main = { databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', params: { hyper: {} } };
        const attached = { databaseId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', params: { trino: {} }, paramsDraft: { trino: { endpoint: 'x' } } };
        const folder = new MemoryFolder([
            ['dashql-session.json', JSON.stringify({ formatVersion: 4, sessionId: SESSION_ID, name: 'n', mainDatabase: main, attachedDatabases: [attached], metadata: {} })],
        ]);
        expect(await migrateSessionFolder(folder)).toBe(SessionMigrationResult.Migrated);
        const metadata = JSON.parse(folder.files.get('dashql-session.json')!);
        expect(metadata).toEqual({
            formatVersion: SESSION_FORMAT_VERSION, sessionId: SESSION_ID, name: 'n',
            defaultConnectionId: main.databaseId,
            connections: [
                { connectionId: main.databaseId, params: main.params },
                { connectionId: attached.databaseId, params: attached.params, paramsDraft: attached.paramsDraft },
            ],
            metadata: {}, scripts: [], attachments: [],
        });
        expect(Object.keys(metadata)).toEqual([
            'formatVersion', 'sessionId', 'name', 'defaultConnectionId', 'connections', 'metadata', 'scripts', 'attachments',
        ]);
    });

    it('turns the databases of a version 5 session into connections, the scripts follow them', async () => {
        const main = { databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', params: { hyper: {} } };
        const attached = { databaseId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', params: { trino: {} } };
        const folder = new MemoryFolder([
            ['dashql-session.json', JSON.stringify({
                formatVersion: 5, sessionId: SESSION_ID, mainDatabase: main, attachedDatabases: [attached],
                scripts: [{ name: 'b.sql', databaseId: attached.databaseId }, { name: 'a.sql', databaseId: main.databaseId }],
                attachments: [], metadata: {},
            })],
        ]);
        expect(await migrateSessionFolder(folder)).toBe(SessionMigrationResult.Migrated);
        const metadata = JSON.parse(folder.files.get('dashql-session.json')!);
        expect(metadata).toEqual({
            formatVersion: SESSION_FORMAT_VERSION, sessionId: SESSION_ID,
            defaultConnectionId: main.databaseId,
            connections: [
                { connectionId: main.databaseId, params: main.params },
                { connectionId: attached.databaseId, params: attached.params },
            ],
            scripts: [{ name: 'b.sql', connectionId: attached.databaseId }, { name: 'a.sql', connectionId: main.databaseId }],
            attachments: [], metadata: {},
        });
        // Repeating the step changes nothing
        const before = folder.files.get('dashql-session.json');
        await sessionConnections.migrate(folder);
        expect(folder.files.get('dashql-session.json')).toBe(before);
    });

    it('moves the index into the session metadata with the default connection', async () => {
        const connectionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const folder = new MemoryFolder([
            ['dashql-session.json', JSON.stringify({ formatVersion: 4, sessionId: SESSION_ID, mainDatabase: { databaseId: connectionId } })],
            ['dashql-session-index.json', JSON.stringify({ scripts: [{ name: '10_b.sql' }, { name: '2_a.sql' }], data: [{ name: 'x.csv' }] })],
        ]);
        expect(await migrateSessionFolder(folder)).toBe(SessionMigrationResult.Migrated);
        expect(folder.files.has('dashql-session-index.json')).toBe(false);
        const metadata = JSON.parse(folder.files.get('dashql-session.json')!);
        expect(metadata.formatVersion).toBe(SESSION_FORMAT_VERSION);
        expect(metadata.scripts).toEqual([{ name: '10_b.sql', connectionId }, { name: '2_a.sql', connectionId }]);
        expect(metadata.attachments).toEqual([{ name: 'x.csv' }]);

        // Repeating the step after an interruption keeps the moved list and only removes the index
        folder.files.set('dashql-session-index.json', '{"scripts":[]}');
        await scriptsInSessionFile.migrate(folder);
        expect(folder.files.has('dashql-session-index.json')).toBe(false);
        expect(JSON.parse(folder.files.get('dashql-session.json')!).scripts).toEqual(metadata.scripts);
    });

    it.each([
        ['without an index', null],
        ['with a broken index', '{'],
    ])('lists no scripts of a folder %s', async (_label, index) => {
        const folder = new MemoryFolder([
            ['dashql-session.json', JSON.stringify({ formatVersion: 4, sessionId: SESSION_ID, mainDatabase: { databaseId: 'x' } })],
            ...(index == null ? [] : [['dashql-session-index.json', index] as [string, string]]),
        ]);
        expect(await migrateSessionFolder(folder)).toBe(SessionMigrationResult.Migrated);
        expect(folder.files.has('dashql-session-index.json')).toBe(false);
        expect(JSON.parse(folder.files.get('dashql-session.json')!)).toMatchObject({ scripts: [], attachments: [] });
    });

    it('migrates an overlay without touching its base', async () => {
        const base = notebookFolder();
        const before = new Map(base.files);
        const overlay = new OverlayFolder(base);
        expect(await migrateSessionFolder(overlay)).toBe(SessionMigrationResult.Migrated);
        expect(base.files).toEqual(before);
        expect(await overlay.exists('dashql-notebook.json')).toBe(false);
        expect(JSON.parse((await overlay.readText('dashql-session.json'))!).sessionId).toBe(SESSION_ID);
        expect(await overlay.readText('dashql-catalog-functions.sql')).toBeNull();
    });

    it('removes the catalog copies of a version 6 session', async () => {
        const folder = new MemoryFolder([
            ['dashql-session.json', JSON.stringify({ formatVersion: 6, sessionId: SESSION_ID, defaultConnectionId: 'x', connections: [] })],
            ['dashql-catalog-relations.sql', 'relations'],
            ['dashql-catalog-functions.sql', 'functions'],
            ['dashql-catalog-changes.sql', 'changes'],
        ]);
        expect(await migrateSessionFolder(folder)).toBe(SessionMigrationResult.Migrated);
        expect([...folder.files.keys()]).toEqual(['dashql-session.json']);
        expect(JSON.parse(folder.files.get('dashql-session.json')!).formatVersion).toBe(7);
    });
});
