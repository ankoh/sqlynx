import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { SqlAnalyzer } from '../analysis/core.js';
import { generateFile, generatedPath, listTemplates, snapshotDir } from './generate.js';

/// Regenerates the snapshots in memory and compares them with the committed files
describe('embed snapshots', async () => {
    const dir = snapshotDir();
    const analyzer = await SqlAnalyzer.create();
    for (const template of await listTemplates(dir)) {
        it(template.replace(/\.tpl\.yaml$/, ''), async () => {
            const expected = YAML.parse(await readFile(generatedPath(dir, template), 'utf8'));
            // Round trip through YAML to compare like with like
            expect(YAML.parse(YAML.stringify(await generateFile(`${dir}/${template}`, analyzer)))).toEqual(expected);
        });
    }
});
