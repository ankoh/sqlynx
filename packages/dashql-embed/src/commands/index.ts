import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlAnalyzer } from '../analysis/core.js';
import type { Embedder } from '../embedding/embedder.js';
import { analyzeScripts, embedScripts } from '../indexer.js';
import { collectSqlFiles, resolveUserPath } from '../inputs.js';
import { DEFAULT_LAYOUT_DIMS, computeLayout, layoutKey, type LayoutDims } from '../layout/layout.js';
import { readPreviousLayout } from '../layout/previous.js';
import { commentsTable, featuresTable, indexMetadata, layoutMetadata, writeParquetFile } from '../output/parquet.js';

export interface IndexOptions {
    inputs: string[];
    outDir: string;
    embedder: Embedder;
    /// Place the scripts in 3D (atlas_3d_x/y/z) or 2D (atlas_2d_x/y), or not at all. Default DEFAULT_LAYOUT_DIMS.
    layout?: LayoutDims | false;
    /// Add the embedded feature text to features.parquet, for debugging. Default false.
    featureText?: boolean;
    log: (message: string) => void;
}

export interface IndexSummary {
    scripts: number;
    featureRows: number;
    commentRows: number;
    truncated: number;
    withDiagnostics: number;
    /// How the layout started, or off
    layout: 'cold' | 'warm' | 'trivial' | 'off';
}

/// Read the version of the DashQL core package that produced the analysis
async function coreVersion(): Promise<string> {
    try {
        const entry = fileURLToPath(import.meta.resolve('@ankoh/dashql-core'));
        const pkg = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8'));
        return String(pkg.version);
    } catch {
        return 'unknown';
    }
}

export async function runIndex(options: IndexOptions): Promise<IndexSummary> {
    const { embedder, log } = options;
    const files = await collectSqlFiles(options.inputs);
    if (files.length === 0) {
        throw new Error('no .sql files found');
    }
    const analyzer = await SqlAnalyzer.create();
    log(`analyzing ${files.length} scripts`);
    const scripts = analyzeScripts(files, analyzer, embedder);
    for (const script of scripts) {
        for (const message of script.analyzed.diagnostics) log(`warning: ${script.file.id}: ${message}`);
    }
    log(`embedding with ${embedder.config.model} (${embedder.dim} dimensions)`);
    const { comments, features } = await embedScripts(scripts, embedder);

    const version = await coreVersion();
    const outDir = resolveUserPath(options.outDir);
    const featuresPath = join(outDir, 'features.parquet');
    const featuresMetadata = indexMetadata('features', embedder.config, embedder.dim, version);
    const dims = options.layout ?? DEFAULT_LAYOUT_DIMS;
    let layout: { coords: Float32Array; dims: LayoutDims } | undefined;
    let layoutMode: IndexSummary['layout'] = 'off';
    if (dims && features.length > 0) {
        const flat = new Float32Array(features.length * embedder.dim);
        features.forEach((f, i) => flat.set(f.embedding, i * embedder.dim));
        const result = await computeLayout(
            flat,
            features.map(f => layoutKey(f.scriptName, f.scriptHash)),
            embedder.dim,
            { dims, previous: await readPreviousLayout(featuresPath, embedder.config, embedder.dim, dims), log },
        );
        layout = { coords: result.coords, dims };
        layoutMode = result.mode;
        for (const [key, value] of layoutMetadata(dims, result.scale)) featuresMetadata.set(key, value);
    }
    await writeParquetFile(
        join(outDir, 'comments.parquet'),
        commentsTable(comments, embedder.dim, indexMetadata('comments', embedder.config, embedder.dim, version)),
    );
    await writeParquetFile(featuresPath, featuresTable(features, embedder.dim, featuresMetadata, { layout, featureText: options.featureText }));
    return {
        scripts: files.length,
        featureRows: features.length,
        commentRows: comments.length,
        truncated: features.filter(f => f.truncated).length,
        withDiagnostics: scripts.filter(s => s.analyzed.diagnostics.length > 0).length,
        layout: layoutMode,
    };
}
