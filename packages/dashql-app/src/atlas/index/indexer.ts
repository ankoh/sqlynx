import { readMetadata, type ScriptMetadata } from '@ankoh/dashql-core';

import type { TracedLogger } from '../../platform/logger/logger.js';
import { descriptionText, extractComments } from './analysis/comments.js';
import { SqlAnalyzer, type AnalyzedSql } from './analysis/core.js';
import { extractStructureFeatures, type StructureFeatures } from './analysis/structure.js';
import { computeLayout, type LayoutResult } from './layout.js';
import type { Embedder } from './model.js';
import type { IndexRow } from './rows.js';
import type { SqlFile } from './scan.js';

export const INDEX_LOG_CTX = 'atlas_index';

/// The embedding-free part of an indexed script
export interface ScriptAnalysis {
    file: SqlFile;
    analyzed: AnalyzedSql;
    features: StructureFeatures | null;
    /// Null without a description
    description: string | null;
    metadata: ScriptMetadata | null;
}

/// Analyze scripts and extract the descriptions that will be embedded
export function analyzeScripts(files: SqlFile[], analyzer: SqlAnalyzer): ScriptAnalysis[] {
    const analyzed = analyzer.analyze(files.map(f => ({ id: f.id, text: f.text })));
    return analyzed.map((sql, i) => {
        const features = extractStructureFeatures(sql);
        const description = descriptionText(extractComments(sql));
        const metadata = sql.parsed ? readMetadata(sql.parsed, sql.bytes) : null;
        return { file: files[i], analyzed: sql, features, description, metadata };
    });
}

/// Does a script get rows in the index? Only described scripts do.
export function hasDescription(script: ScriptAnalysis): boolean {
    return script.description != null;
}

/// Embed the descriptions of analyzed scripts, a row per script. Scripts without a description get no row.
export async function embedScripts(
    scripts: ScriptAnalysis[],
    embedder: Embedder,
    onProgress?: (done: number, total: number) => void,
): Promise<IndexRow[]> {
    const described = scripts.filter(hasDescription);
    const vectors = await embedder.embedDocuments(described.map(s => s.description!), onProgress);
    return described.map((script, i) => ({
        scriptName: script.file.id,
        scriptHash: script.file.hash,
        description: script.description!,
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

/// One record per script: whether it gets a row and what the analysis found
function logScript(script: ScriptAnalysis, log: TracedLogger): void {
    const details: Record<string, string | undefined> = {
        script: script.file.id,
        chars: String(script.file.text.length),
        parsed: String(script.analyzed.parsed != null),
        statements: script.features?.statementTypes.join(', '),
        tables: script.features?.tables.join(', '),
        metadata_keys: script.metadata == null ? undefined : Object.keys(script.metadata).join(', '),
        diagnostics: String(script.analyzed.diagnostics.length),
        first_diagnostic: script.analyzed.diagnostics[0],
    };
    if (script.description == null) {
        log.info('Not indexing script, it has no description', details, INDEX_LOG_CTX);
    } else if (script.analyzed.diagnostics.length > 0) {
        log.warn('Indexing script with diagnostics', { ...details, description_chars: String(script.description.length) }, INDEX_LOG_CTX);
    } else {
        log.info('Indexing script', { ...details, description_chars: String(script.description.length) }, INDEX_LOG_CTX);
    }
}

/// Everything between the scanned files and the rows of the Parquet file. Every script and every stage is logged to
/// `log`.
export async function buildIndex(
    files: SqlFile[],
    analyzer: SqlAnalyzer,
    embedder: Embedder,
    onProgress?: (progress: IndexProgress) => void,
    log?: TracedLogger,
): Promise<BuiltIndex> {
    let stageStart = performance.now();
    const stageMs = () => {
        const now = performance.now();
        const ms = String(Math.round(now - stageStart));
        stageStart = now;
        return ms;
    };

    onProgress?.({ stage: 'analyze', fraction: 0, message: `Analyzing ${files.length} scripts` });
    const scripts = analyzeScripts(files, analyzer);
    onProgress?.({ stage: 'analyze', fraction: 1, message: `Analyzed ${files.length} scripts` });
    const described = scripts.filter(hasDescription).length;
    log?.info('Analyzed scripts', {
        scripts: String(scripts.length),
        described: String(described),
        unparsable: String(scripts.filter(s => s.analyzed.parsed == null).length),
        ms: stageMs(),
    }, INDEX_LOG_CTX);
    if (log != null) for (const script of scripts) logScript(script, log);

    const rows = await embedScripts(scripts, embedder, (done, total) => {
        onProgress?.({
            stage: 'embed',
            fraction: total === 0 ? 1 : done / total,
            message: `Embedding descriptions ${done}/${total}`,
        });
        log?.debug('Embedded descriptions', { done: String(done), total: String(total) }, INDEX_LOG_CTX);
    });
    log?.info('Embedded descriptions', { rows: String(rows.length), model: embedder.config.model, ms: stageMs() }, INDEX_LOG_CTX);

    const dim = embedder.config.dim;
    const flat = new Float32Array(rows.length * dim);
    rows.forEach((row, i) => flat.set(row.embedding, i * dim));
    onProgress?.({ stage: 'layout', fraction: 0, message: `Laying out ${rows.length} descriptions in 3D` });
    const layout = await computeLayout(flat, rows.length, dim, (fraction, stage) => {
        onProgress?.({ stage: 'layout', fraction, message: `Laying out descriptions (${stage})` });
    });
    log?.info('Laid out descriptions', { rows: String(rows.length), layout: layout.mode, ms: stageMs() }, INDEX_LOG_CTX);
    return { rows, layout, analyzedScripts: scripts.length };
}
