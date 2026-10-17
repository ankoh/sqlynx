import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from '../inputs.js';
import type { Description } from './header.js';

/// Bump when the prompt changes to invalidate cached descriptions
export const PROMPT_VERSION = 'v2';
export const DEFAULT_DESCRIBE_MODEL = 'claude-opus-5-5';

const MAX_SQL_CHARS = 60_000;
const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 6;

export interface DescribeInput {
    scriptName: string;
    /// The statements of the script without the comments around them
    sql: string;
}

export interface Describer {
    describe(input: DescribeInput): Promise<Description>;
}

/// A script that cannot be described. The run continues with the next script.
export class DescribeSkipError extends Error {}

export const SYSTEM_PROMPT = `You write short search descriptions for SQL scripts in an example library.
People will find these scripts later by typing a natural-language request, so describe what the script computes in the language of the business or data domain.

Write:
- "summary": one to three sentences about what the result answers, which entities it covers and which important conditions or groupings it applies. Do not narrate SQL syntax and do not repeat the script.
- "questions": three to five short questions or requests, phrased the way a person would ask for this result. Vary the wording and cover different aspects.

Base everything on the script and do not invent facts that it does not support.`;

export const DESCRIPTION_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        questions: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'questions'],
    additionalProperties: false,
};

/// The model gets the SQL and nothing else
export function buildUserPrompt(input: DescribeInput): string {
    return input.sql;
}

export function parseDescription(json: string): Description {
    const value = JSON.parse(json) as Partial<Description>;
    if (typeof value.summary !== 'string' || !Array.isArray(value.questions)) {
        throw new DescribeSkipError('model response does not match the description schema');
    }
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    const questions = value.questions.filter(q => typeof q === 'string').map(clean).filter(q => q.length > 0);
    const summary = clean(value.summary);
    if (summary.length === 0 || questions.length < MIN_QUESTIONS) {
        throw new DescribeSkipError('model response is missing a summary or questions');
    }
    return { summary, questions: questions.slice(0, MAX_QUESTIONS) };
}

/// Models that accept the server-side refusal fallback
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

export class ClaudeDescriber implements Describer {
    private readonly client: Anthropic;

    constructor(private readonly model: string = DEFAULT_DESCRIBE_MODEL, client?: Anthropic) {
        // Credentials resolve from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile)
        this.client = client ?? new Anthropic();
    }

    async describe(input: DescribeInput): Promise<Description> {
        if (input.sql.length > MAX_SQL_CHARS) {
            throw new DescribeSkipError(`script is longer than ${MAX_SQL_CHARS} characters`);
        }
        const useFallback = FALLBACK_MODELS.has(this.model);
        const response = await this.client.beta.messages.create({
            model: this.model,
            max_tokens: 2000,
            ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: buildUserPrompt(input) }],
            output_config: { effort: 'low', format: { type: 'json_schema', schema: DESCRIPTION_SCHEMA } },
        });
        if (response.stop_reason === 'refusal') {
            throw new DescribeSkipError(`the model declined to describe the script (${response.stop_details?.category ?? 'refusal'})`);
        }
        if (response.stop_reason === 'max_tokens') {
            throw new DescribeSkipError('the model response was cut off');
        }
        const text = response.content.find(block => block.type === 'text');
        if (!text || text.type !== 'text') {
            throw new DescribeSkipError('the model returned no text');
        }
        return parseDescription(text.text);
    }
}

/// Caches descriptions on disk, keyed by model, prompt version and script content
export class CachedDescriber implements Describer {
    constructor(
        private readonly inner: Describer,
        private readonly cacheDir: string,
        private readonly model: string,
    ) {}

    private path(input: DescribeInput): string {
        const key = sha256([this.model, PROMPT_VERSION, input.sql].join('\u0000'));
        return join(this.cacheDir, 'descriptions', `${key}.json`);
    }

    async describe(input: DescribeInput): Promise<Description> {
        const path = this.path(input);
        try {
            return parseDescription(await readFile(path, 'utf8'));
        } catch {
            // Cache miss or unreadable entry
        }
        const description = await this.inner.describe(input);
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(description));
        await rename(temp, path);
        return description;
    }
}
