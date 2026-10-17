import { join } from 'node:path';
import { HashEmbedder, TransformersEmbedder, cosine, type Embedder, type EmbedderConfig, type Pooling } from './embedding/embedder.js';
import { embeddingsOf, readParquetFile, type IndexFile } from './output/parquet.js';

export type Fusion = 'weighted' | 'rrf';

export interface SearchOptions {
    topK: number;
    fusion: Fusion;
    weightComments: number;
    weightFeatures: number;
    cacheDir?: string;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { topK: 10, fusion: 'weighted', weightComments: 0.6, weightFeatures: 0.4 };

export interface SearchHit {
    scriptName: string;
    score: number;
    commentScore: number | null;
    featureScore: number | null;
    bestComment: string | null;
    tables: string[];
}

export interface CommentMatch {
    score: number;
    text: string;
}

const RRF_K = 60;

/// Combine the best comment match and the feature similarity of each script into one ranking
export function fuseScores(
    comments: Map<string, CommentMatch>,
    features: Map<string, number>,
    options: Pick<SearchOptions, 'fusion' | 'weightComments' | 'weightFeatures'>,
): { scriptName: string; score: number; commentScore: number | null; featureScore: number | null }[] {
    const ids = new Set([...comments.keys(), ...features.keys()]);
    const rank = (scores: Map<string, number>): Map<string, number> => {
        const sorted = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        return new Map(sorted.map(([id], i) => [id, i + 1]));
    };
    const commentRanks = rank(new Map([...comments].map(([id, m]) => [id, m.score])));
    const featureRanks = rank(features);
    const out = [...ids].map(scriptName => {
        const commentScore = comments.get(scriptName)?.score ?? null;
        const featureScore = features.get(scriptName) ?? null;
        let score: number;
        if (options.fusion === 'rrf') {
            score = (commentRanks.has(scriptName) ? 1 / (RRF_K + commentRanks.get(scriptName)!) : 0) +
                (featureRanks.has(scriptName) ? 1 / (RRF_K + featureRanks.get(scriptName)!) : 0);
        } else if (commentScore !== null && featureScore !== null) {
            score = options.weightComments * commentScore + options.weightFeatures * featureScore;
        } else {
            // Scripts that miss one signal fall back to the other
            score = commentScore ?? featureScore ?? 0;
        }
        return { scriptName, score, commentScore, featureScore };
    });
    return out.sort((a, b) => b.score - a.score || a.scriptName.localeCompare(b.scriptName));
}

export function configFromMetadata(metadata: Map<string, string>): EmbedderConfig {
    const get = (key: string) => metadata.get(`dashql_embed.${key}`) ?? '';
    return {
        model: get('model'),
        dtype: get('dtype') || 'fp32',
        pooling: (get('pooling') || 'cls') as Pooling,
        queryPrefix: get('query_prefix'),
        documentPrefix: get('document_prefix'),
        maxTokens: Number(get('max_tokens')) || 512,
    };
}

/// Recreate the embedder that produced an index
export async function embedderForIndex(file: IndexFile, cacheDir?: string): Promise<Embedder> {
    const config = configFromMetadata(file.metadata);
    if (config.model.startsWith('hash-')) {
        return new HashEmbedder(file.dim, config.maxTokens);
    }
    return TransformersEmbedder.create({ ...config, cacheDir });
}

export interface LoadedIndex {
    features: IndexFile;
    comments: IndexFile | null;
}

export async function loadIndex(dir: string): Promise<LoadedIndex> {
    const features = await readParquetFile(join(dir, 'features.parquet'));
    const comments = await readParquetFile(join(dir, 'comments.parquet'));
    for (const key of ['model', 'dtype', 'pooling', 'query_prefix', 'dim']) {
        if (comments.metadata.get(`dashql_embed.${key}`) !== features.metadata.get(`dashql_embed.${key}`)) {
            throw new Error(`comments.parquet and features.parquet disagree on '${key}', they were not built together`);
        }
    }
    return { features, comments: comments.table.numRows > 0 ? comments : null };
}

function column(file: IndexFile, name: string): any[] {
    return file.table.getChild(name)!.toArray() as any[];
}

/// A script of the set that is searched
export interface ScriptRef {
    name: string;
    hash: string;
}

export interface SearchResult {
    hits: SearchHit[];
    /// Scripts of the set that are not in the index at all
    missing: string[];
    /// Scripts of the set that changed since they were indexed. They are not searched.
    stale: string[];
}

/// Rank the scripts of a set for a prompt, using the embeddings of the index files.
/// Index rows of scripts outside the set are ignored, scripts that changed since indexing are reported.
export async function searchIndex(
    index: LoadedIndex,
    prompt: string,
    embedder: Embedder,
    scripts: ScriptRef[],
    options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): Promise<SearchResult> {
    const query = await embedder.embedQuery(prompt);
    const dim = index.features.dim;
    const current = new Map(scripts.map(s => [s.name, s.hash]));

    const featureNames = column(index.features, 'script_name') as string[];
    const featureHashes = column(index.features, 'script_hash') as string[];
    const commentNames = index.comments ? (column(index.comments, 'script_name') as string[]) : [];
    const commentHashes = index.comments ? (column(index.comments, 'script_hash') as string[]) : [];

    // A script is searchable if every indexed row matches its current content
    const indexed = new Set<string>();
    const stale = new Set<string>();
    const note = (names: string[], hashes: string[]) =>
        names.forEach((name, i) => {
            if (!current.has(name)) return;
            indexed.add(name);
            if (hashes[i] !== current.get(name)) stale.add(name);
        });
    note(featureNames, featureHashes);
    note(commentNames, commentHashes);
    const searchable = (name: string) => current.has(name) && !stale.has(name);

    const featureVectors = embeddingsOf(index.features);
    const featureScores = new Map<string, number>();
    featureNames.forEach((name, i) => {
        if (searchable(name)) featureScores.set(name, cosine(query, featureVectors.subarray(i * dim, (i + 1) * dim)));
    });

    const commentMatches = new Map<string, CommentMatch>();
    if (index.comments) {
        const vectors = embeddingsOf(index.comments);
        const texts = column(index.comments, 'text') as string[];
        commentNames.forEach((name, i) => {
            if (!searchable(name)) return;
            const score = cosine(query, vectors.subarray(i * dim, (i + 1) * dim));
            if (score > (commentMatches.get(name)?.score ?? -Infinity)) commentMatches.set(name, { score, text: texts[i] });
        });
    }

    const tablesByScript = new Map<string, string[]>();
    const tableColumn = index.features.table.getChild('tables')!;
    featureNames.forEach((name, i) => tablesByScript.set(name, Array.from(tableColumn.get(i) as Iterable<string>)));

    const hits = fuseScores(commentMatches, featureScores, options)
        .slice(0, options.topK)
        .map(hit => ({
            ...hit,
            bestComment: commentMatches.get(hit.scriptName)?.text ?? null,
            tables: tablesByScript.get(hit.scriptName) ?? [],
        }));
    return {
        hits,
        missing: scripts.filter(s => !indexed.has(s.name)).map(s => s.name),
        stale: [...stale].sort(),
    };
}
