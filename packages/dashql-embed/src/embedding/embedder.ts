import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Pooling = 'cls' | 'mean';

/// The settings that define an embedding space. They are stored in the Parquet metadata
/// so that queries are embedded exactly like the indexed documents.
export interface EmbedderConfig {
    model: string;
    dtype: string;
    pooling: Pooling;
    queryPrefix: string;
    documentPrefix: string;
    maxTokens: number;
}

export interface Embedder {
    readonly config: EmbedderConfig;
    readonly dim: number;
    countTokens(text: string): number;
    embedDocuments(texts: string[]): Promise<Float32Array[]>;
    embedQuery(text: string): Promise<Float32Array>;
}

export const DEFAULT_MODEL = 'Snowflake/snowflake-arctic-embed-xs';

const SNOWFLAKE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const PRESETS: Record<string, Partial<EmbedderConfig>> = {
    'Snowflake/snowflake-arctic-embed-xs': { pooling: 'cls', queryPrefix: SNOWFLAKE_QUERY_PREFIX, maxTokens: 512 },
    'Snowflake/snowflake-arctic-embed-s': { pooling: 'cls', queryPrefix: SNOWFLAKE_QUERY_PREFIX, maxTokens: 512 },
    'Snowflake/snowflake-arctic-embed-m-v2.0': { pooling: 'cls', queryPrefix: 'query: ', maxTokens: 8192 },
};

export interface EmbedderOptions {
    model?: string;
    dtype?: string;
    pooling?: Pooling;
    queryPrefix?: string;
    maxTokens?: number;
    batchSize?: number;
    cacheDir?: string;
}

export function resolveConfig(options: EmbedderOptions): EmbedderConfig {
    const model = options.model ?? DEFAULT_MODEL;
    const preset = PRESETS[model];
    if (!preset) {
        throw new Error(`unsupported model '${model}', supported models: ${Object.keys(PRESETS).join(', ')}`);
    }
    return {
        model,
        dtype: options.dtype ?? 'fp32',
        pooling: options.pooling ?? preset.pooling!,
        queryPrefix: options.queryPrefix ?? preset.queryPrefix ?? '',
        documentPrefix: '',
        maxTokens: options.maxTokens ?? preset.maxTokens ?? 512,
    };
}

export function defaultCacheDir(): string {
    return process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, 'dashql-embed') : join(homedir(), '.cache', 'dashql-embed');
}

/// Embeds with transformers.js (ONNX runtime, CPU)
export class TransformersEmbedder implements Embedder {
    private constructor(
        readonly config: EmbedderConfig,
        readonly dim: number,
        private readonly extractor: any,
        private readonly batchSize: number,
    ) {}

    static async create(options: EmbedderOptions): Promise<TransformersEmbedder> {
        const config = resolveConfig(options);
        // Loaded lazily so that offline runs never touch the ONNX runtime
        const { pipeline, env } = await import('@huggingface/transformers');
        // The default cache lives inside node_modules which is read-only under Bazel
        env.cacheDir = join(options.cacheDir ?? defaultCacheDir(), 'models');
        const extractor: any = await pipeline('feature-extraction', config.model, {
            dtype: config.dtype as any,
            device: 'cpu',
        });
        const probe = await extractor('dimension probe', { pooling: config.pooling, normalize: true });
        const dim = probe.dims[probe.dims.length - 1] as number;
        return new TransformersEmbedder(config, dim, extractor, options.batchSize ?? 32);
    }

    countTokens(text: string): number {
        return this.extractor.tokenizer.encode(text).length;
    }

    private async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += this.batchSize) {
            const batch = texts.slice(i, i + this.batchSize);
            const tensor = await this.extractor(batch, { pooling: this.config.pooling, normalize: true });
            const data = tensor.data as Float32Array;
            for (let j = 0; j < batch.length; ++j) {
                out.push(data.slice(j * this.dim, (j + 1) * this.dim));
            }
        }
        return out;
    }

    embedDocuments(texts: string[]): Promise<Float32Array[]> {
        return this.embed(texts.map(t => this.config.documentPrefix + t));
    }

    async embedQuery(text: string): Promise<Float32Array> {
        return (await this.embed([this.config.queryPrefix + text]))[0];
    }
}

/// A deterministic bag-of-words feature hashing embedder.
/// It needs no model download and is used for tests and offline runs.
export class HashEmbedder implements Embedder {
    readonly config: EmbedderConfig;

    constructor(readonly dim = 128, maxTokens = 256) {
        this.config = {
            model: `hash-${dim}`,
            dtype: 'fp32',
            pooling: 'mean',
            queryPrefix: '',
            documentPrefix: '',
            maxTokens,
        };
    }

    private tokens(text: string): string[] {
        return text.toLowerCase().match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
    }

    countTokens(text: string): number {
        return this.tokens(text).length;
    }

    private vector(text: string): Float32Array {
        const v = new Float32Array(this.dim);
        for (const token of this.tokens(text)) {
            if (!/[\p{L}\p{N}]/u.test(token)) continue;
            const digest = createHash('sha256').update(token).digest();
            const index = digest.readUInt32LE(0) % this.dim;
            v[index] += digest[4] & 1 ? 1 : -1;
        }
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < v.length; ++i) v[i] /= norm;
        return v;
    }

    async embedDocuments(texts: string[]): Promise<Float32Array[]> {
        return texts.map(t => this.vector(t));
    }

    async embedQuery(text: string): Promise<Float32Array> {
        return this.vector(text);
    }
}

export function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; ++i) dot += a[i] * b[i];
    return dot;
}
