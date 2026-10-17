import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeFiles } from './commands/describe.js';
import { runIndex } from './commands/index.js';
import type { Describer } from './describe/describe.js';
import { HashEmbedder } from './embedding/embedder.js';
import { collectSqlFiles } from './inputs.js';
import { embedderForIndex, loadIndex, searchIndex } from './query.js';
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

describe('describe, index and query', () => {
    it('writes descriptions once, indexes them and finds scripts by prompt', async () => {
        const work = await mkdtemp(join(tmpdir(), 'dashql-embed-e2e-'));
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

        const out = join(work, 'index');
        const embedder = new HashEmbedder(256, 256);
        const summary = await runIndex({ inputs: [scripts], outDir: out, embedder, log: () => {} });
        expect(summary).toMatchObject({ scripts: 24, featureRows: 24, withDiagnostics: 0 });
        expect(summary.commentRows).toBeGreaterThanOrEqual(24);

        const index = await loadIndex(out);
        const restored = await embedderForIndex(index.features);
        const searchOptions = { topK: 3, fusion: 'weighted' as const, weightComments: 0.6, weightFeatures: 0.4 };
        const refs = (await collectSqlFiles([scripts])).map(f => ({ name: f.id, hash: f.hash }));
        const prompt = 'revenue of orders for a market segment';

        const all = await searchIndex(index, prompt, restored, refs, searchOptions);
        expect(all.missing).toEqual([]);
        expect(all.stale).toEqual([]);
        expect(all.hits).toHaveLength(3);
        expect(all.hits[0].scriptName).toBe('05_tpch_q3.sql');
        expect(all.hits[0].tables).toEqual(['customer', 'lineitem', 'orders']);
        expect(all.hits[0].bestComment).toContain('BUILDING market segment');

        // Only the scripts of the given set are searched
        const subset = refs.filter(r => r.name !== '05_tpch_q3.sql').slice(0, 5);
        const restricted = await searchIndex(index, prompt, restored, subset, { ...searchOptions, topK: 10 });
        expect(restricted.hits.map(h => h.scriptName).sort()).toEqual(subset.map(r => r.name).sort());

        // Changed and unknown scripts are reported and left out
        const changed = refs.map(r => (r.name === '05_tpch_q3.sql' ? { ...r, hash: 'changed' } : r));
        const withNew = [...changed, { name: 'new.sql', hash: 'x' }];
        const checked = await searchIndex(index, prompt, restored, withNew, { ...searchOptions, topK: 30 });
        expect(checked.stale).toEqual(['05_tpch_q3.sql']);
        expect(checked.missing).toEqual(['new.sql']);
        expect(checked.hits.map(h => h.scriptName)).not.toContain('05_tpch_q3.sql');
    });
});
