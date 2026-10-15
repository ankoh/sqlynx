import { describe, expect, it } from 'vitest';

import { TestLogger } from '../../../platform/logger/test_logger.js';
import { cloneNotebook, copyNotebook, verifyNotebook } from './storage_migration.js';
import { NotebookTestBackend, TEST_DATABASE_ID, TEST_NOTEBOOK_ID, testNotebook } from './notebook_test_backend.js';

async function seed(backend: NotebookTestBackend): Promise<void> {
    await backend.saveNotebookManifest(TEST_NOTEBOOK_ID, testNotebook());
    await backend.saveNotebookSchema(TEST_NOTEBOOK_ID, 'schema');
    await backend.saveNotebookFunctions(TEST_NOTEBOOK_ID, 'functions');
    await backend.saveScript(TEST_NOTEBOOK_ID, '01_a.sql', 'SELECT 1');
    await backend.saveScript(TEST_NOTEBOOK_ID, '02_b.sql', 'SELECT 2');
}

describe('V2 storage migration', () => {
    it('copies and clones binary data and detects byte corruption', async () => {
        const source = new NotebookTestBackend();
        const target = new NotebookTestBackend();
        await seed(source);
        const bytes = new Uint8Array([0, 255, 128]);
        await source.saveDataFile(TEST_NOTEBOOK_ID, 'payload.bin', bytes);
        expect(await copyNotebook(TEST_NOTEBOOK_ID, source, target, new TestLogger())).toEqual({ notebookCount: 1, fileCount: 6 });
        expect(await verifyNotebook(TEST_NOTEBOOK_ID, source, target)).toBe(true);
        const cloneId = '99999999-8888-4777-8666-555555555555';
        await cloneNotebook(TEST_NOTEBOOK_ID, source, target, cloneId, new TestLogger());
        expect(await target.loadDataFile(cloneId, 'payload.bin')).toEqual(bytes);
        await target.saveDataFile(TEST_NOTEBOOK_ID, 'payload.bin', new Uint8Array([0, 254, 128]));
        expect(await verifyNotebook(TEST_NOTEBOOK_ID, source, target)).toBe(false);
    });
    it('copies all flat durable files and verifies the result', async () => {
        const source = new NotebookTestBackend();
        const target = new NotebookTestBackend();
        await seed(source);
        await expect(copyNotebook(TEST_NOTEBOOK_ID, source, target, new TestLogger()))
            .resolves.toEqual({ notebookCount: 1, fileCount: 5 });
        expect(await target.loadScripts(TEST_NOTEBOOK_ID)).toEqual(await source.loadScripts(TEST_NOTEBOOK_ID));
        expect(await verifyNotebook(TEST_NOTEBOOK_ID, source, target)).toBe(true);
    });

    it('clones under a new UUID and rolls back a failed clone', async () => {
        const source = new NotebookTestBackend();
        await seed(source);
        await source.saveScript(TEST_NOTEBOOK_ID, '03_attachment.sql',
            `SELECT * FROM external('/mnt/fs/notebooks/${TEST_NOTEBOOK_ID}/attachments/payload.bin')`);
        const target = new NotebookTestBackend();
        const cloneId = '99999999-8888-4777-8666-555555555555';
        await cloneNotebook(TEST_NOTEBOOK_ID, source, target, cloneId, new TestLogger());
        const cloned = await target.loadNotebook(cloneId);
        expect(cloned).toMatchObject({ notebookId: cloneId, name: 'V2 Notebook (copy)' });
        expect(cloned.mainDatabase.databaseId).not.toBe(TEST_DATABASE_ID);
        expect(await target.loadScripts(cloneId)).toHaveLength(3);
        expect((await target.loadScript(cloneId, '03_attachment.sql')).sql).toContain(
            `/mnt/fs/notebooks/${cloneId}/attachments/payload.bin`);

        const failing = new NotebookTestBackend();
        failing.saveScript = async () => { throw new Error('write failed'); };
        await expect(cloneNotebook(TEST_NOTEBOOK_ID, source, failing, cloneId, new TestLogger()))
            .rejects.toThrow('write failed');
        expect(failing.notebooks.has(cloneId)).toBe(false);
    });
});
