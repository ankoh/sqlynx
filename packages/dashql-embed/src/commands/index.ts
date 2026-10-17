import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlAnalyzer } from '../analysis/core.js';
import type { Embedder } from '../embedding/embedder.js';
import { analyzeScripts, embedScripts } from '../indexer.js';
import { collectSqlFiles, resolveUserPath } from '../inputs.js';
import { commentsTable, featuresTable, indexMetadata, writeParquetFile } from '../output/parquet.js';

export interface IndexOptions {
    inputs: string[];
    outDir: string;
    embedder: Embedder;
    log: (message: string) => void;
}

export interface IndexSummary {
    scripts: number;
    featureRows: number;
    commentRows: number;
    truncated: number;
    withDiagnostics: number;
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
    await writeParquetFile(
        join(outDir, 'comments.parquet'),
        commentsTable(comments, embedder.dim, indexMetadata('comments', embedder.config, embedder.dim, version)),
    );
    await writeParquetFile(
        join(outDir, 'features.parquet'),
        featuresTable(features, embedder.dim, indexMetadata('features', embedder.config, embedder.dim, version)),
    );
    return {
        scripts: files.length,
        featureRows: features.length,
        commentRows: comments.length,
        truncated: features.filter(f => f.truncated).length,
        withDiagnostics: scripts.filter(s => s.analyzed.diagnostics.length > 0).length,
    };
}
