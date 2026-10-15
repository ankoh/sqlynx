import { describe, expect, it } from 'vitest';

import { readNotebookBundleFromBrowserFolder } from './browser_notebook_folder.js';
import { testNotebook } from './notebook_test_backend.js';

function file(path: string, text: string): File {
    const value = new File([text], path.split('/').pop()!);
    Object.defineProperty(value, 'webkitRelativePath', { value: path });
    return value;
}

describe('V2 browser folder import', () => {
    it('preserves binary data without text decoding', async () => {
        const bytes = new Uint8Array([0, 255, 128]);
        const payload = new File([bytes], 'payload.bin');
        Object.defineProperty(payload, 'webkitRelativePath', { value: 'selected/attachments/payload.bin' });
        const bundle = await readNotebookBundleFromBrowserFolder([
            file('selected/dashql-notebook.json', JSON.stringify(testNotebook())), payload,
        ]);
        expect(bundle.data).toEqual([{ name: 'payload.bin', bytes }]);
    });
    it('strips one root and reads flat scripts in natural order', async () => {
        await expect(readNotebookBundleFromBrowserFolder([
            file('selected/dashql-notebook.json', JSON.stringify(testNotebook())),
            file('selected/scripts/10_last.sql', 'SELECT 10'),
            file('selected/scripts/2_first.sql', 'SELECT 2'),
        ])).resolves.toEqual({
            notebook: testNotebook(),
            schemaSql: null,
            functionsSql: null,
            data: [],
            scripts: [
                { name: '2_first.sql', sql: 'SELECT 2' },
                { name: '10_last.sql', sql: 'SELECT 10' },
            ],
        });
    });

    it.each([
        ['selected/scripts/page/query.sql', 'directly inside scripts/'],
        ['selected/scripts/dashql-draft.sql', 'directly inside scripts/'],
        ['selected/attachments/nested/payload.bin', 'directly inside attachments/'],
        ['selected/attachments/../payload.bin', 'directly inside attachments/'],
    ])('rejects obsolete V1 layout %s', async (path, message) => {
        await expect(readNotebookBundleFromBrowserFolder([
            file('selected/dashql-notebook.json', JSON.stringify(testNotebook())),
            file(path, 'SELECT 1'),
        ])).rejects.toThrow(message);
    });

    it('rejects V1 metadata', async () => {
        await expect(readNotebookBundleFromBrowserFolder([
            file('selected/dashql-notebook.json', JSON.stringify({ ...testNotebook(), formatVersion: 1 })),
        ])).rejects.toThrow('Unsupported notebook format version');
    });
});
