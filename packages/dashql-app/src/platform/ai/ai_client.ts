import { HttpClient, HttpFetchResult } from '../http/http_client.js';
import { Logger } from '../logger/logger.js';
import { AIModelConfig, AIModelHeader } from './ai_models.js';
import { AIChatMessage, AIDescribeClient, AIEmbedClient } from './ai_task_clients.js';

const LOG_CTX = 'ai_client';

interface ChatCompletionResponse {
    choices?: { message?: { content?: string } }[];
}

interface EmbeddingsResponse {
    data?: { index?: number; embedding?: number[] }[];
}

interface ListModelsResponse {
    data?: { id?: string }[];
}

function joinUrl(base: string, path: string): URL {
    const trimmed = base.replace(/\/+$/, '');
    return new URL(trimmed + path);
}

function buildHeaders(extra: AIModelHeader[]): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
    for (const h of extra) {
        if (h.name) headers[h.name] = h.value;
    }
    return headers;
}

async function checkStatus(response: HttpFetchResult): Promise<void> {
    if (response.status < 200 || response.status >= 300) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
    }
}

/// A client for one model behind an OpenAI-compatible REST API.
/// Works with OpenAI, Ollama (/v1/* compat layer), vLLM, llama.cpp, LM Studio, etc.
export class AIClient implements AIDescribeClient, AIEmbedClient {
    logger: Logger;
    httpClient: HttpClient;
    config: AIModelConfig;

    constructor(logger: Logger, httpClient: HttpClient, config: AIModelConfig) {
        this.logger = logger;
        this.httpClient = httpClient;
        this.config = config;
    }

    /// List the models of the endpoint. Used by the Test button in the AI settings.
    async listModels(signal: AbortSignal): Promise<string[]> {
        const url = joinUrl(this.config.endpointUrl, '/v1/models');
        this.logger.debug('Listing AI models', { url: url.toString() }, LOG_CTX);
        const response = await this.httpClient.fetch(url, {
            method: 'GET',
            headers: buildHeaders(this.config.headers),
            signal,
        });
        await checkStatus(response);
        const parsed = (await response.json()) as ListModelsResponse;
        const ids: string[] = [];
        for (const m of parsed.data ?? []) {
            if (typeof m.id === 'string') ids.push(m.id);
        }
        return ids;
    }

    /// Generate a chat completion
    async complete(messages: AIChatMessage[], signal: AbortSignal): Promise<string> {
        const url = joinUrl(this.config.endpointUrl, '/v1/chat/completions');
        const body = JSON.stringify({
            model: this.config.model,
            messages,
            stream: false,
        });
        this.logger.debug('Calling AI chat completion', { url: url.toString(), model: this.config.model }, LOG_CTX);
        const response = await this.httpClient.fetch(url, {
            method: 'POST',
            headers: buildHeaders(this.config.headers),
            body,
            signal,
        });
        await checkStatus(response);
        const parsed = (await response.json()) as ChatCompletionResponse;
        const content = parsed.choices?.[0]?.message?.content ?? '';
        this.logger.debug('Received AI chat completion', { length: String(content.length) }, LOG_CTX);
        return content;
    }

    /// Embed a query. Queries and documents are embedded the same way.
    async embedQuery(text: string, signal: AbortSignal): Promise<Float32Array> {
        return (await this.embedDocuments([text], signal))[0];
    }

    /// Embed texts, one vector per text in the order of the texts. The vectors are returned as the model produces them,
    /// whether they are normalized depends on the model.
    async embedDocuments(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        const url = joinUrl(this.config.endpointUrl, '/v1/embeddings');
        const body = JSON.stringify({
            model: this.config.model,
            input: texts,
        });
        this.logger.debug('Calling AI embeddings', { url: url.toString(), model: this.config.model, count: String(texts.length) }, LOG_CTX);
        const response = await this.httpClient.fetch(url, {
            method: 'POST',
            headers: buildHeaders(this.config.headers),
            body,
            signal,
        });
        await checkStatus(response);
        const parsed = (await response.json()) as EmbeddingsResponse;
        const vectors: (Float32Array | undefined)[] = new Array(texts.length);
        (parsed.data ?? []).forEach((entry, i) => {
            const index = entry.index ?? i;
            if (Array.isArray(entry.embedding) && index >= 0 && index < texts.length) {
                vectors[index] = Float32Array.from(entry.embedding);
            }
        });
        const missing = vectors.findIndex(v => v == null);
        if (missing >= 0) {
            throw new Error(`the embedding response is missing the vector of text ${missing}`);
        }
        return vectors as Float32Array[];
    }
}
