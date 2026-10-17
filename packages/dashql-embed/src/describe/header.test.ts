import { describe, expect, it } from 'vitest';
import { extractComments } from '../analysis/comments.js';
import { applyHeader, renderHeader } from './header.js';
import { analyzeOne } from '../test_fixture.js';

const description = {
    summary: 'Revenue of the open orders per market segment.',
    questions: ['Which segment earns the most?', 'Revenue per segment'],
};

async function apply(text: string, force = false) {
    return applyHeader(text, extractComments(await analyzeOne(text)), description, force);
}

describe('description header', () => {
    it('renders a marked comment block', () => {
        expect(renderHeader(description, '\n')).toBe(
            '-- @dashql:description\n-- Revenue of the open orders per market segment.\n--\n-- Example questions:\n' +
                '-- - Which segment earns the most?\n-- - Revenue per segment\n-- @dashql:end\n',
        );
    });

    it('wraps long lines', () => {
        const long = { summary: 'word '.repeat(60).trim(), questions: [] };
        const header = renderHeader(long, '\n', 40);
        expect(header.split('\n').every(l => l.length <= 40)).toBe(true);
    });

    it('inserts above existing comments and keeps the script', async () => {
        const result = await apply('-- TPC-H query 3\nselect 1;\n');
        expect(result.action).toBe('inserted');
        expect(result.text.endsWith('-- @dashql:end\n-- TPC-H query 3\nselect 1;\n')).toBe(true);
    });

    it('keeps an existing description unless forced', async () => {
        const first = (await apply('select 1;')).text;
        const again = await apply(first);
        expect(again).toEqual({ text: first, action: 'kept' });
    });

    it('replaces only the marked range when forced', async () => {
        const original = '-- @dashql:description\n-- old text\n-- @dashql:end\n-- my own note\nselect 1;\n';
        const result = await apply(original, true);
        expect(result.action).toBe('replaced');
        expect(result.text).toBe(renderHeader(description, '\n') + '-- my own note\nselect 1;\n');
    });

    it('keeps CRLF line endings and multi-byte text', async () => {
        const result = await apply('-- Größe\r\nselect 1;\r\n');
        expect(result.text).not.toMatch(/[^\r]\n/);
        expect(result.text.endsWith('-- Größe\r\nselect 1;\r\n')).toBe(true);
        const forced = await apply(result.text, true);
        expect(forced.text).toBe(result.text);
    });
});
