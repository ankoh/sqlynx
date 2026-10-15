import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { importNotebookFromZip, readNotebookBundleFromZip } from './notebook_import.js';
import { STORAGE_NOTEBOOK_FILE } from './storage_backend.js';
import { NotebookTestBackend, TEST_NOTEBOOK_ID, testNotebook } from './notebook_test_backend.js';

async function zip(files: Record<string, string>): Promise<Blob> {
    const archive = new JSZip();
    for (const [path, text] of Object.entries(files)) archive.file(path, text);
    return archive.generateAsync({ type: 'blob' });
}

describe('V2 notebook ZIP import', () => {
    it('reads naturally ordered flat scripts and ignores derived files', async () => {
        const bundle = await readNotebookBundleFromZip(await zip({
            [STORAGE_NOTEBOOK_FILE]: JSON.stringify(testNotebook()),
            'dashql-relations.sql': 'schema',
            'dashql-functions.sql': 'functions',
            'scripts/10_last.sql': 'SELECT 10',
            'scripts/2_first.sql': 'SELECT 2',
            'dashql-notebook-index.json': '{"scripts":[]}',
            'cache/result.arrow': 'derived',
        }));

        expect(bundle).toEqual({
            notebook: testNotebook(),
            schemaSql: 'schema',
            functionsSql: 'functions',
            data: [],
            scripts: [
                { name: '2_first.sql', sql: 'SELECT 2' },
                { name: '10_last.sql', sql: 'SELECT 10' },
            ],
        });
    });

    it.each([
        ['nested scripts', 'scripts/page/query.sql', 'directly inside scripts/'],
        ['draft scripts', 'scripts/dashql-draft.sql', 'draft scripts are not supported'],
        ['nested attachment', 'attachments/folder/payload.bin', 'directly inside attachments/'],
        ['backslash attachment', 'attachments/payload\\name.bin', 'basename'],
        ['NUL attachment', 'attachments/payload\0.bin', 'basename'],
    ])('rejects %s before mutating storage', async (_label, path, message) => {
        const backend = new NotebookTestBackend();
        await expect(importNotebookFromZip(await zip({
            [STORAGE_NOTEBOOK_FILE]: JSON.stringify(testNotebook()),
            [path]: 'SELECT 1',
        }), backend)).rejects.toThrow(message);
        expect(backend.calls).toEqual([]);
    });

    it('strictly refuses V1 metadata before allocating or writing', async () => {
        const backend = new NotebookTestBackend();
        const idFactory = vi.fn(() => crypto.randomUUID());
        await expect(importNotebookFromZip(await zip({
            [STORAGE_NOTEBOOK_FILE]: JSON.stringify({ ...testNotebook(), formatVersion: 1 }),
        }), backend, idFactory)).rejects.toThrow('Unsupported notebook format version');
        expect(idFactory).not.toHaveBeenCalled();
        expect(backend.calls).toEqual([]);
    });

    it('writes every flat durable file and can target a fresh UUID', async () => {
        const backend = new NotebookTestBackend();
        const target = '99999999-8888-4777-8666-555555555555';
        await expect(importNotebookFromZip(await zip({
            [STORAGE_NOTEBOOK_FILE]: JSON.stringify(testNotebook()),
            'dashql-relations.sql': 'schema',
            'scripts/01_query.sql': 'SELECT 1',
        }), backend, { targetNotebookId: target, targetIsFresh: true })).resolves.toBe(target);

        expect(await backend.loadNotebook(target)).toMatchObject({ notebookId: target });
        expect(await backend.loadScripts(target)).toEqual([{ name: '01_query.sql', sql: 'SELECT 1' }]);
        expect(await backend.loadNotebookSchema(target)).toBe('schema');
        expect(await backend.loadNotebookFunctions(target)).toBe('');
        expect(backend.notebooks.has(TEST_NOTEBOOK_ID)).toBe(false);
    });

    it('rolls back only a caller-declared fresh target', async () => {
        const backend = new NotebookTestBackend();
        backend.saveScript = vi.fn(async () => { throw new Error('write failed'); });
        const blob = await zip({
            [STORAGE_NOTEBOOK_FILE]: JSON.stringify(testNotebook()),
            'scripts/01_query.sql': 'SELECT 1',
        });
        const target = '99999999-8888-4777-8666-555555555555';

        await expect(importNotebookFromZip(blob, backend, { targetNotebookId: target, targetIsFresh: true }))
            .rejects.toThrow('write failed');
        expect(backend.calls).toContain(`delete-notebook:${target}`);
    });
});
