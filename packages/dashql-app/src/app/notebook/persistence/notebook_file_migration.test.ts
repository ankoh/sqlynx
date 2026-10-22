import { describe, expect, it } from 'vitest';

import { migrateNotebookFiles, type NotebookFiles } from './notebook_file_migration.js';

/// An in-memory notebook folder
function folder(names: string[]): NotebookFiles & { names: Set<string> } {
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

describe('notebook file migration', () => {
    const renames = [{ from: 'a.sql', to: 'b.sql' }, { from: 'b.sql', to: 'c.sql' }, { from: 'x.sql', to: 'y.sql' }];

    it('applies the renames in order', async () => {
        const files = folder(['a.sql', 'other.sql']);
        expect(await migrateNotebookFiles(files, renames)).toEqual([renames[0], renames[1]]);
        expect([...files.names].sort()).toEqual(['c.sql', 'other.sql']);
    });

    it('is idempotent', async () => {
        const files = folder(['a.sql']);
        await migrateNotebookFiles(files, renames);
        expect(await migrateNotebookFiles(files, renames)).toEqual([]);
        expect([...files.names]).toEqual(['c.sql']);
    });

    it('keeps both files when the new one exists already', async () => {
        const files = folder(['x.sql', 'y.sql']);
        expect(await migrateNotebookFiles(files, renames)).toEqual([]);
        expect([...files.names].sort()).toEqual(['x.sql', 'y.sql']);
    });
});
