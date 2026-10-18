import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { SqlAnalyzer } from '../analysis/core.js';
import { prepareDescribeInput } from '../commands/describe.js';
import { buildUserPrompt } from '../describe/describe.js';

/// A fixture as authored in snapshots/describe/*.tpl.yaml
export interface SnapshotCase {
    name: string;
    script: { input: string };
    /// Options of `dashql-describe` for the script. The snapshot shows the prompt that it sends to the model.
    describe?: { force?: boolean } | null;
}

export interface SnapshotFile {
    describe_snapshots: SnapshotCase[];
}

export const GENERATED_NOTICE =
    '# Generated from the .tpl.yaml next to this file. Do not edit.\n# Update with: bazel run //snapshots/describe:update\n';

/// The directory with the snapshot templates. `bazel run` points at the workspace, tests at the runfiles copy.
export function snapshotDir(): string {
    const root = process.env.BUILD_WORKSPACE_DIRECTORY ?? resolve(process.cwd(), '../..');
    return join(root, 'snapshots', 'describe');
}

export async function listTemplates(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter(f => f.endsWith('.tpl.yaml')).sort();
}

export function generatedPath(dir: string, template: string): string {
    return join(dir, template.replace(/\.tpl\.yaml$/, '.yaml'));
}

export async function generateCase(c: SnapshotCase, analyzer: SqlAnalyzer): Promise<Record<string, unknown>> {
    const input = { id: `${c.name}.sql`, text: c.script.input };
    const out: Record<string, unknown> = { ...c };

    // What `dashql-describe` sends to the model. The answer is not part of the snapshot.
    const [analyzed] = analyzer.analyze([input]);
    const { input: promptInput, blocks } = prepareDescribeInput(input, analyzed);
    if (blocks.some(b => b.source === 'dashql_description') && !(c.describe?.force ?? false)) {
        out.describe_skipped = 'the script already has a description';
    } else {
        out.describe_prompt = buildUserPrompt(promptInput);
    }
    return out;
}

export async function generateFile(templatePath: string, analyzer: SqlAnalyzer): Promise<Record<string, unknown>> {
    const template = YAML.parse(await readFile(templatePath, 'utf8')) as SnapshotFile;
    const cases = [];
    for (const c of template.describe_snapshots) {
        cases.push(await generateCase(c, analyzer));
    }
    return { describe_snapshots: cases };
}

export function renderYaml(doc: Record<string, unknown>): string {
    return GENERATED_NOTICE + YAML.stringify(doc, { lineWidth: 0, blockQuote: 'literal' });
}
