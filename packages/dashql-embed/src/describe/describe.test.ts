import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { CachedDescriber, ClaudeDescriber, DescribeSkipError, buildUserPrompt, parseDescription } from './describe.js';

const input = { scriptName: 'a.sql', sql: 'select 1;' };

/// A client that records requests and answers with a canned message
function fakeClient(response: Record<string, unknown>) {
    const requests: any[] = [];
    const client = {
        beta: {
            messages: {
                create: async (request: any) => {
                    requests.push(request);
                    return response;
                },
            },
        },
    } as unknown as Anthropic;
    return { client, requests };
}

const ok = (payload: unknown) => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
});

const dirs: string[] = [];
afterAll(async () => {
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
});

describe('prompt and response parsing', () => {
    it('sends the SQL and nothing else', () => {
        expect(buildUserPrompt(input)).toBe('select 1;');
    });

    it('normalizes whitespace and rejects incomplete answers', () => {
        expect(parseDescription('{"summary":"  A   b ","questions":["Q1 ?"," Q2"]}')).toEqual({ summary: 'A b', questions: ['Q1 ?', 'Q2'] });
        expect(() => parseDescription('{"summary":"x","questions":["only one"]}')).toThrow(DescribeSkipError);
        expect(() => parseDescription('{"questions":[]}')).toThrow(DescribeSkipError);
    });
});

describe('ClaudeDescriber', () => {
    it('requests structured output with low effort and the refusal fallback', async () => {
        const { client, requests } = fakeClient(ok({ summary: 'Selects one.', questions: ['What is one?', 'Give me one'] }));
        const description = await new ClaudeDescriber('claude-opus-5-5', client).describe(input);
        expect(description.summary).toBe('Selects one.');
        const request = requests[0];
        expect(request.messages).toEqual([{ role: 'user', content: 'select 1;' }]);
        expect(request.model).toBe('claude-opus-5-5');
        expect(request.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
        expect(request.fallbacks).toBe('default');
        expect(request.betas).toEqual(['server-side-fallback-2026-07-01']);
        expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(request.thinking).toBeUndefined();
    });

    it('leaves out the fallback for models that do not accept it', async () => {
        const { client, requests } = fakeClient(ok({ summary: 'x', questions: ['a', 'b'] }));
        await new ClaudeDescriber('claude-haiku-5-5', client).describe(input);
        expect(requests[0].fallbacks).toBeUndefined();
        expect(requests[0].betas).toBeUndefined();
    });

    it('skips refused, truncated and oversized scripts', async () => {
        const refused = fakeClient({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
        await expect(new ClaudeDescriber('claude-opus-5-5', refused.client).describe(input)).rejects.toThrow(/declined.*cyber/);
        const cut = fakeClient({ stop_reason: 'max_tokens', content: [] });
        await expect(new ClaudeDescriber('claude-opus-5-5', cut.client).describe(input)).rejects.toThrow(/cut off/);
        const big = fakeClient(ok({}));
        await expect(new ClaudeDescriber('claude-opus-5-5', big.client).describe({ ...input, sql: 'x'.repeat(70_000) })).rejects.toThrow(DescribeSkipError);
        expect(big.requests).toHaveLength(0);
    });
});

describe('CachedDescriber', () => {
    it('calls the model once per script content and model', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'dashql-embed-cache-'));
        dirs.push(dir);
        let calls = 0;
        const inner = { describe: async () => (++calls, { summary: 'S', questions: ['a', 'b'] }) };
        const cached = new CachedDescriber(inner, dir, 'm1');
        await cached.describe(input);
        await cached.describe(input);
        expect(calls).toBe(1);
        await cached.describe({ ...input, sql: 'select 2' });
        expect(calls).toBe(2);
        await new CachedDescriber(inner, dir, 'm2').describe(input);
        expect(calls).toBe(3);
    });
});
