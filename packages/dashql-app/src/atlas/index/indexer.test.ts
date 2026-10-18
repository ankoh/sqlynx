import { describe, expect, it } from 'vitest';

import { analyzeScripts } from './indexer.js';
import type { SqlFile } from './scan.js';
import { tpchAnalyzer } from './test_fixture.js';

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
/// analyzeScripts only reads the text of a file
const file = (text: string): SqlFile => ({ id: 'a.sql', hash: 'h', text, handle: null as unknown as FileSystemFileHandle });

describe('analyzeScripts', () => {
    it('derives the texts of every embedding space', async () => {
        const text = [
            '-- @dashql:properties',
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
        const [script] = analyzeScripts([file(text)], await tpchAnalyzer(), words, 512);
        expect(script.structureDocument.text).toContain('Tables: customer, orders');
        // Ordinary comments are not embedded
        expect(script.descriptionChunks).toEqual(['Revenue per market segment.']);
        expect(script.properties).toEqual({ owner: 'finance', runtime_ms: 1834 });
        expect(script.propertiesDocument.text).toBe('owner: finance\nruntime_ms: 1834');
    });

    it('has no description or properties for plain scripts', async () => {
        const [script] = analyzeScripts([file('-- note\nselect 1;')], await tpchAnalyzer(), words, 512);
        expect(script.descriptionChunks).toEqual([]);
        expect(script.properties).toBeNull();
        expect(script.propertiesDocument.text).toBe('');
    });
});
