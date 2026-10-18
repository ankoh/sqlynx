import { extractComments, embeddableComments, type CommentSource } from './analysis/comments.js';
import { SqlAnalyzer, type AnalyzedSql } from './analysis/core.js';
import { extractFeatures, type ScriptFeatures } from './analysis/features.js';
import { chunkText } from './chunking.js';
import { renderFeatureDocument } from './document.js';
import { computeLayout, type LayoutResult } from './layout.js';
import type { Embedder } from './model.js';
import type { CommentRow, FeatureRow } from './rows.js';
import type { SqlFile } from './scan.js';

/// The embedding-free part of an indexed script
export interface ScriptAnalysis {
    file: SqlFile;
    analyzed: AnalyzedSql;
    features: ScriptFeatures | null;
    featureText: string;
    truncated: boolean;
    commentChunks: { source: CommentSource; text: string }[];
}

const CHUNK_OVERLAP_TOKENS = 16;

/// Analyze scripts and derive the texts that will be embedded
export function analyzeScripts(
    files: SqlFile[],
    analyzer: SqlAnalyzer,
    countTokens: (text: string) => number,
    maxTokens: number,
): ScriptAnalysis[] {
    const analyzed = analyzer.analyze(files.map(f => ({ id: f.id, text: f.text })));
    return analyzed.map((sql, i) => {
        const features = extractFeatures(sql);
        const doc = features
            ? renderFeatureDocument(features, maxTokens, countTokens)
            : { text: '', tokenCount: 0, truncated: false };
        const commentChunks = embeddableComments(extractComments(sql)).flatMap(({ source, text }) =>
            chunkText(text, maxTokens, countTokens, CHUNK_OVERLAP_TOKENS).map(chunk => ({ source, text: chunk })),
        );
        return { file: files[i], analyzed: sql, features, featureText: doc.text, truncated: doc.truncated, commentChunks };
    });
}

export interface IndexResult {
    comments: CommentRow[];
    features: FeatureRow[];
}

export interface EmbedProgress {
    stage: 'features' | 'comments';
    done: number;
    total: number;
}

/// Embed the texts of analyzed scripts. Scripts without features or usable comments get no row of that kind.
export async function embedScripts(
    scripts: ScriptAnalysis[],
    embedder: Embedder,
    onProgress?: (progress: EmbedProgress) => void,
): Promise<IndexResult> {
    const withFeatures = scripts.filter(s => s.features && s.featureText.length > 0);
    const featureVectors = await embedder.embedDocuments(
        withFeatures.map(s => s.featureText),
        (done, total) => onProgress?.({ stage: 'features', done, total }),
    );
    const features: FeatureRow[] = withFeatures.map((s, i) => ({
        scriptName: s.file.id,
        scriptHash: s.file.hash,
        truncated: s.truncated,
        embedding: featureVectors[i],
        features: s.features!,
        diagnostics: s.analyzed.diagnostics,
    }));

    const chunks = scripts.flatMap(s => s.commentChunks.map((chunk, index) => ({ script: s, chunk, index })));
    const commentVectors = await embedder.embedDocuments(
        chunks.map(c => c.chunk.text),
        (done, total) => onProgress?.({ stage: 'comments', done, total }),
    );
    const comments: CommentRow[] = chunks.map(({ script, chunk, index }, i) => ({
        scriptName: script.file.id,
        scriptHash: script.file.hash,
        chunkIndex: index,
        source: chunk.source,
        text: chunk.text,
        embedding: commentVectors[i],
    }));
    return { comments, features };
}

export type IndexStage = 'analyze' | 'embed_features' | 'embed_comments' | 'layout';

export interface IndexProgress {
    stage: IndexStage;
    /// 0 to 1 within the stage
    fraction: number;
    message: string;
}

export interface BuiltIndex extends IndexResult {
    /// Coordinates for the `features` rows
    featureLayout: LayoutResult;
    /// Coordinates for the `comments` rows. Features and comments are laid out independently, the comments of a script
    /// would otherwise end up next to the features of the scripts they are about instead of next to similar comments.
    commentLayout: LayoutResult;
    analyzedScripts: number;
}

/// Everything between the scanned files and the rows of the Parquet files
export async function buildIndex(
    files: SqlFile[],
    analyzer: SqlAnalyzer,
    embedder: Embedder,
    onProgress?: (progress: IndexProgress) => void,
): Promise<BuiltIndex> {
    onProgress?.({ stage: 'analyze', fraction: 0, message: `Analyzing ${files.length} scripts` });
    const scripts = analyzeScripts(files, analyzer, t => embedder.countTokens(t), embedder.config.maxTokens);
    onProgress?.({ stage: 'analyze', fraction: 1, message: `Analyzed ${files.length} scripts` });

    const result = await embedScripts(scripts, embedder, ({ stage, done, total }) => {
        onProgress?.({
            stage: stage === 'features' ? 'embed_features' : 'embed_comments',
            fraction: total === 0 ? 1 : done / total,
            message: `Embedding ${stage} ${done}/${total}`,
        });
    });

    const dim = embedder.config.dim;
    const layOut = async (kind: 'features' | 'comments', rows: { embedding: Float32Array }[]) => {
        const flat = new Float32Array(rows.length * dim);
        rows.forEach((row, i) => flat.set(row.embedding, i * dim));
        onProgress?.({ stage: 'layout', fraction: 0, message: `Laying out ${rows.length} ${kind} in 3D` });
        return await computeLayout(flat, rows.length, dim, (fraction, stage) => {
            onProgress?.({ stage: 'layout', fraction, message: `Laying out ${kind} (${stage})` });
        });
    };
    const featureLayout = await layOut('features', result.features);
    const commentLayout = await layOut('comments', result.comments);
    return { ...result, featureLayout, commentLayout, analyzedScripts: scripts.length };
}
