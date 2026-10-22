import { describe, expect, it } from 'vitest';

import { migrateSessionData, migrateSessionFiles, sessionFileNames, SESSION_FORMAT_VERSION, type SessionFiles } from './session_file_migration.js';

/// An in-memory session folder
function folder(names: string[]): SessionFiles & { names: Set<string> } {
    const files = new Set(names);
    return {
        names: files,
        exists: async name => files.has(name),
        rename: async (from, to) => {
            files.delete(from);
            files.add(to);
        },
    };
}

describe('session file migration', () => {
    const renames = [{ from: 'a.sql', to: 'b.sql' }, { from: 'b.sql', to: 'c.sql' }, { from: 'x.sql', to: 'y.sql' }];

    it('applies the renames in order', async () => {
        const files = folder(['a.sql', 'other.sql']);
        expect(await migrateSessionFiles(files, renames)).toEqual([renames[0], renames[1]]);
        expect([...files.names].sort()).toEqual(['c.sql', 'other.sql']);
    });

    it('is idempotent', async () => {
        const files = folder(['a.sql']);
        await migrateSessionFiles(files, renames);
        expect(await migrateSessionFiles(files, renames)).toEqual([]);
        expect([...files.names]).toEqual(['c.sql']);
    });

    it('keeps both files when the new one exists already', async () => {
        const files = folder(['x.sql', 'y.sql']);
        expect(await migrateSessionFiles(files, renames)).toEqual([]);
        expect([...files.names].sort()).toEqual(['x.sql', 'y.sql']);
    });
    it('lists the older names of a file, newest first', () => {
        expect(sessionFileNames('c.sql', renames)).toEqual(['c.sql', 'b.sql', 'a.sql']);
        expect(sessionFileNames('other.sql', renames)).toEqual(['other.sql']);
        expect(sessionFileNames('dashql-catalog-relations.sql')).toEqual(['dashql-catalog-relations.sql', 'dashql-relations.sql']);
        expect(sessionFileNames('dashql-session.json')).toEqual(['dashql-session.json', 'dashql-notebook.json']);
        expect(sessionFileNames('dashql-session-index.json')).toEqual(['dashql-session-index.json', 'dashql-notebook-index.json']);
    });

    it('renames the files of notebook folders', async () => {
        const files = folder(['dashql-notebook.json', 'dashql-notebook-index.json']);
        await migrateSessionFiles(files);
        expect([...files.names].sort()).toEqual(['dashql-session-index.json', 'dashql-session.json']);
    });
});

describe('session data migration', () => {
    it('renames the notebook identity of format version 2', () => {
        expect(migrateSessionData({ formatVersion: 2, notebookId: 'id', notebookPath: 'opfs://notebooks/id', name: 'n' }))
            .toEqual({ formatVersion: SESSION_FORMAT_VERSION, sessionId: 'id', sessionPath: 'opfs://notebooks/id', name: 'n' });
        expect(migrateSessionData({ formatVersion: 2, notebookId: 'id' }))
            .toEqual({ formatVersion: SESSION_FORMAT_VERSION, sessionId: 'id' });
    });

    it('leaves other versions to the validation', () => {
        const current = { formatVersion: SESSION_FORMAT_VERSION, sessionId: 'id' };
        expect(migrateSessionData(current)).toBe(current);
        const unknown = { formatVersion: 1, notebookId: 'id' };
        expect(migrateSessionData(unknown)).toBe(unknown);
        expect(migrateSessionData(null)).toBeNull();
    });
});
