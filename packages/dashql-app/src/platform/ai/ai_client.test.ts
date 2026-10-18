import { describe, it, expect, vi } from 'vitest';

import { AIClient } from './ai_client.js';
import { Logger } from '../logger/logger.js';
import type { HttpClient, HttpFetchResult } from '../http/http_client.js';

class NullLogger extends Logger {
    public destroy(): void { }
    protected flushPendingRecords(): void { }
}

function makeResponse(body: unknown, status = 200): HttpFetchResult {
    const text = JSON.stringify(body);
    return {
        headers: new Headers(),
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
        json: async () => body,
        text: async () => text,
    };
}

const CONFIG = { endpointUrl: 'http://localhost:11434', model: 'm', headers: [] };

describe('AIClient', () => {
    const logger = new NullLogger();

    it('listModels GETs /v1/models with configured headers and returns ids', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
        const httpClient: HttpClient = { fetch };
        const client = new AIClient(logger, httpClient, {
            ...CONFIG,
            headers: [{ name: 'Authorization', value: 'Bearer xyz' }],
        });

        const models = await client.listModels(new AbortController().signal);
        expect(models).toEqual(['a', 'b']);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url.toString()).toBe('http://localhost:11434/v1/models');
        expect(init.method).toBe('GET');
        expect(init.headers).toMatchObject({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer xyz',
        });
    });

    it('strips trailing slashes from the endpoint', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ data: [] }));
        const client = new AIClient(logger, { fetch }, { ...CONFIG, endpointUrl: 'http://localhost:11434/' });
        await client.listModels(new AbortController().signal);
        expect(fetch.mock.calls[0][0].toString()).toBe('http://localhost:11434/v1/models');
    });

    it('throws on non-2xx', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ error: 'nope' }, 401));
        const client = new AIClient(logger, { fetch }, CONFIG);
        await expect(client.listModels(new AbortController().signal)).rejects.toThrow(/HTTP 401/);
    });

    it('complete POSTs /v1/chat/completions and returns the first choice', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({
            choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
        }));
        const client = new AIClient(logger, { fetch }, { ...CONFIG, model: 'llama3' });

        const messages = [{ role: 'system' as const, content: 'be brief' }, { role: 'user' as const, content: 'hi' }];
        const result = await client.complete(messages, new AbortController().signal);
        expect(result).toEqual({ content: 'hello world', promptTokens: 12, completionTokens: 3, finishReason: 'stop' });
        const [url, init] = fetch.mock.calls[0];
        expect(url.toString()).toBe('http://localhost:11434/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ model: 'llama3', messages, stream: false });
    });

    it('complete asks for a JSON schema in the OpenAI response format', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ choices: [{ message: { content: '{}' } }] }));
        const client = new AIClient(logger, { fetch }, CONFIG);
        const schema = { type: 'object', properties: { summary: { type: 'string' } } };
        await client.complete([{ role: 'user', content: 'hi' }], new AbortController().signal, {
            jsonSchema: { name: 'description', schema },
        });
        expect(JSON.parse(fetch.mock.calls[0][1].body as string).response_format).toEqual({
            type: 'json_schema',
            json_schema: { name: 'description', schema, strict: true },
        });
    });

    it('complete returns an empty string without choices', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ choices: [] }));
        const client = new AIClient(logger, { fetch }, CONFIG);
        expect((await client.complete([{ role: 'user', content: 'hi' }], new AbortController().signal)).content).toBe('');
    });

    it('embedDocuments POSTs /v1/embeddings and orders the vectors by index', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({
            data: [
                { index: 1, embedding: [3, 4] },
                { index: 0, embedding: [1, 2] },
            ],
        }));
        const client = new AIClient(logger, { fetch }, { ...CONFIG, model: 'nomic-embed-text' });

        const vectors = await client.embedDocuments(['a', 'b'], new AbortController().signal);
        expect(vectors).toEqual([Float32Array.from([1, 2]), Float32Array.from([3, 4])]);
        const [url, init] = fetch.mock.calls[0];
        expect(url.toString()).toBe('http://localhost:11434/v1/embeddings');
        expect(JSON.parse(init.body as string)).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
    });

    it('embedQuery embeds a single text', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ data: [{ index: 0, embedding: [1, 2] }] }));
        const client = new AIClient(logger, { fetch }, CONFIG);
        expect(await client.embedQuery('q', new AbortController().signal)).toEqual(Float32Array.from([1, 2]));
        expect(JSON.parse(fetch.mock.calls[0][1].body as string).input).toEqual(['q']);
    });

    it('embedDocuments fails when a vector is missing and skips empty inputs', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ data: [{ index: 0, embedding: [1] }] }));
        const client = new AIClient(logger, { fetch }, CONFIG);
        await expect(client.embedDocuments(['a', 'b'], new AbortController().signal)).rejects.toThrow(/text 1/);
        expect(await client.embedDocuments([], new AbortController().signal)).toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
