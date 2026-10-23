import { describe, expect, it } from 'vitest';

import { StorageTreeEntryKind, type StorageTreeRoot } from '../../storage/storage_tree.js';
import { flattenStorageTree, storageTreeNodeKey, type StorageTreeListing } from './storage_browser_view.js';

const { File: F, Directory: D } = StorageTreeEntryKind;

function root(key: string): StorageTreeRoot {
    return {
        key,
        label: key,
        displayPath: key,
        list: async () => [],
        stat: async () => ({ sizeBytes: null, modifiedMs: null, note: null }),
    };
}

/// The rows as `<depth> <kind> <name or text>` for compact assertions
function describeRows(rows: ReturnType<typeof flattenStorageTree>): string[] {
    return rows.map(row => {
        switch (row.kind) {
            case 'root': return `${row.depth} root ${row.root.key}`;
            case 'directory': return `${row.depth} dir ${row.path}`;
            case 'file': return `${row.depth} file ${row.path}`;
            case 'status': return `${row.depth} status ${row.text}${row.load != null ? ' (load)' : ''}`;
        }
    });
}

describe('flattenStorageTree', () => {
    const opfs = root('opfs');
    const native = root('native:/x');

    it('only descends into expanded directories', () => {
        const listings = new Map<string, StorageTreeListing>([
            [storageTreeNodeKey(opfs, ''), { status: 'ready', entries: [{ name: 'sessions', kind: D }, { name: 'm.json', kind: F }] }],
            [storageTreeNodeKey(opfs, 'sessions'), { status: 'ready', entries: [{ name: 'a', kind: D }] }],
        ]);
        const collapsed = new Set([storageTreeNodeKey(opfs, '')]);
        expect(describeRows(flattenStorageTree([opfs, native], collapsed, listings))).toEqual([
            '0 root opfs',
            '1 dir sessions',
            '1 file m.json',
            '0 root native:/x',
        ]);

        const expanded = new Set([...collapsed, storageTreeNodeKey(opfs, 'sessions'), storageTreeNodeKey(opfs, 'sessions/a')]);
        expect(describeRows(flattenStorageTree([opfs, native], expanded, listings))).toEqual([
            '0 root opfs',
            '1 dir sessions',
            '2 dir sessions/a',
            '3 status Loading… (load)',
            '1 file m.json',
            '0 root native:/x',
        ]);
    });

    it('shows loading, error and empty listings', () => {
        const expanded = new Set([storageTreeNodeKey(opfs, ''), storageTreeNodeKey(native, '')]);
        const loading = new Map<string, StorageTreeListing>([
            [storageTreeNodeKey(opfs, ''), { status: 'loading' }],
            [storageTreeNodeKey(native, ''), { status: 'error', message: 'ENOENT' }],
        ]);
        expect(describeRows(flattenStorageTree([opfs, native], expanded, loading))).toEqual([
            '0 root opfs',
            '1 status Loading…',
            '0 root native:/x',
            '1 status ENOENT',
        ]);

        const empty = new Map<string, StorageTreeListing>([[storageTreeNodeKey(opfs, ''), { status: 'ready', entries: [] }]]);
        expect(describeRows(flattenStorageTree([opfs], expanded, empty))).toEqual(['0 root opfs', '1 status Empty']);
    });
});
