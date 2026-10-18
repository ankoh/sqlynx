import { describe, expect, it } from 'vitest';

import { readSqlFile, scanSqlFiles, sha256Hex } from './scan.js';

async function write(directory: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
}

describe('scanSqlFiles', () => {
    it('collects .sql files recursively and skips hidden folders and node_modules', async () => {
        const root = await navigator.storage.getDirectory();
        const name = `dashql-atlas-scan-${crypto.randomUUID()}`;
        const directory = await root.getDirectoryHandle(name, { create: true });
        try {
            await write(directory, 'b.sql', 'select 2');
            await write(directory, 'a.SQL', 'select 1');
            await write(directory, 'notes.txt', 'not sql');
            const nested = await directory.getDirectoryHandle('reports', { create: true });
            await write(nested, 'c.sql', 'select 3');
            await write(await directory.getDirectoryHandle('.git', { create: true }), 'hidden.sql', 'select 4');
            await write(await directory.getDirectoryHandle('node_modules', { create: true }), 'dep.sql', 'select 5');

            const files = await scanSqlFiles(directory);
            expect(files.map(f => f.id)).toEqual(['a.SQL', 'b.sql', 'reports/c.sql']);
            expect(files[2].text).toBe('select 3');
            expect(files[0].hash).toBe(await sha256Hex('select 1'));
            expect(await readSqlFile(directory, 'reports/c.sql')).toBe('select 3');
        } finally {
            await root.removeEntry(name, { recursive: true });
        }
    });

    it('hashes like sha256', async () => {
        expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});
