import { describe, expect, it } from 'vitest';

import { MemoryFolder, OverlayFolder } from './migration_folder.js';
import { migrateSessionFolder, SESSION_MIGRATION_STEPS, SessionMigrationResult, type SessionMigrationStep } from './session_migration.js';
import { SESSION_FORMAT_VERSION } from './versions.js';

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
        expect([...folder.files.keys()].sort()).toEqual([
            'dashql-catalog-functions.sql', 'dashql-catalog-relations.sql', 'dashql-session-index.json', 'dashql-session.json',
        ]);
        const metadata = JSON.parse(folder.files.get('dashql-session.json')!);
        expect(metadata).toEqual({ formatVersion: SESSION_FORMAT_VERSION, sessionId: SESSION_ID, sessionPath: 'opfs://notebooks/x', name: 'n' });
        expect(Object.keys(metadata)).toEqual(['formatVersion', 'sessionId', 'sessionPath', 'name']);
        expect(folder.files.get('dashql-catalog-relations.sql')).toBe('relations');

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

    it('migrates an overlay without touching its base', async () => {
        const base = notebookFolder();
        const before = new Map(base.files);
        const overlay = new OverlayFolder(base);
        expect(await migrateSessionFolder(overlay)).toBe(SessionMigrationResult.Migrated);
        expect(base.files).toEqual(before);
        expect(await overlay.exists('dashql-notebook.json')).toBe(false);
        expect(JSON.parse((await overlay.readText('dashql-session.json'))!).sessionId).toBe(SESSION_ID);
        expect(await overlay.readText('dashql-catalog-functions.sql')).toBe('functions');
    });
});
