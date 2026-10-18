import {
    EmbedderRequestType,
    EmbedderResponse,
    EmbedderResponseType,
    type EmbedderRequest,
} from './embedder_protocol.js';
import type { Embedder, EmbedderConfig } from './model.js';
import { configureTransformers, pipelineOptions, type DownloadProgress } from './transformers_env.js';

type Pending = {
    resolve: (response: EmbedderResponse) => void;
    reject: (error: Error) => void;
    onProgress?: (done: number, total: number) => void;
    onDownload?: (progress: DownloadProgress) => void;
};

/// Embeds with the model in a worker. The tokenizer lives on the main thread: chunking needs token counts synchronously,
/// a round trip to the worker per candidate chunk would be far too slow.
export class AtlasEmbedder implements Embedder {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();

    private constructor(
        readonly config: EmbedderConfig,
        private readonly worker: Worker,
        private readonly tokenizer: any,
    ) {
        worker.onmessage = (event: MessageEvent<EmbedderResponse>) => this.onMessage(event.data);
        worker.onerror = event => this.failAll(new Error(event.message || 'embedder worker error'));
    }

    static async create(
        baseUrl: string,
        config: EmbedderConfig,
        onDownload?: (progress: DownloadProgress) => void,
    ): Promise<AtlasEmbedder> {
        const { AutoTokenizer, env } = await import('@huggingface/transformers');
        configureTransformers(env, baseUrl);
        const tokenizer = await AutoTokenizer.from_pretrained(config.model, {
            progress_callback: pipelineOptions(config, onDownload).progress_callback,
        } as any);
        const worker = new Worker(new URL('./embedder_worker.js', import.meta.url), { type: 'module' });
        const embedder = new AtlasEmbedder(config, worker, tokenizer);
        const ready = await embedder.request({ type: EmbedderRequestType.INIT, baseUrl, config }, { onDownload });
        if (ready.type === EmbedderResponseType.READY && ready.dim !== config.dim) {
            embedder.dispose();
            throw new Error(`the model produces ${ready.dim} dimensions, expected ${config.dim}`);
        }
        return embedder;
    }

    countTokens(text: string): number {
        return this.tokenizer.encode(text).length;
    }

    async embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<Float32Array[]> {
        return await this.embed(texts.map(t => this.config.documentPrefix + t), onProgress);
    }

    async embedQuery(text: string): Promise<Float32Array> {
        return (await this.embed([this.config.queryPrefix + text]))[0];
    }

    dispose(): void {
        this.failAll(new Error('the embedder was disposed'));
        this.worker.terminate();
    }

    private async embed(texts: string[], onProgress?: (done: number, total: number) => void): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        const response = await this.request({ type: EmbedderRequestType.EMBED, texts }, { onProgress });
        if (response.type !== EmbedderResponseType.RESULT) throw new Error('unexpected embedder response');
        const dim = this.config.dim;
        return Array.from({ length: response.count }, (_, i) => response.data.slice(i * dim, (i + 1) * dim));
    }

    private request(
        request: DistributiveOmit<EmbedderRequest, 'id'>,
        handlers: Pick<Pending, 'onProgress' | 'onDownload'> = {},
    ): Promise<EmbedderResponse> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, ...handlers });
            this.worker.postMessage({ ...request, id });
        });
    }

    private onMessage(message: EmbedderResponse): void {
        const pending = this.pending.get(message.id);
        if (pending == null) return;
        switch (message.type) {
            case EmbedderResponseType.DOWNLOAD:
                pending.onDownload?.(message.progress);
                break;
            case EmbedderResponseType.PROGRESS:
                pending.onProgress?.(message.done, message.total);
                break;
            case EmbedderResponseType.ERROR:
                this.pending.delete(message.id);
                pending.reject(new Error(message.error));
                break;
            default:
                this.pending.delete(message.id);
                pending.resolve(message);
        }
    }

    private failAll(error: Error): void {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
