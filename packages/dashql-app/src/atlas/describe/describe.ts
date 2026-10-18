import type { AICompletion, AIDescribeClient } from '../../platform/ai/ai_task_clients.js';
import type { TracedLogger } from '../../platform/logger/logger.js';
import { extractComments, type CommentBlock } from '../index/analysis/comments.js';
import type { AnalyzedSql } from '../index/analysis/core.js';
import { statementTexts } from '../index/analysis/statements.js';
import { sha256Hex, type SqlFile } from '../index/scan.js';
import { applyHeader, type Description } from './header.js';
import {
    DESCRIPTION_SCHEMA,
    DescribeSkipError,
    MAX_SQL_CHARS,
    SYSTEM_PROMPT,
    buildUserPrompt,
    parseDescription,
    type DescribeInput,
} from './prompt.js';

export const DESCRIBE_LOG_CTX = 'atlas_describe';

/// Scripts described at the same time. A request mostly waits for the model, more of them in flight make a run faster
/// until the endpoint throttles.
const DESCRIBE_CONCURRENCY = 12;

/// How much of a model response a log record shows
const LOGGED_RESPONSE_CHARS = 300;

/// A script without a description, ready to be sent to the model
export interface DescribeTarget {
    file: SqlFile;
    input: DescribeInput;
    /// The comment blocks of the script, the description goes next to them
    blocks: CommentBlock[];
}

/// Why a script of the folder is not sent to the model
export type DescribeExclusion = 'already described' | 'cannot be parsed' | 'has no statements';

export type DescribeOutcome =
    | { scriptName: string; status: 'described'; ms: number }
    | { scriptName: string; status: 'skipped'; reason: string; ms: number }
    | { scriptName: string; status: 'failed'; reason: string; ms: number };

/// What the describer gets to see: the statements of the script and nothing else.
/// The comment blocks are returned to find an existing description.
export function prepareDescribeInput(
    file: Pick<SqlFile, 'id'>,
    analyzed: AnalyzedSql,
): { input: DescribeInput; blocks: CommentBlock[] } {
    const sql = statementTexts(analyzed).map(statement => `${statement};`).join('\n\n');
    return { input: { scriptName: file.id, sql }, blocks: extractComments(analyzed) };
}

/// The scripts that can be described and have no description yet, `analyzed` holds the analysis of every file.
/// `onExcluded` learns why the other scripts are left out.
export function describeTargets(
    files: SqlFile[],
    analyzed: AnalyzedSql[],
    onExcluded?: (file: SqlFile, reason: DescribeExclusion) => void,
): DescribeTarget[] {
    const targets: DescribeTarget[] = [];
    analyzed.forEach((sql, i) => {
        if (!sql.parsed) {
            onExcluded?.(files[i], 'cannot be parsed');
            return;
        }
        const { input, blocks } = prepareDescribeInput(files[i], sql);
        if (blocks.some(b => b.source === 'dashql_description')) {
            onExcluded?.(files[i], 'already described');
        } else if (input.sql.length === 0) {
            onExcluded?.(files[i], 'has no statements');
        } else {
            targets.push({ file: files[i], input, blocks });
        }
    });
    return targets;
}

/// The JSON object in a model response. Models that ignore the response format wrap it in a code fence or in prose.
export function extractJson(text: string): string {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const body = fenced ? fenced[1] : trimmed;
    const begin = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (begin < 0 || end < begin) {
        throw new DescribeSkipError('the model response contains no JSON object');
    }
    return body.slice(begin, end + 1);
}

const excerpt = (text: string) => (text.length > LOGGED_RESPONSE_CHARS ? `${text.slice(0, LOGGED_RESPONSE_CHARS)}…` : text);

/// The timings and the token counts of a model response. Many completion tokens for a short description mean that the
/// model reasons before it answers.
function completionDetails(script: string, ms: number, modelMs: number, completion: AICompletion): Record<string, string | undefined> {
    return {
        script,
        ms: String(ms),
        model_ms: String(modelMs),
        response_chars: String(completion.content.length),
        prompt_tokens: completion.promptTokens?.toString(),
        completion_tokens: completion.completionTokens?.toString(),
        finish_reason: completion.finishReason ?? undefined,
    };
}

async function describeOne(
    target: DescribeTarget,
    client: AIDescribeClient,
    signal: AbortSignal,
    log: TracedLogger | undefined,
): Promise<DescribeOutcome> {
    const scriptName = target.file.id;
    const startedAt = performance.now();
    const ms = () => Math.round(performance.now() - startedAt);
    if (target.input.sql.length > MAX_SQL_CHARS) {
        const reason = `script is longer than ${MAX_SQL_CHARS} characters`;
        log?.warn('Skipped script', { script: scriptName, reason, sql_chars: String(target.input.sql.length) }, DESCRIBE_LOG_CTX);
        return { scriptName, status: 'skipped', reason, ms: 0 };
    }
    const userPrompt = buildUserPrompt(target.input);
    log?.info('Describing script', {
        script: scriptName,
        sql_chars: String(target.input.sql.length),
        prompt_chars: String(SYSTEM_PROMPT.length + userPrompt.length),
    }, DESCRIBE_LOG_CTX);
    let completion: AICompletion | null = null;
    let modelMs = 0;
    try {
        completion = await client.complete(
            [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            signal,
            { jsonSchema: { name: 'description', schema: DESCRIPTION_SCHEMA } },
        );
        modelMs = ms();
        log?.info('Received model response', completionDetails(scriptName, modelMs, modelMs, completion), DESCRIBE_LOG_CTX);
        if (completion.finishReason === 'length') {
            throw new DescribeSkipError('the model response was cut off');
        }
        let description: Description;
        try {
            description = parseDescription(extractJson(completion.content));
        } catch (e) {
            if (e instanceof SyntaxError) throw new DescribeSkipError(`the model response is not valid JSON: ${e.message}`);
            throw e;
        }
        // The file may have been edited while the model was writing, the comment offsets would be off
        const current = await (await target.file.handle.getFile()).text();
        if ((await sha256Hex(current)) !== target.file.hash) {
            throw new DescribeSkipError('the script changed while it was described');
        }
        const applied = applyHeader(current, target.blocks, description, false);
        const writeStart = performance.now();
        if (applied.action !== 'kept') {
            // The new contents replace the file when the stream is closed. Every script is written as soon as it is
            // described, a run can stop at any point without losing descriptions.
            const writable = await target.file.handle.createWritable();
            await writable.write(applied.text);
            await writable.close();
            // The scanned file follows, so that the folder knows the script is described without scanning it again
            target.file.text = applied.text;
            target.file.hash = await sha256Hex(applied.text);
        }
        log?.info('Described script', {
            ...completionDetails(scriptName, ms(), modelMs, completion),
            sql_chars: String(target.input.sql.length),
            questions: String(description.questions.length),
            header: applied.action,
            // Parsing the response and checking the file, then writing it
            check_ms: String(Math.round(writeStart - startedAt) - modelMs),
            write_ms: String(Math.round(performance.now() - writeStart)),
            file_chars: String(applied.text.length),
            summary: description.summary,
        }, DESCRIBE_LOG_CTX);
        return { scriptName, status: 'described', ms: ms() };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const details: Record<string, string | undefined> = { script: scriptName, ms: String(ms()) };
        if (completion != null) {
            Object.assign(details, completionDetails(scriptName, ms(), modelMs, completion));
            details.response = excerpt(completion.content);
        }
        if (e instanceof DescribeSkipError) {
            log?.warn('Skipped script', { ...details, reason }, DESCRIBE_LOG_CTX);
            return { scriptName, status: 'skipped', reason, ms: ms() };
        }
        if (signal.aborted) {
            log?.info('Cancelled script', details, DESCRIBE_LOG_CTX);
        } else {
            log?.error('Failed to describe script', { ...details, error: reason }, DESCRIBE_LOG_CTX);
        }
        return { scriptName, status: 'failed', reason, ms: ms() };
    }
}

/// Failures in a row after which a run stops. They are rarely about the script, more often the endpoint cannot be
/// reached or rejects the requests, and every other script would fail the same way.
const MAX_CONSECUTIVE_FAILURES = 3;

export interface DescribeRun {
    /// In the order of the targets, scripts that were not sent have none
    outcomes: DescribeOutcome[];
    /// The run stopped after too many failures in a row
    stopped: boolean;
}

/// Describe the scripts with the model and write the descriptions into them. A cancelled run stops sending scripts,
/// the descriptions that were written stay. Every script gets its own span in `log`.
export async function describeScripts(
    targets: DescribeTarget[],
    client: AIDescribeClient,
    signal: AbortSignal,
    onProgress?: (done: number, total: number, outcome: DescribeOutcome) => void,
    log?: TracedLogger,
): Promise<DescribeRun> {
    const outcomes: (DescribeOutcome | undefined)[] = new Array(targets.length);
    let next = 0;
    let done = 0;
    let failuresInARow = 0;
    const stopped = () => failuresInARow >= MAX_CONSECUTIVE_FAILURES;
    const workers = Math.max(1, Math.min(DESCRIBE_CONCURRENCY, targets.length));
    log?.info('Sending scripts to the model', { scripts: String(targets.length), concurrency: String(workers) }, DESCRIBE_LOG_CTX);
    const onAbort = () => {
        log?.info('Cancelling, waiting for the requests in flight', { done: String(done), in_flight: String(next - done) }, DESCRIBE_LOG_CTX);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const worker = async () => {
        while (next < targets.length && !signal.aborted && !stopped()) {
            const i = next++;
            if (next === targets.length && targets.length > 1) {
                log?.info('Sent the last script, waiting for the requests in flight', { done: String(done), in_flight: String(next - done) }, DESCRIBE_LOG_CTX);
            }
            const outcome = await describeOne(targets[i], client, signal, log?.childSpan());
            outcomes[i] = outcome;
            failuresInARow = outcome.status === 'failed' ? failuresInARow + 1 : 0;
            onProgress?.(++done, targets.length, outcome);
        }
    };
    try {
        await Promise.all(Array.from({ length: workers }, worker));
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
    if (stopped()) {
        log?.error('Stopped describing after failures in a row', { failures: String(failuresInARow) }, DESCRIBE_LOG_CTX);
    }
    return {
        // Requests that were aborted midway failed, they were not described either
        outcomes: outcomes.filter((o): o is DescribeOutcome => o != null && !(signal.aborted && o.status === 'failed')),
        stopped: stopped(),
    };
}
