import { describe, it, expect, vi } from 'vitest';

import { AIClient, buildAuthorization } from './ai_client.js';
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

describe('AIClient', () => {
    const logger = new NullLogger();

    it('listModels GETs /v1/models with configured headers and returns ids', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
        const httpClient: HttpClient = { fetch };
        const client = new AIClient(logger, httpClient, {
            endpointUrl: 'http://localhost:11434',
            model: 'llama3',
            headers: [{ name: 'Authorization', value: 'Bearer xyz' }],
            auth: { type: 'none' },
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

    it('listModels strips trailing slash from endpoint', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ data: [] }));
        const client = new AIClient(logger, { fetch }, {
            endpointUrl: 'http://localhost:11434/',
            model: 'm',
            headers: [],
            auth: { type: 'none' },
        });
        await client.listModels(new AbortController().signal);
        expect(fetch.mock.calls[0][0].toString()).toBe('http://localhost:11434/v1/models');
    });

    it('listModels throws on non-2xx', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ error: 'nope' }, 401));
        const client = new AIClient(logger, { fetch }, {
            endpointUrl: 'http://localhost:11434',
            model: 'm',
            headers: [],
            auth: { type: 'none' },
        });
        await expect(client.listModels(new AbortController().signal)).rejects.toThrow(/HTTP 401/);
    });

    it('generate POSTs /v1/chat/completions with OpenAI body and returns first choice content', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({
            choices: [{ message: { content: 'hello world' } }],
        }));
        const client = new AIClient(logger, { fetch }, {
            endpointUrl: 'http://localhost:11434',
            model: 'llama3',
            headers: [],
            auth: { type: 'none' },
        });

        const result = await client.generate('hi', new AbortController().signal);
        expect(result).toBe('hello world');
        const [url, init] = fetch.mock.calls[0];
        expect(url.toString()).toBe('http://localhost:11434/v1/chat/completions');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
            model: 'llama3',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        });
    });

    it('complete sends the whole conversation', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({
            choices: [{ message: { content: 'select 1' } }],
        }));
        const client = new AIClient(logger, { fetch }, {
            endpointUrl: 'http://localhost:11434',
            model: 'llama3',
            headers: [],
            auth: { type: 'none' },
        });
        const messages = [
            { role: 'system' as const, content: 'Write SQL' },
            { role: 'user' as const, content: 'one' },
        ];
        expect(await client.complete(messages, new AbortController().signal)).toBe('select 1');
        const body = JSON.parse(fetch.mock.calls[0][1].body as string);
        expect(body).toEqual({ model: 'llama3', messages, stream: false });
    });

    it('logs the prompt and the response', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ choices: [{ message: { content: 'select 1' } }] }));
        const testLogger = new NullLogger();
        const info = vi.spyOn(testLogger, 'info');
        const client = new AIClient(testLogger, { fetch }, {
            endpointUrl: 'http://localhost:11434',
            model: 'llama3',
            headers: [],
            auth: { type: 'bearer', token: 'secret' },
        });
        await client.complete([
            { role: 'system', content: 'Write SQL' },
            { role: 'user', content: 'one' },
        ], new AbortController().signal);
        expect(info).toHaveBeenCalledWith('Sending AI chat completion', {
            url: 'http://localhost:11434/v1/chat/completions',
            model: 'llama3',
            message_0_system: 'Write SQL',
            message_1_user: 'one',
        }, 'ai_client');
        expect(info).toHaveBeenCalledWith('Received AI chat completion', expect.objectContaining({
            model: 'llama3',
            content: 'select 1',
        }), 'ai_client');
        expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
    });

    describe('completeValidated', () => {
        const answers = (...contents: string[]) => {
            const fetch = vi.fn();
            for (const content of contents) {
                fetch.mockResolvedValueOnce(makeResponse({ choices: [{ message: { content } }] }));
            }
            return fetch;
        };
        const settings = { endpointUrl: 'http://localhost:11434', model: 'm', headers: [], auth: { type: 'none' as const } };
        const validate = (content: string) => content === 'good'
            ? { valid: true as const, value: content }
            : { valid: false as const, value: content, feedback: `fix ${content}` };
        const question = [{ role: 'user' as const, content: 'q' }];

        it('returns the first valid answer', async () => {
            const fetch = answers('good');
            const client = new AIClient(logger, { fetch }, settings);
            expect(await client.completeValidated(question, validate, new AbortController().signal))
                .toEqual({ valid: true, value: 'good' });
            expect(fetch).toHaveBeenCalledOnce();
        });

        it('retries with the rejected answer and the feedback', async () => {
            const fetch = answers('bad', 'good');
            const client = new AIClient(logger, { fetch }, settings);
            expect(await client.completeValidated(question, validate, new AbortController().signal))
                .toEqual({ valid: true, value: 'good' });
            expect(JSON.parse(fetch.mock.calls[1][1].body as string).messages).toEqual([
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'bad' },
                { role: 'user', content: 'fix bad' },
            ]);
        });

        it('returns the verdict on the last answer once the attempts are used up', async () => {
            const fetch = answers('bad', 'worse', 'good');
            const client = new AIClient(logger, { fetch }, settings);
            expect(await client.completeValidated(question, validate, new AbortController().signal))
                .toEqual({ valid: false, value: 'worse', feedback: 'fix worse' });
            expect(fetch).toHaveBeenCalledTimes(2);
        });
    });

    it('generate returns empty string when no choices', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ choices: [] }));
        const client = new AIClient(logger, { fetch }, {
            endpointUrl: 'http://localhost:11434',
            model: 'm',
            headers: [],
            auth: { type: 'none' },
        });
        const out = await client.generate('hi', new AbortController().signal);
        expect(out).toBe('');
    });
    it('sends basic auth as base64 of username and password', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ data: [] }));
        const client = new AIClient(logger, { fetch }, {
            endpointUrl: 'http://127.0.0.1:4097',
            model: 'm',
            headers: [],
            auth: { type: 'basic', username: 'opencode', password: 'secret' },
        });
        await client.listModels(new AbortController().signal);
        expect(fetch.mock.calls[0][1].headers).toMatchObject({
            'Authorization': `Basic ${btoa('opencode:secret')}`,
        });
    });

    it('sends bearer auth and overrides an Authorization header', async () => {
        const fetch = vi.fn().mockResolvedValue(makeResponse({ choices: [] }));
        const client = new AIClient(logger, { fetch }, {
            endpointUrl: 'http://localhost:11434',
            model: 'm',
            headers: [{ name: 'authorization', value: 'Bearer stale' }, { name: 'X-Extra', value: '1' }],
            auth: { type: 'bearer', token: 'fresh' },
        });
        await client.generate('hi', new AbortController().signal);
        const headers = fetch.mock.calls[0][1].headers;
        expect(headers).toMatchObject({ 'Authorization': 'Bearer fresh', 'X-Extra': '1' });
        expect(headers).not.toHaveProperty('authorization');
    });

    it('builds no authorization header without a method', () => {
        expect(buildAuthorization({ type: 'none' })).toBeNull();
        expect(buildAuthorization({})).toBeNull();
    });

    it('encodes basic auth credentials as UTF-8', () => {
        const expected = btoa(String.fromCharCode(...new TextEncoder().encode('jürgen:pässword')));
        expect(buildAuthorization({ type: 'basic', username: 'jürgen', password: 'pässword' })).toBe(`Basic ${expected}`);
    });
});
