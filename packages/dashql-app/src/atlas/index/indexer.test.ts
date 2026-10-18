import { describe, expect, it } from 'vitest';

import { analyzeScripts, hasDescription } from './indexer.js';
import type { SqlFile } from './scan.js';
import { tpchAnalyzer } from './test_fixture.js';

/// analyzeScripts only reads the text of a file
const file = (text: string): SqlFile => ({ id: 'a.sql', hash: 'h', text, handle: null as unknown as FileSystemFileHandle });

describe('analyzeScripts', () => {
    it('derives the description, the structure and the metadata', async () => {
        const text = [
            '-- @dashql:metadata',
            '-- {',
            '--   "owner": "finance",',
            '--   "runtime_ms": 1834',
            '-- }',
            '-- @dashql:end',
            '',
            '-- @dashql:description',
            '-- Revenue per market segment.',
            '-- @dashql:end',
            '-- An ordinary comment',
            'select c_mktsegment, sum(o_totalprice) from customer, orders where c_custkey = o_custkey group by 1;',
        ].join('\n');
        const [script] = analyzeScripts([file(text)], await tpchAnalyzer());
        expect(script.features?.tables).toEqual(['customer', 'orders']);
        // Ordinary comments are not embedded
        expect(script.description).toBe('Revenue per market segment.');
        expect(script.metadata).toEqual({ owner: 'finance', runtime_ms: 1834 });
    });

    it('has no description or metadata for plain scripts, they get no rows', async () => {
        const [script] = analyzeScripts([file('-- note\nselect 1;')], await tpchAnalyzer());
        expect(script.description).toBeNull();
        expect(hasDescription(script)).toBe(false);
        expect(script.metadata).toBeNull();
    });
});
