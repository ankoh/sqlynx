import type { Description } from './header.js';

// A copy of this file lives in packages/dashql-cli/src/describe/prompt.ts, keep them in sync

export const MAX_SQL_CHARS = 60_000;
const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 6;

export interface DescribeInput {
    scriptName: string;
    /// The statements of the script without the comments around them
    sql: string;
}

/// A script that cannot be described. The run continues with the next script.
export class DescribeSkipError extends Error {}

export const SYSTEM_PROMPT = `You write short search descriptions for SQL scripts in an example library.
People will find these scripts later by typing a natural-language request, so describe what the script computes in the language of the business or data domain.

Write:
- "summary": one to three sentences about what the result answers, which entities it covers and which important conditions or groupings it applies. Do not narrate SQL syntax and do not repeat the script.
- "questions": three to five short questions or requests, phrased the way a person would ask for this result. Vary the wording and cover different aspects.

Keep the summary and the questions together well below 512 tokens, the search embeds only the first 512 tokens of a description.
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
