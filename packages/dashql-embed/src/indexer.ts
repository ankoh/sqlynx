import { extractComments, embeddableComments, type CommentSource } from './analysis/comments.js';
import { SqlAnalyzer, type AnalyzedSql } from './analysis/core.js';
import { extractFeatures, type ScriptFeatures } from './analysis/features.js';
import { chunkText } from './chunking.js';
import { renderFeatureDocument } from './document.js';
import type { Embedder } from './embedding/embedder.js';
import type { SqlFile } from './inputs.js';

export interface CommentRow {
    scriptName: string;
    scriptHash: string;
    chunkIndex: number;
    source: CommentSource;
    text: string;
    embedding: Float32Array;
}

export interface FeatureRow {
    scriptName: string;
    scriptHash: string;
    /// The embedded text, only written to the Parquet file for debugging
    featureText: string;
    featureTokens: number;
    truncated: boolean;
    embedding: Float32Array;
    features: ScriptFeatures;
    diagnostics: string[];
}

/// The embedding-free part of an indexed script
export interface ScriptAnalysis {
    file: SqlFile;
    analyzed: AnalyzedSql;
    features: ScriptFeatures | null;
    featureText: string;
    featureTokens: number;
    truncated: boolean;
    commentChunks: { source: CommentSource; text: string }[];
}

const CHUNK_OVERLAP_TOKENS = 16;

/// Analyze scripts and derive the texts that will be embedded
export function analyzeScripts(files: SqlFile[], analyzer: SqlAnalyzer, embedder: Embedder): ScriptAnalysis[] {
    const analyzed = analyzer.analyze(files.map(f => ({ id: f.id, text: f.text })));
    const maxTokens = embedder.config.maxTokens;
    return analyzed.map((sql, i) => {
        const features = extractFeatures(sql);
        const doc = features
            ? renderFeatureDocument(features, maxTokens, t => embedder.countTokens(t))
            : { text: '', tokenCount: 0, truncated: false };
        const commentChunks = embeddableComments(extractComments(sql, analyzer)).flatMap(({ source, text }) =>
            chunkText(text, maxTokens, t => embedder.countTokens(t), CHUNK_OVERLAP_TOKENS).map(chunk => ({ source, text: chunk })),
        );
        return {
            file: files[i],
            analyzed: sql,
            features,
            featureText: doc.text,
            featureTokens: doc.tokenCount,
            truncated: doc.truncated,
            commentChunks,
        };
    });
}

export interface IndexResult {
    comments: CommentRow[];
    features: FeatureRow[];
}

/// Embed the texts of analyzed scripts
export async function embedScripts(scripts: ScriptAnalysis[], embedder: Embedder): Promise<IndexResult> {
    const withFeatures = scripts.filter(s => s.features && s.featureText.length > 0);
    const featureVectors = await embedder.embedDocuments(withFeatures.map(s => s.featureText));
    const features: FeatureRow[] = withFeatures.map((s, i) => ({
        scriptName: s.file.id,
        scriptHash: s.file.hash,
        featureText: s.featureText,
        featureTokens: s.featureTokens,
        truncated: s.truncated,
        embedding: featureVectors[i],
        features: s.features!,
        diagnostics: s.analyzed.diagnostics,
    }));

    const chunks = scripts.flatMap(s => s.commentChunks.map((chunk, index) => ({ script: s, chunk, index })));
    const commentVectors = await embedder.embedDocuments(chunks.map(c => c.chunk.text));
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
