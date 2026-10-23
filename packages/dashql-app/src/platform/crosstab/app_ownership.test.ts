import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppOwnership, AppOwnershipTimeoutError, type AppOwnershipEnvironment } from './app_ownership.js';
import { OPFSStorageBackend } from '../../app/storage/opfs_storage_backend.js';
import { STORAGE_SESSIONS_FOLDER } from '../../app/storage/storage_backend.js';
import { StorageWriter, WRITE_SCRIPT, groupScriptWrites } from '../../app/storage/storage_writer.js';
import { Logger } from '../logger/logger.js';

class NullLogger extends Logger {
    public destroy(): void { }
    protected flushPendingRecords(): void { }
}

/// A browsing context of the origin that stands in for a tab, it has its own locks and channels
interface TestTab {
    environment: AppOwnershipEnvironment;
    /// Close the tab, the browser releases its locks
    close(): void;
}

describe('AppOwnership', () => {
    const frames: HTMLIFrameElement[] = [];
    let names = { lockName: '', channelName: '' };

    function openTab(): TestTab {
        if (frames.length === 0) {
            // Every test runs on its own lock and channel
            const id = crypto.randomUUID();
            names = { lockName: `dashql-test-app-${id}`, channelName: `dashql-test-app-${id}` };
        }
        const frame = document.createElement('iframe');
        document.body.appendChild(frame);
        frames.push(frame);
        const tab = frame.contentWindow as Window & typeof globalThis;
        return {
            environment: { ...names, locks: tab.navigator.locks, openChannel: name => new tab.BroadcastChannel(name) },
            close: () => frame.remove(),
        };
    }

    afterEach(() => {
        for (const frame of frames.splice(0)) {
            frame.remove();
        }
    });

    const stopNothing = async () => { };

    it('grants the app to one tab at a time', async () => {
        const [a, b] = [openTab(), openTab()];
        const owner = await AppOwnership.tryAcquire(a.environment, stopNothing);
        expect(owner).not.toBeNull();
        expect(await AppOwnership.tryAcquire(b.environment, stopNothing)).toBeNull();

        owner!.dispose();
        await owner!.released;
        expect(await AppOwnership.tryAcquire(b.environment, stopNothing)).not.toBeNull();
    });

    it('hands over the app after the owner stopped its writers', async () => {
        const [a, b, c] = [openTab(), openTab(), openTab()];
        const events: string[] = [];
        const owner = await AppOwnership.tryAcquire(a.environment, async () => {
            events.push('a stops');
            await new Promise(resolve => setTimeout(resolve, 50));
            events.push('a stopped');
        });
        expect(owner).not.toBeNull();

        await AppOwnership.takeOver(b.environment, stopNothing, 5_000);
        events.push('b owns');
        await owner!.released;

        expect(events).toEqual(['a stops', 'a stopped', 'b owns']);
        expect(await AppOwnership.tryAcquire(c.environment, stopNothing)).toBeNull();
    });

    it('releases the app when the owner tab is closed', async () => {
        const [a, b] = [openTab(), openTab()];
        expect(await AppOwnership.tryAcquire(a.environment, stopNothing)).not.toBeNull();
        a.close();

        await vi.waitFor(async () => {
            expect(await AppOwnership.tryAcquire(b.environment, stopNothing)).not.toBeNull();
        });
    });

    it('takes over a free app without handing it to itself', async () => {
        const [a, b] = [openTab(), openTab()];
        const handOver = vi.fn(stopNothing);
        const owner = await AppOwnership.takeOver(a.environment, handOver, 5_000);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(handOver).not.toHaveBeenCalled();
        expect(await AppOwnership.tryAcquire(b.environment, stopNothing)).toBeNull();
        owner.dispose();
    });

    it('leaves the app with an owner that does not hand it over', async () => {
        const [a, b, c] = [openTab(), openTab(), openTab()];
        let stopped!: () => void;
        const owner = await AppOwnership.tryAcquire(a.environment, () => new Promise<void>(resolve => { stopped = resolve; }));
        expect(owner).not.toBeNull();

        await expect(AppOwnership.takeOver(b.environment, stopNothing, 200)).rejects.toBeInstanceOf(AppOwnershipTimeoutError);
        expect(await AppOwnership.tryAcquire(c.environment, stopNothing)).toBeNull();

        // The request of the tab that gave up is withdrawn, the lock is free once the owner stops
        stopped();
        await owner!.released;
        expect(await AppOwnership.tryAcquire(c.environment, stopNothing)).not.toBeNull();
    });

    it('writes the pending changes of the owner before the next tab reads them', async () => {
        const [a, b] = [openTab(), openTab()];
        const sessionId = crypto.randomUUID();
        const backend = new OPFSStorageBackend();
        await backend.initialize();
        const writer = new StorageWriter(new NullLogger(), backend);
        try {
            const owner = await AppOwnership.tryAcquire(a.environment, async () => {
                writer.pause();
                await writer.flush();
            });
            expect(owner).not.toBeNull();

            // The write is debounced far beyond the takeover
            const write = writer.write(groupScriptWrites(sessionId, 'a.sql'), {
                type: WRITE_SCRIPT,
                value: [sessionId, 'a.sql', 'SELECT 42'],
            }, 60_000);

            await AppOwnership.takeOver(b.environment, stopNothing, 5_000);
            expect((await backend.loadScript(sessionId, 'a.sql')).sql).toBe('SELECT 42');
            expect(await write).toBe(true);
        } finally {
            const root = await navigator.storage.getDirectory();
            const sessions = await root.getDirectoryHandle(STORAGE_SESSIONS_FOLDER);
            await sessions.removeEntry(sessionId, { recursive: true });
        }
    });
});
