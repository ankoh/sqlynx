import { readProperties, type ScriptProperties } from '@ankoh/dashql-core';

import { descriptionText, extractComments } from './analysis/comments.js';
import { SqlAnalyzer, type AnalyzedSql } from './analysis/core.js';
import { extractStructureFeatures, type StructureFeatures } from './analysis/structure.js';
import { chunkText } from './chunking.js';
import { renderPropertiesDocument, renderStructureDocument, type EmbeddingDocument } from './document.js';
import { computeLayout, type LayoutResult } from './layout.js';
import type { Embedder } from './model.js';
import type { DescriptionRow, PropertiesRow, StructureRow } from './rows.js';
import type { SqlFile } from './scan.js';

/// The embedding-free part of an indexed script
export interface ScriptAnalysis {
    file: SqlFile;
    analyzed: AnalyzedSql;
    features: StructureFeatures | null;
    structureDocument: EmbeddingDocument;
    descriptionChunks: string[];
    properties: ScriptProperties | null;
    propertiesDocument: EmbeddingDocument;
}

const CHUNK_OVERLAP_TOKENS = 16;
const EMPTY_DOCUMENT: EmbeddingDocument = { text: '', tokenCount: 0, truncated: false };

/// Analyze scripts and derive the texts that will be embedded
export function analyzeScripts(
    files: SqlFile[],
    analyzer: SqlAnalyzer,
    countTokens: (text: string) => number,
    maxTokens: number,
): ScriptAnalysis[] {
    const analyzed = analyzer.analyze(files.map(f => ({ id: f.id, text: f.text })));
    return analyzed.map((sql, i) => {
        const features = extractStructureFeatures(sql);
        const structureDocument = features ? renderStructureDocument(features, maxTokens, countTokens) : EMPTY_DOCUMENT;
        const description = descriptionText(extractComments(sql));
        const descriptionChunks = description ? chunkText(description, maxTokens, countTokens, CHUNK_OVERLAP_TOKENS) : [];
        const properties = sql.parsed ? readProperties(sql.parsed, sql.bytes) : null;
        const propertiesDocument = properties
            ? renderPropertiesDocument(properties, maxTokens, countTokens)
            : EMPTY_DOCUMENT;
        return { file: files[i], analyzed: sql, features, structureDocument, descriptionChunks, properties, propertiesDocument };
    });
}

/// Does a script get a row in any of the index files?
export function hasEmbeddableText(script: ScriptAnalysis): boolean {
    return (script.features != null && script.structureDocument.text.length > 0) ||
        script.descriptionChunks.length > 0 ||
        (script.properties != null && script.propertiesDocument.text.length > 0);
}

/// The embedding spaces of an index, each has its own file and its own 3D layout
export type EmbeddingKind = 'structure' | 'description' | 'properties';
export const EMBEDDING_KINDS: readonly EmbeddingKind[] = ['description', 'structure', 'properties'];

export interface IndexResult {
    structure: StructureRow[];
    description: DescriptionRow[];
    properties: PropertiesRow[];
}

export interface EmbedProgress {
    stage: EmbeddingKind;
    done: number;
    total: number;
}

/// Embed the texts of analyzed scripts. Scripts without structure features, a description or properties get no row of
/// that kind.
export async function embedScripts(
    scripts: ScriptAnalysis[],
    embedder: Embedder,
    onProgress?: (progress: EmbedProgress) => void,
): Promise<IndexResult> {
    const withStructure = scripts.filter(s => s.features != null && s.structureDocument.text.length > 0);
    const structureVectors = await embedder.embedDocuments(
        withStructure.map(s => s.structureDocument.text),
        (done, total) => onProgress?.({ stage: 'structure', done, total }),
    );
    const structure: StructureRow[] = withStructure.map((s, i) => ({
        scriptName: s.file.id,
        scriptHash: s.file.hash,
        truncated: s.structureDocument.truncated,
        embedding: structureVectors[i],
        features: s.features!,
        diagnostics: s.analyzed.diagnostics,
    }));

    const chunks = scripts.flatMap(s => s.descriptionChunks.map((text, index) => ({ script: s, text, index })));
    const descriptionVectors = await embedder.embedDocuments(
        chunks.map(c => c.text),
        (done, total) => onProgress?.({ stage: 'description', done, total }),
    );
    const description: DescriptionRow[] = chunks.map(({ script, text, index }, i) => ({
        scriptName: script.file.id,
        scriptHash: script.file.hash,
        chunkIndex: index,
        text,
        embedding: descriptionVectors[i],
    }));

    const withProperties = scripts.filter(s => s.properties != null && s.propertiesDocument.text.length > 0);
    const propertyVectors = await embedder.embedDocuments(
        withProperties.map(s => s.propertiesDocument.text),
        (done, total) => onProgress?.({ stage: 'properties', done, total }),
    );
    const properties: PropertiesRow[] = withProperties.map((s, i) => ({
        scriptName: s.file.id,
        scriptHash: s.file.hash,
        properties: s.properties!,
        text: s.propertiesDocument.text,
        truncated: s.propertiesDocument.truncated,
        embedding: propertyVectors[i],
    }));
    return { structure, description, properties };
}

export type IndexStage = 'analyze' | 'embed' | 'layout';

export interface IndexProgress {
    stage: IndexStage;
    /// 0 to 1 within the stage
    fraction: number;
    message: string;
}

export interface BuiltIndex extends IndexResult {
    /// Coordinates of the rows of every kind. The kinds are laid out independently, the description of a script would
    /// otherwise end up next to the structure of the scripts it is about instead of next to similar descriptions.
    layouts: Record<EmbeddingKind, LayoutResult>;
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
            stage: 'embed',
            fraction: total === 0 ? 1 : done / total,
            message: `Embedding ${stage} ${done}/${total}`,
        });
    });

    const dim = embedder.config.dim;
    const layOut = async (kind: EmbeddingKind) => {
        const rows: { embedding: Float32Array }[] = result[kind];
        const flat = new Float32Array(rows.length * dim);
        rows.forEach((row, i) => flat.set(row.embedding, i * dim));
        onProgress?.({ stage: 'layout', fraction: 0, message: `Laying out ${rows.length} ${kind} rows in 3D` });
        return await computeLayout(flat, rows.length, dim, (fraction, stage) => {
            onProgress?.({ stage: 'layout', fraction, message: `Laying out ${kind} (${stage})` });
        });
    };
    const layouts = {
        structure: await layOut('structure'),
        description: await layOut('description'),
        properties: await layOut('properties'),
    };
    return { ...result, layouts, analyzedScripts: scripts.length };
}
