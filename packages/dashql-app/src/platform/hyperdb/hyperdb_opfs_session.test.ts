import { describe, expect, it, vi } from 'vitest';

import { cleanupStaleHyperDBOPFSSessions } from './hyperdb_opfs_session.js';

describe('HyperDB stale OPFS session cleanup', () => {
    it.each(['InvalidModificationError', 'NoModificationAllowedError', 'NotFoundError'])(
        'defers directories with %s and continues cleaning other sessions', async errorName => {
            const locked = `dashql-session-${crypto.randomUUID()}`;
            const stale = `dashql-session-${crypto.randomUUID()}`;
            const removeEntry = vi.fn(async (name: string) => {
                if (name === locked) throw new DOMException('File cannot be removed', errorName);
            });
            const root = {
                async *entries() {
                    yield [locked, { kind: 'directory' }];
                    yield [stale, { kind: 'directory' }];
                },
                removeEntry,
            } as unknown as FileSystemDirectoryHandle;

            await cleanupStaleHyperDBOPFSSessions(async () => root);

            expect(removeEntry).toHaveBeenCalledWith(locked, { recursive: true });
            expect(removeEntry).toHaveBeenCalledWith(stale, { recursive: true });
        },
    );

    it('does not suppress unrelated cleanup failures', async () => {
        const root = {
            async *entries() {
                yield [`dashql-session-${crypto.randomUUID()}`, { kind: 'directory' }];
            },
            async removeEntry() {
                throw new DOMException('Access denied', 'NotAllowedError');
            },
        } as unknown as FileSystemDirectoryHandle;

        await expect(cleanupStaleHyperDBOPFSSessions(async () => root)).rejects.toThrow('Access denied');
    });
});
