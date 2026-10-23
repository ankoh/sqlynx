import { describe, expect, it } from 'vitest';

import { TestLogger } from '../../platform/logger/test_logger.js';
import { cloneSession, copySession, verifySession } from './session_transfer.js';
import { SessionTestBackend, TEST_CONNECTION_ID, TEST_SESSION_ID, testSession } from './session_test_backend.js';

async function seed(backend: SessionTestBackend): Promise<void> {
    await backend.saveSessionManifest(TEST_SESSION_ID, testSession());
    await backend.saveScript(TEST_SESSION_ID, '01_a.sql', 'SELECT 1');
    await backend.saveScript(TEST_SESSION_ID, '02_b.sql', 'SELECT 2');
}

describe('session transfer', () => {
    it('copies and clones binary data and detects byte corruption', async () => {
        const source = new SessionTestBackend();
        const target = new SessionTestBackend();
        await seed(source);
        const bytes = new Uint8Array([0, 255, 128]);
        await source.saveDataFile(TEST_SESSION_ID, 'payload.bin', bytes);
        expect(await copySession(TEST_SESSION_ID, source, target, new TestLogger())).toEqual({ sessionCount: 1, fileCount: 4 });
        expect(await verifySession(TEST_SESSION_ID, source, target)).toBe(true);
        const cloneId = '99999999-8888-4777-8666-555555555555';
        await cloneSession(TEST_SESSION_ID, source, target, cloneId, new TestLogger());
        expect(await target.loadDataFile(cloneId, 'payload.bin')).toEqual(bytes);
        await target.saveDataFile(TEST_SESSION_ID, 'payload.bin', new Uint8Array([0, 254, 128]));
        expect(await verifySession(TEST_SESSION_ID, source, target)).toBe(false);
    });
    it('copies all flat durable files and verifies the result', async () => {
        const source = new SessionTestBackend();
        const target = new SessionTestBackend();
        await seed(source);
        await expect(copySession(TEST_SESSION_ID, source, target, new TestLogger()))
            .resolves.toEqual({ sessionCount: 1, fileCount: 3 });
        expect(await target.loadScripts(TEST_SESSION_ID)).toEqual(await source.loadScripts(TEST_SESSION_ID));
        expect(await verifySession(TEST_SESSION_ID, source, target)).toBe(true);
    });

    it('clones under a new UUID sharing the connections and rolls back a failed clone', async () => {
        const source = new SessionTestBackend();
        await seed(source);
        await source.saveScript(TEST_SESSION_ID, '03_attachment.sql',
            `SELECT * FROM external('/mnt/fs/sessions/${TEST_SESSION_ID}/attachments/payload.bin')`);
        const target = new SessionTestBackend();
        const cloneId = '99999999-8888-4777-8666-555555555555';
        await cloneSession(TEST_SESSION_ID, source, target, cloneId, new TestLogger());
        const cloned = await target.loadSession(cloneId);
        expect(cloned).toMatchObject({ sessionId: cloneId, name: 'V2 Session (copy)' });
        expect(cloned.defaultConnectionId).toBe(TEST_CONNECTION_ID);
        expect(await target.loadScripts(cloneId)).toHaveLength(3);
        expect((await target.loadScript(cloneId, '03_attachment.sql')).sql).toContain(
            `/mnt/fs/sessions/${cloneId}/attachments/payload.bin`);

        const failing = new SessionTestBackend();
        failing.saveScript = async () => { throw new Error('write failed'); };
        await expect(cloneSession(TEST_SESSION_ID, source, failing, cloneId, new TestLogger()))
            .rejects.toThrow('write failed');
        expect(failing.sessions.has(cloneId)).toBe(false);
    });
});
