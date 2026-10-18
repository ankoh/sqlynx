import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SqlAnalyzer } from '../analysis/core.js';
import { generateFile, generatedPath, listTemplates, renderYaml, snapshotDir } from './generate.js';

/// Regenerates snapshots/describe/*.yaml from the *.tpl.yaml templates.
/// Everything is derived from the scripts, no LLM is involved.
async function main(): Promise<void> {
    const dir = snapshotDir();
    // Scripts are self-contained, names that are not declared in the script stay unresolved
    const analyzer = await SqlAnalyzer.create();
    for (const template of await listTemplates(dir)) {
        const target = generatedPath(dir, template);
        await writeFile(target, renderYaml(await generateFile(join(dir, template), analyzer)), 'utf8');
        console.error(`wrote ${target}`);
    }
}

main().catch(error => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
