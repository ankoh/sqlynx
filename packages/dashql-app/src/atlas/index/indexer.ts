import { readMetadata, type ScriptMetadata } from '@ankoh/dashql-core';

import { descriptionText, extractComments } from './analysis/comments.js';
import { SqlAnalyzer, type AnalyzedSql } from './analysis/core.js';
import { extractStructureFeatures, type StructureFeatures } from './analysis/structure.js';
import { chunkText } from './chunking.js';
import { computeLayout, type LayoutResult } from './layout.js';
import type { Embedder } from './model.js';
import type { IndexRow } from './rows.js';
import type { SqlFile } from './scan.js';

/// The embedding-free part of an indexed script
export interface ScriptAnalysis {
    file: SqlFile;
    analyzed: AnalyzedSql;
    features: StructureFeatures | null;
    descriptionChunks: string[];
    metadata: ScriptMetadata | null;
}

const CHUNK_OVERLAP_TOKENS = 16;

/// Analyze scripts and split their descriptions into the chunks that will be embedded
export function analyzeScripts(
    files: SqlFile[],
    analyzer: SqlAnalyzer,
    countTokens: (text: string) => number,
    maxTokens: number,
): ScriptAnalysis[] {
    const analyzed = analyzer.analyze(files.map(f => ({ id: f.id, text: f.text })));
    return analyzed.map((sql, i) => {
        const features = extractStructureFeatures(sql);
        const description = descriptionText(extractComments(sql));
        const descriptionChunks = description ? chunkText(description, maxTokens, countTokens, CHUNK_OVERLAP_TOKENS) : [];
        const metadata = sql.parsed ? readMetadata(sql.parsed, sql.bytes) : null;
        return { file: files[i], analyzed: sql, features, descriptionChunks, metadata };
    });
}

/// Does a script get rows in the index? Only described scripts do.
export function hasDescription(script: ScriptAnalysis): boolean {
    return script.descriptionChunks.length > 0;
}

/// Embed the description chunks of analyzed scripts, a row per chunk. Scripts without a description get no row.
export async function embedScripts(
    scripts: ScriptAnalysis[],
    embedder: Embedder,
    onProgress?: (done: number, total: number) => void,
): Promise<IndexRow[]> {
    const chunks = scripts.flatMap(s => s.descriptionChunks.map((text, index) => ({ script: s, text, index })));
    const vectors = await embedder.embedDocuments(chunks.map(c => c.text), onProgress);
    return chunks.map(({ script, text, index }, i) => ({
        scriptName: script.file.id,
        scriptHash: script.file.hash,
        chunkIndex: index,
        text,
        embedding: vectors[i],
        features: script.features,
        diagnostics: script.analyzed.diagnostics,
        metadata: script.metadata,
    }));
}

export type IndexStage = 'analyze' | 'embed' | 'layout';

export interface IndexProgress {
    stage: IndexStage;
    /// 0 to 1 within the stage
    fraction: number;
    message: string;
}

export interface BuiltIndex {
    rows: IndexRow[];
    /// Coordinates of the rows
    layout: LayoutResult;
    analyzedScripts: number;
}

/// Everything between the scanned files and the rows of the Parquet file
export async function buildIndex(
    files: SqlFile[],
    analyzer: SqlAnalyzer,
    embedder: Embedder,
    onProgress?: (progress: IndexProgress) => void,
): Promise<BuiltIndex> {
    onProgress?.({ stage: 'analyze', fraction: 0, message: `Analyzing ${files.length} scripts` });
    const scripts = analyzeScripts(files, analyzer, t => embedder.countTokens(t), embedder.config.maxTokens);
    onProgress?.({ stage: 'analyze', fraction: 1, message: `Analyzed ${files.length} scripts` });

    const rows = await embedScripts(scripts, embedder, (done, total) => {
        onProgress?.({
            stage: 'embed',
            fraction: total === 0 ? 1 : done / total,
            message: `Embedding descriptions ${done}/${total}`,
        });
    });

    const dim = embedder.config.dim;
    const flat = new Float32Array(rows.length * dim);
    rows.forEach((row, i) => flat.set(row.embedding, i * dim));
    onProgress?.({ stage: 'layout', fraction: 0, message: `Laying out ${rows.length} descriptions in 3D` });
    const layout = await computeLayout(flat, rows.length, dim, (fraction, stage) => {
        onProgress?.({ stage: 'layout', fraction, message: `Laying out descriptions (${stage})` });
    });
    return { rows, layout, analyzedScripts: scripts.length };
}
