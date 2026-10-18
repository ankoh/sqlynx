import { describe, expect, it } from 'vitest';
import { extractComments } from './comments.js';
import { analyzeOne } from '../test_fixture.js';

describe('extractComments', () => {
    it('merges contiguous line comments and strips markers', async () => {
        const sql = `-- first line\n-- second line\n\n-- separate\n/* block\n * comment */\nselect 1;`;
        const blocks = extractComments(await analyzeOne(sql));
        expect(blocks.map(b => b.text)).toEqual(['first line\nsecond line', 'separate', 'block\ncomment']);
        expect(blocks.every(b => b.source === 'comment')).toBe(true);
    });

    it('separates generated descriptions from human comments', async () => {
        const sql = `-- @dashql:description\n-- Revenue by segment.\n--\n-- Example questions:\n-- - Which segment earns most?\n-- @dashql:end\n-- TPC-H query 3\nselect 1;`;
        const blocks = extractComments(await analyzeOne(sql));
        expect(blocks).toHaveLength(2);
        expect(blocks[0].source).toBe('dashql_description');
        expect(blocks[0].text).toBe('Revenue by segment.\n\nExample questions:\n- Which segment earns most?');
        expect(blocks[1]).toMatchObject({ source: 'comment', text: 'TPC-H query 3' });
        // The range covers the marker lines so that the block can be replaced
        const bytes = new TextEncoder().encode(sql);
        const range = new TextDecoder().decode(bytes.subarray(blocks[0].begin, blocks[0].end));
        expect(range.startsWith('-- @dashql:description')).toBe(true);
        expect(range.endsWith('-- @dashql:end')).toBe(true);
    });

    it('treats an unterminated description as an ordinary comment', async () => {
        const blocks = extractComments(await analyzeOne(`-- @dashql:description\n-- text\nselect 1;`));
        expect(blocks.map(b => [b.source, b.text])).toEqual([['comment', '@dashql:description\ntext']]);
    });

    it('reads descriptions in block comments', async () => {
        const blocks = extractComments(await analyzeOne(`/* @dashql:description\n   Revenue by segment.\n*/\nselect 1;`));
        expect(blocks).toMatchObject([{ source: 'dashql_description', text: 'Revenue by segment.' }]);
    });

    it('skips blocks with unknown tags', async () => {
        const sql = `-- @dashql:parameters\n-- region = 'EUROPE'\n-- @dashql:end\n-- note\nselect 1;`;
        const blocks = extractComments(await analyzeOne(sql));
        expect(blocks.map(b => [b.source, b.text])).toEqual([['comment', 'note']]);
    });
});
