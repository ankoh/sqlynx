import type { AIEmbedClient } from '../../platform/ai/ai_task_clients.js';
import { AtlasEmbedder } from './embedder_client.js';
import { ATLAS_EMBEDDER_CONFIG } from './model.js';

/// The embed client of the model that is bundled with the app. The model is loaded on first use, it is 90 MB.
export class BundledEmbedClient implements AIEmbedClient {
    private embedder: Promise<AtlasEmbedder> | null = null;
    private disposed = false;

    constructor(private readonly baseUrl: string) {}

    async embedDocuments(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
        const vectors = await (await this.load()).embedDocuments(texts);
        signal.throwIfAborted();
        return vectors;
    }

    async embedQuery(text: string, signal: AbortSignal): Promise<Float32Array> {
        const vector = await (await this.load()).embedQuery(text);
        signal.throwIfAborted();
        return vector;
    }

    dispose(): void {
        this.disposed = true;
        this.embedder?.then(e => e.dispose(), () => {});
        this.embedder = null;
    }

    private load(): Promise<AtlasEmbedder> {
        if (this.disposed) return Promise.reject(new Error('the bundled embedder was disposed'));
        this.embedder ??= AtlasEmbedder.create(this.baseUrl, ATLAS_EMBEDDER_CONFIG).catch(e => {
            this.embedder = null;
            throw e;
        });
        return this.embedder;
    }
}
