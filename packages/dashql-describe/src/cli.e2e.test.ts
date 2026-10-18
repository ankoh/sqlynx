import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeFiles } from './commands/describe.js';
import type { Describer } from './describe/describe.js';
import { collectSqlFiles } from './inputs.js';
import { tpchAnalyzer } from './test_fixture.js';

const EXAMPLES = resolve(process.cwd(), '../../examples/notebooks/tpch/scripts');
const dirs: string[] = [];
afterAll(async () => {
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
});

/// Stands in for Claude with canned answers
const stub: Describer = {
    async describe(input) {
        if (input.sql.includes('c_mktsegment')) {
            return {
                summary: 'Revenue of unshipped orders for customers of the BUILDING market segment.',
                questions: ['Which unshipped orders bring in the most revenue?', 'Top revenue orders of a market segment'],
            };
        }
        return { summary: `Script ${input.scriptName}.`, questions: ['What does it do?', 'Why is it here?'] };
    },
};

describe('describe', () => {
    it('writes descriptions once and leaves described scripts alone', async () => {
        const work = await mkdtemp(join(tmpdir(), 'dashql-describe-e2e-'));
        dirs.push(work);
        const scripts = join(work, 'scripts');
        await cp(EXAMPLES, scripts, { recursive: true, dereference: true });

        const analyzer = await tpchAnalyzer();
        const options = { force: false, dryRun: false, skipCommented: false, concurrency: 2, log: () => {} };
        const first = await describeFiles(await collectSqlFiles([scripts]), analyzer, stub, options);
        expect(first.filter(o => o.status !== 'described')).toEqual([]);
        const q3 = await readFile(join(scripts, '05_tpch_q3.sql'), 'utf8');
        expect(q3.startsWith('-- @dashql:description\n-- Revenue of unshipped orders')).toBe(true);
        expect(q3).toContain('-- TPC-H query 3\nselect');

        // Running it again must not change anything
        const second = await describeFiles(await collectSqlFiles([scripts]), analyzer, stub, options);
        expect(second.every(o => o.status === 'skipped')).toBe(true);
        expect(await readFile(join(scripts, '05_tpch_q3.sql'), 'utf8')).toBe(q3);
    });
});
