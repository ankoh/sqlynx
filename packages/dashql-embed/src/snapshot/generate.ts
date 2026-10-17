import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { SqlAnalyzer, type CompiledVisualization } from '../analysis/core.js';
import { prepareDescribeInput } from '../commands/describe.js';
import { buildUserPrompt } from '../describe/describe.js';
import { HashEmbedder } from '../embedding/embedder.js';
import { analyzeScripts } from '../indexer.js';
import { sha256 } from '../inputs.js';

/// A fixture as authored in snapshots/embed/*.tpl.yaml
export interface SnapshotCase {
    name: string;
    script: { input: string };
    /// Present if `dashql-embed describe` runs on the script. The snapshot then shows the prompt that it sends to the model.
    describe?: { force?: boolean } | null;
}

export interface SnapshotFile {
    embed_snapshots: SnapshotCase[];
}

export const GENERATED_NOTICE =
    '# Generated from the .tpl.yaml next to this file. Do not edit.\n# Update with: bazel run //snapshots/embed:update\n';

/// The directory with the snapshot templates. `bazel run` points at the workspace, tests at the runfiles copy.
export function snapshotDir(): string {
    const root = process.env.BUILD_WORKSPACE_DIRECTORY ?? resolve(process.cwd(), '../..');
    return join(root, 'snapshots', 'embed');
}

export async function listTemplates(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter(f => f.endsWith('.tpl.yaml')).sort();
}

export function generatedPath(dir: string, template: string): string {
    return join(dir, template.replace(/\.tpl\.yaml$/, '.yaml'));
}

/// Token budgets only matter for long inputs, which fixtures avoid. Using a fixed tokenizer keeps snapshots model-free.
const TOKENIZER = new HashEmbedder(8, 512);

/// The compiled VISUALIZE statement, with the Vega-Lite spec as structured data to keep the snapshot readable.
/// The snapshot shows the full spec including `data.$sql`, only the description derived from it is embedded.
function describeCompiled(v: CompiledVisualization): Record<string, unknown> {
    return {
        renderer: v.renderer,
        ...(v.vegaliteSpec && { vegalite_spec: JSON.parse(v.vegaliteSpec) }),
        ...(v.markdown && { markdown: v.markdown }),
        ...(v.umap && { umap: v.umap }),
    };
}

export async function generateCase(c: SnapshotCase, analyzer: SqlAnalyzer): Promise<Record<string, unknown>> {
    const input = { id: `${c.name}.sql`, text: c.script.input };
    const out: Record<string, unknown> = { ...c };

    // What `dashql-embed describe` sends to the model. The answer is not part of the snapshot.
    if (c.describe !== undefined) {
        const [analyzed] = analyzer.analyze([input]);
        const { input: promptInput, blocks } = prepareDescribeInput(input, analyzed);
        if (blocks.some(b => b.source === 'dashql_description') && !(c.describe?.force ?? false)) {
            out.describe_skipped = 'the script already has a description';
        } else {
            out.describe_prompt = buildUserPrompt(promptInput);
        }
    }

    // What `index` derives from the script
    const file = { id: input.id, path: '', text: input.text, hash: sha256(input.text) };
    const [script] = analyzeScripts([file], analyzer, TOKENIZER);
    const f = script.features;
    out.features = f && {
        statement_types: f.statementTypes,
        tables: f.tables,
        columns: f.columns,
        functions: f.functions,
        aggregates: f.aggregates,
        function_calls: f.functionCalls,
        ctes: f.ctes,
        joins: f.joins,
        filters: f.filters,
        operators: f.operators,
        output_columns: f.outputColumns,
        group_by: f.groupBy,
        order_by: f.orderBy,
        visualizations: f.visualizations,
    };
    if (script.analyzed.visualization) out.visualization = describeCompiled(script.analyzed.visualization);
    out.feature_text = script.featureText;
    out.comments = script.commentChunks.map(chunk => ({ source: chunk.source, text: chunk.text }));
    out.diagnostics = script.analyzed.diagnostics;
    return out;
}

export async function generateFile(templatePath: string, analyzer: SqlAnalyzer): Promise<Record<string, unknown>> {
    const template = YAML.parse(await readFile(templatePath, 'utf8')) as SnapshotFile;
    const cases = [];
    for (const c of template.embed_snapshots) {
        cases.push(await generateCase(c, analyzer));
    }
    return { embed_snapshots: cases };
}

export function renderYaml(doc: Record<string, unknown>): string {
    return GENERATED_NOTICE + YAML.stringify(doc, { lineWidth: 0, blockQuote: 'literal' });
}
