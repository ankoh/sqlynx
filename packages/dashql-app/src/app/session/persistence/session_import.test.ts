import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { importSessionFromZip, readSessionBundleFromZip } from './session_import.js';
import { STORAGE_SESSION_FILE } from '../../storage/storage_backend.js';
import { SessionTestBackend, TEST_SESSION_ID, testSession } from '../../storage/session_test_backend.js';

async function zip(files: Record<string, string>): Promise<Blob> {
    const archive = new JSZip();
    for (const [path, text] of Object.entries(files)) archive.file(path, text);
    return archive.generateAsync({ type: 'blob' });
}

describe('V2 session ZIP import', () => {
    it('reads naturally ordered flat scripts and ignores derived files', async () => {
        const bundle = await readSessionBundleFromZip(await zip({
            [STORAGE_SESSION_FILE]: JSON.stringify(testSession()),
            'dashql-catalog-relations.sql': 'schema',
            'dashql-catalog-functions.sql': 'functions',
            'scripts/10_last.sql': 'SELECT 10',
            'scripts/2_first.sql': 'SELECT 2',
            'dashql-session-index.json': '{"scripts":[]}',
            'cache/result.arrow': 'derived',
        }));

        expect(bundle).toEqual({
            session: testSession(),
            schemaSql: 'schema',
            functionsSql: 'functions',
            data: [],
            scripts: [
                { name: '2_first.sql', sql: 'SELECT 2' },
                { name: '10_last.sql', sql: 'SELECT 10' },
            ],
        });
    });

    it('migrates bundles exported by older versions', async () => {
        const bundle = await readSessionBundleFromZip(await zip({
            'dashql-notebook.json': JSON.stringify({ ...testSession(), formatVersion: 2, sessionId: undefined, notebookId: TEST_SESSION_ID }),
            'dashql-relations.sql': 'schema',
            'dashql-functions.sql': 'functions',
            'scripts/01_query.sql': 'SELECT 1',
        }));
        expect(bundle.session).toEqual(testSession());
        expect(bundle.schemaSql).toBe('schema');
        expect(bundle.functionsSql).toBe('functions');
        expect(bundle.scripts).toEqual([{ name: '01_query.sql', sql: 'SELECT 1' }]);
    });

    it.each([
        ['nested scripts', 'scripts/page/query.sql', 'directly inside scripts/'],
        ['draft scripts', 'scripts/dashql-draft.sql', 'draft scripts are not supported'],
        ['nested attachment', 'attachments/folder/payload.bin', 'directly inside attachments/'],
        ['backslash attachment', 'attachments/payload\\name.bin', 'basename'],
        ['NUL attachment', 'attachments/payload\0.bin', 'basename'],
    ])('rejects %s before mutating storage', async (_label, path, message) => {
        const backend = new SessionTestBackend();
        await expect(importSessionFromZip(await zip({
            [STORAGE_SESSION_FILE]: JSON.stringify(testSession()),
            [path]: 'SELECT 1',
        }), backend)).rejects.toThrow(message);
        expect(backend.calls).toEqual([]);
    });

    it('strictly refuses V1 metadata before allocating or writing', async () => {
        const backend = new SessionTestBackend();
        const idFactory = vi.fn(() => crypto.randomUUID());
        await expect(importSessionFromZip(await zip({
            [STORAGE_SESSION_FILE]: JSON.stringify({ ...testSession(), formatVersion: 1 }),
        }), backend, idFactory)).rejects.toThrow('Unsupported session format version');
        expect(idFactory).not.toHaveBeenCalled();
        expect(backend.calls).toEqual([]);
    });

    it('writes every flat durable file and can target a fresh UUID', async () => {
        const backend = new SessionTestBackend();
        const target = '99999999-8888-4777-8666-555555555555';
        await expect(importSessionFromZip(await zip({
            [STORAGE_SESSION_FILE]: JSON.stringify(testSession()),
            'dashql-catalog-relations.sql': 'schema',
            'scripts/01_query.sql': 'SELECT 1',
        }), backend, { targetSessionId: target, targetIsFresh: true })).resolves.toBe(target);

        expect(await backend.loadSession(target)).toMatchObject({ sessionId: target });
        expect(await backend.loadScripts(target)).toEqual([{ name: '01_query.sql', sql: 'SELECT 1' }]);
        expect(await backend.loadSessionSchema(target)).toBe('schema');
        expect(await backend.loadSessionFunctions(target)).toBe('');
        expect(backend.sessions.has(TEST_SESSION_ID)).toBe(false);
    });

    it('rolls back only a caller-declared fresh target', async () => {
        const backend = new SessionTestBackend();
        backend.saveScript = vi.fn(async () => { throw new Error('write failed'); });
        const blob = await zip({
            [STORAGE_SESSION_FILE]: JSON.stringify(testSession()),
            'scripts/01_query.sql': 'SELECT 1',
        });
        const target = '99999999-8888-4777-8666-555555555555';

        await expect(importSessionFromZip(blob, backend, { targetSessionId: target, targetIsFresh: true }))
            .rejects.toThrow('write failed');
        expect(backend.calls).toContain(`delete-session:${target}`);
    });
});
