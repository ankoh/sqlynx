import { describe, expect, it } from 'vitest';

import type { AIChatMessage, AICompletion, AICompletionOptions, AIDescribeClient } from '../../platform/ai/ai_task_clients.js';
import { scanSqlFiles, sha256Hex, type SqlFile } from '../index/scan.js';
import { tpchAnalyzer } from '../index/test_fixture.js';
import { TestLogger } from '../../platform/logger/test_logger.js';
import { createTrace } from '../../platform/logger/trace_context.js';
import { DESCRIBE_LOG_CTX, describeScripts, describeTargets, extractJson } from './describe.js';
import { DESCRIPTION_SCHEMA, SYSTEM_PROMPT } from './prompt.js';

const ANSWER = JSON.stringify({ summary: 'Revenue per market segment.', questions: ['Which segment earns most?', 'Revenue by segment'] });

/// A client that records the prompts and answers every script the same way
class FakeClient implements AIDescribeClient {
    readonly model = 'fake';
    requests: { messages: AIChatMessage[]; options?: AICompletionOptions }[] = [];
    constructor(private readonly answer: (sql: string) => Promise<string> = async () => ANSWER) {}
    async complete(messages: AIChatMessage[], signal: AbortSignal, options?: AICompletionOptions): Promise<AICompletion> {
        this.requests.push({ messages, options });
        signal.throwIfAborted();
        const content = await this.answer(messages[1].content);
        return { content, promptTokens: null, completionTokens: null, finishReason: 'stop' };
    }
}

async function withFolder(files: Record<string, string>, run: (directory: FileSystemDirectoryHandle) => Promise<void>) {
    const root = await navigator.storage.getDirectory();
    const name = `dashql-atlas-describe-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    try {
        for (const [file, text] of Object.entries(files)) {
            const writable = await (await directory.getFileHandle(file, { create: true })).createWritable();
            await writable.write(text);
            await writable.close();
        }
        await run(directory);
    } finally {
        await root.removeEntry(name, { recursive: true });
    }
}

async function targetsOf(files: SqlFile[]) {
    const analyzer = await tpchAnalyzer();
    return describeTargets(files, analyzer.analyze(files.map(f => ({ id: f.id, text: f.text }))));
}

const read = async (directory: FileSystemDirectoryHandle, name: string) => (await (await directory.getFileHandle(name)).getFile()).text();

describe('extractJson', () => {
    it('takes the object out of a code fence or prose', () => {
        expect(extractJson('{"a":1}')).toBe('{"a":1}');
        expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
        expect(extractJson('Here you go:\n{"a":{"b":2}}\nHope that helps')).toBe('{"a":{"b":2}}');
    });

    it('rejects a response without an object', () => {
        expect(() => extractJson('I cannot do that')).toThrow(/no JSON object/);
    });
});

describe('describeScripts', () => {
    it('describes only the scripts without a description and writes the blocks into them', async () => {
        const described = '-- @dashql:description\n-- Already there.\n-- @dashql:end\nselect 2;\n';
        await withFolder({ 'a.sql': '-- note\nselect 1;\n', 'b.sql': described, 'c.sql': '-- only a comment\n' }, async directory => {
            const files = await scanSqlFiles(directory);
            const targets = await targetsOf(files);
            expect(targets.map(t => t.file.id)).toEqual(['a.sql']);

            const client = new FakeClient();
            const run = await describeScripts(targets, client, new AbortController().signal);
            expect(run.stopped).toBe(false);
            expect(run.outcomes).toMatchObject([{ scriptName: 'a.sql', status: 'described' }]);
            // The model gets the statements and asks for the description schema
            expect(client.requests[0].messages).toEqual([
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: 'select 1;' },
            ]);
            expect(client.requests[0].options).toEqual({ jsonSchema: { name: 'description', schema: DESCRIPTION_SCHEMA } });

            const text = await read(directory, 'a.sql');
            expect(text.startsWith('-- @dashql:description\n-- Revenue per market segment.\n')).toBe(true);
            expect(text.endsWith('-- @dashql:end\n\n-- note\nselect 1;\n')).toBe(true);
            expect(await read(directory, 'b.sql')).toBe(described);
            // The scanned file follows the written one, described scripts are no targets anymore
            expect(files[0].text).toBe(text);
            expect(files[0].hash).toBe(await sha256Hex(text));
            expect(await targetsOf(files)).toEqual([]);
            expect(await targetsOf(await scanSqlFiles(directory))).toEqual([]);
        });
    });

    it('accepts a fenced answer and skips an answer that does not fit the schema', async () => {
        await withFolder({ 'a.sql': 'select 1;', 'b.sql': 'select 2;' }, async directory => {
            const client = new FakeClient(async sql => sql === 'select 1;' ? `\`\`\`json\n${ANSWER}\n\`\`\`` : '{"summary": "x"}');
            const run = await describeScripts(await targetsOf(await scanSqlFiles(directory)), client, new AbortController().signal);
            expect(run.outcomes.map(o => o.status)).toEqual(['described', 'skipped']);
            expect(await read(directory, 'b.sql')).toBe('select 2;');
        });
    });

    it('skips a script that changed while it was described', async () => {
        await withFolder({ 'a.sql': 'select 1;' }, async directory => {
            const targets = await targetsOf(await scanSqlFiles(directory));
            const client = new FakeClient(async () => {
                const writable = await (await directory.getFileHandle('a.sql')).createWritable();
                await writable.write('select 42;');
                await writable.close();
                return ANSWER;
            });
            const run = await describeScripts(targets, client, new AbortController().signal);
            expect(run.outcomes).toMatchObject([{ scriptName: 'a.sql', status: 'skipped', reason: 'the script changed while it was described' }]);
            expect(await read(directory, 'a.sql')).toBe('select 42;');
        });
    });

    it('stops sending scripts when cancelled', async () => {
        const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}.sql`, `select ${i};`]));
        await withFolder(files, async directory => {
            const abort = new AbortController();
            const client = new FakeClient(async () => {
                abort.abort();
                return ANSWER;
            });
            const run = await describeScripts(await targetsOf(await scanSqlFiles(directory)), client, abort.signal);
            // The requests that were already running finish, no new ones are sent
            expect(client.requests.length).toBeLessThan(10);
            expect(run.outcomes.length).toBe(client.requests.length);
            expect(run.outcomes.every(o => o.status === 'described')).toBe(true);
        });
    });

    it('logs every script in its own span below the run', async () => {
        await withFolder({ 'a.sql': 'select 1;', 'b.sql': 'select 2;' }, async directory => {
            const logger = new TestLogger();
            const run = logger.withTrace(createTrace());
            const client = new FakeClient(async sql => sql === 'select 1;' ? ANSWER : 'no json here');
            await describeScripts(await targetsOf(await scanSqlFiles(directory)), client, new AbortController().signal, undefined, run);
            const records = logger.buffer.collectTraceLogs(run.context.traceId).filter(r => r.target === DESCRIBE_LOG_CTX);
            const described = records.find(r => r.message === 'Described script')!;
            expect(described.keyValues).toMatchObject({ script: 'a.sql', summary: 'Revenue per market segment.', questions: '2', finish_reason: 'stop' });
            const skipped = records.find(r => r.message === 'Skipped script')!;
            expect(skipped.keyValues).toMatchObject({ script: 'b.sql', response: 'no json here' });
            // One span per script, both below the span of the run
            expect(described.tracing!.parentSpanId).toBe(run.context.spanId);
            expect(skipped.tracing!.parentSpanId).toBe(run.context.spanId);
            expect(described.tracing!.spanId).not.toBe(skipped.tracing!.spanId);
        });
    });

    it('skips a response that was cut off', async () => {
        await withFolder({ 'a.sql': 'select 1;' }, async directory => {
            const client = new FakeClient();
            client.complete = async () => ({ content: '{"summary": "Reve', promptTokens: 10, completionTokens: 600, finishReason: 'length' });
            const run = await describeScripts(await targetsOf(await scanSqlFiles(directory)), client, new AbortController().signal);
            expect(run.outcomes).toMatchObject([{ status: 'skipped', reason: 'the model response was cut off' }]);
        });
    });

    it('stops after failures in a row', async () => {
        const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}.sql`, `select ${i};`]));
        await withFolder(files, async directory => {
            const client = new FakeClient(async () => {
                throw new Error('HTTP 401 Unauthorized');
            });
            const run = await describeScripts(await targetsOf(await scanSqlFiles(directory)), client, new AbortController().signal);
            expect(run.stopped).toBe(true);
            // The requests in flight when the run stops still fail, no further ones are sent
            expect(client.requests.length).toBeLessThan(40);
            expect(run.outcomes.every(o => o.status === 'failed' && o.reason === 'HTTP 401 Unauthorized')).toBe(true);
        });
    });
});
