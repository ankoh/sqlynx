import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
    ClaudeCodeDescriber,
    ClaudeDescriber,
    DESCRIPTION_SCHEMA,
    DescribeSkipError,
    SYSTEM_PROMPT,
    buildUserPrompt,
    parseDescription,
    type CommandRunner,
} from './describe.js';

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

/// A runner that records invocations and prints a canned Claude Code result
function fakeRunner(result: Record<string, unknown>) {
    const calls: { command: string; args: string[]; input: string }[] = [];
    const run: CommandRunner = async (command, args, input) => {
        calls.push({ command, args, input });
        return JSON.stringify(result);
    };
    return { run, calls };
}

describe('ClaudeCodeDescriber', () => {
    const description = { summary: 'Counts nations.', questions: ['How many nations?', 'Count the nations'] };

    it('runs claude -p with the prompt, the schema and the SQL on stdin', async () => {
        const fake = fakeRunner({ type: 'result', subtype: 'success', is_error: false, structured_output: description });
        const result = await new ClaudeCodeDescriber('claude-sonnet-5-5', 'claude', fake.run).describe(input);
        expect(result).toEqual(description);
        expect(fake.calls).toHaveLength(1);
        const { command, args, input: stdin } = fake.calls[0];
        expect(command).toBe('claude');
        expect(stdin).toBe('select 1;');
        const option = (name: string) => args[args.indexOf(name) + 1];
        expect(args).toContain('--print');
        expect(option('--model')).toBe('claude-sonnet-5-5');
        expect(option('--tools')).toBe('');
        expect(option('--system-prompt')).toBe(SYSTEM_PROMPT);
        expect(JSON.parse(option('--json-schema'))).toEqual(DESCRIPTION_SCHEMA);
    });

    it('fails on errors reported by Claude Code', async () => {
        const fake = fakeRunner({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' });
        await expect(new ClaudeCodeDescriber('m', 'claude', fake.run).describe(input)).rejects.toThrow('Not logged in');
    });

    it('skips scripts without structured output', async () => {
        const fake = fakeRunner({ type: 'result', subtype: 'success', is_error: false, result: 'no' });
        await expect(new ClaudeCodeDescriber('m', 'claude', fake.run).describe(input)).rejects.toThrow(DescribeSkipError);
    });
});
