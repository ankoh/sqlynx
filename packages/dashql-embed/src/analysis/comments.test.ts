import { describe, expect, it } from 'vitest';
import { embeddableComments, extractComments } from './comments.js';
import { analyzeOne, tpchAnalyzer } from '../test_fixture.js';

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

    it('detects commented-out SQL by parsing it', async () => {
        const analyzer = await tpchAnalyzer();
        const sql = `-- Customers per segment\n\n-- select * from customer;\n\n-- select the best option for the job\nselect 1;`;
        const blocks = extractComments(await analyzeOne(sql), analyzer);
        expect(blocks.map(b => [b.text, b.isCode])).toEqual([
            ['Customers per segment', false],
            ['select * from customer;', true],
            ['select the best option for the job', false],
        ]);
        expect(embeddableComments(blocks).map(c => c.text)).toEqual([
            'Customers per segment\n\nselect the best option for the job',
        ]);
    });

    it('treats an unterminated description as an ordinary comment', async () => {
        const blocks = extractComments(await analyzeOne(`-- @dashql:description\n-- text\nselect 1;`));
        expect(blocks.map(b => b.source)).toEqual(['comment']);
    });
});
