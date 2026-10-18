/// Runs the embedding model (transformers.js, ONNX runtime wasm) off the main thread.
/// See embedder_protocol.ts for the messages and embedder_client.ts for the main-thread driver.
import {
    EmbedderRequest,
    EmbedderRequestType,
    EmbedderResponse,
    EmbedderResponseType,
} from './embedder_protocol.js';
import type { EmbedderConfig } from './model.js';
import { configureTransformers, pipelineOptions } from './transformers_env.js';

const BATCH_SIZE = 32;

let extractor: any = null;
let activeConfig: EmbedderConfig | null = null;
let dim = 0;

function post(message: EmbedderResponse, transfer?: Transferable[]): void {
    // eslint-disable-next-line no-restricted-globals
    (self as unknown as Worker).postMessage(message, transfer ?? []);
}

async function init(id: number, baseUrl: string, config: EmbedderConfig): Promise<void> {
    const { pipeline, env } = await import('@huggingface/transformers');
    configureTransformers(env, baseUrl);
    extractor = await pipeline('feature-extraction', config.model, pipelineOptions(config, progress => {
        post({ id, type: EmbedderResponseType.DOWNLOAD, progress });
    }) as any);
    activeConfig = config;
    const probe = await extractor('dimension probe', { pooling: config.pooling, normalize: true });
    dim = probe.dims[probe.dims.length - 1] as number;
    post({ id, type: EmbedderResponseType.READY, dim });
}

async function embed(id: number, texts: string[]): Promise<void> {
    if (extractor == null || activeConfig == null) throw new Error('the embedder is not initialized');
    const out = new Float32Array(texts.length * dim);
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const tensor = await extractor(batch, { pooling: activeConfig.pooling, normalize: true });
        out.set(tensor.data as Float32Array, i * dim);
        post({ id, type: EmbedderResponseType.PROGRESS, done: Math.min(i + BATCH_SIZE, texts.length), total: texts.length });
    }
    post({ id, type: EmbedderResponseType.RESULT, data: out, count: texts.length }, [out.buffer]);
}

// eslint-disable-next-line no-restricted-globals
self.onmessage = (event: MessageEvent<EmbedderRequest>) => {
    const request = event.data;
    const run = request.type === EmbedderRequestType.INIT
        ? init(request.id, request.baseUrl, request.config)
        : embed(request.id, request.texts);
    run.catch((e: unknown) => {
        // The stack is part of the message, an error from the worker has no other trace in the logs
        const stack = e instanceof Error && e.stack ? `\n${e.stack.split('\n').slice(1, 6).join('\n')}` : '';
        post({ id: request.id, type: EmbedderResponseType.ERROR, error: (e instanceof Error ? e.message : String(e)) + stack });
    });
};
