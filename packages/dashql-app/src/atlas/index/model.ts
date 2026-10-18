/// The settings that define an embedding space. They are stored in the index sidecar so that a query is embedded
/// exactly like the indexed documents.
export interface EmbedderConfig {
    model: string;
    dtype: 'fp32' | 'fp16' | 'q8' | 'q4';
    pooling: 'cls' | 'mean';
    queryPrefix: string;
    documentPrefix: string;
    maxTokens: number;
    dim: number;
}

export const ATLAS_EMBEDDER_CONFIG: EmbedderConfig = {
    model: 'Snowflake/snowflake-arctic-embed-xs',
    dtype: 'fp32',
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    documentPrefix: '',
    maxTokens: 512,
    dim: 384,
};

/// Where the model files live, relative to the page. Overridable through `atlas.modelBaseUrl` in static/config.json.
/// Expected layout: <base>/<model>/{config.json,tokenizer.json,tokenizer_config.json,onnx/model.onnx} and
/// <base>/ort/ort-wasm-simd-threaded.asyncify.{mjs,wasm}. Another origin has to allow the Range header (CORS) and send
/// Cross-Origin-Resource-Policy, the page is cross-origin isolated.
export const DEFAULT_MODEL_BASE_URL = '/static/models/';

/// Embeds texts. Documents and queries differ in their prefix.
export interface Embedder {
    readonly config: EmbedderConfig;
    countTokens(text: string): number;
    embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<Float32Array[]>;
    embedQuery(text: string): Promise<Float32Array>;
}
