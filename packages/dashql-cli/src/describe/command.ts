import { writeFile, rename } from 'node:fs/promises';
import { extractComments, type CommentBlock } from './analysis/comments.js';
import type { AnalyzedSql, SqlAnalyzer } from './analysis/core.js';
import { statementTexts } from './analysis/statements.js';
import { DescribeSkipError, type DescribeInput, type Describer } from './describe.js';
import { applyHeader, renderHeader, detectEol, type HeaderAction } from './header.js';
import type { SqlFile } from '../inputs.js';

export interface DescribeOptions {
    force: boolean;
    dryRun: boolean;
    skipCommented: boolean;
    concurrency: number;
    /// Called once the scripts are analyzed, before the first one is sent
    onStart?: (start: { targets: number; skipped: number; workers: number; analyzeMs: number }) => void;
    /// Called for every script as soon as it is done, in the order the scripts finish
    onOutcome?: (outcome: DescribeOutcome) => void;
}

/// `ms` is the time with the describer, scripts that were not sent have none
export type DescribeOutcome =
    | { scriptName: string; status: 'described'; action: HeaderAction; header: string; ms: number }
    | { scriptName: string; status: 'skipped'; reason: string; ms?: number }
    | { scriptName: string; status: 'failed'; reason: string; ms: number };

export interface DescribeRun {
    /// Scripts that were not sent because the run stopped have none
    outcomes: DescribeOutcome[];
    /// The run stopped after too many failures in a row
    stopped: boolean;
}

/// Failures in a row after which a run stops. They are rarely about the script, more often the describer cannot reach
/// the model or is not logged in, and every other script would fail the same way.
const MAX_CONSECUTIVE_FAILURES = 3;

/// A script read from a file, the description is written back into it
export type DescribeFile = SqlFile & { path: string };

/// The scripts that can be described, stdin cannot be written back
export function describableFiles(files: SqlFile[]): DescribeFile[] {
    const stdin = files.find(f => f.path == null);
    if (stdin) throw new Error(`${stdin.id} cannot be described, the description is written into the file`);
    return files as DescribeFile[];
}

/// A script that goes to the describer
interface DescribeTarget {
    file: DescribeFile;
    input: DescribeInput;
    blocks: CommentBlock[];
}

/// What the describer gets to see: the statements of the script and nothing else.
/// The comment blocks are returned to find an existing description.
export function prepareDescribeInput(
    file: Pick<SqlFile, 'id'>,
    analyzed: AnalyzedSql,
): { input: DescribeInput; blocks: CommentBlock[] } {
    const sql = statementTexts(analyzed).map(statement => `${statement};`).join('\n\n');
    return { input: { scriptName: file.id, sql }, blocks: extractComments(analyzed) };
}

/// Why a script is not sent to the describer, null if it is
function exclusion(blocks: CommentBlock[], input: DescribeInput, options: DescribeOptions): string | null {
    if (blocks.some(b => b.source === 'dashql_description') && !options.force) return 'already has a description';
    if (options.skipCommented && blocks.some(b => b.source === 'comment')) return 'already has comments';
    if (input.sql.length === 0) return 'script has no statements';
    return null;
}

async function writeAtomic(path: string, text: string): Promise<void> {
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
}

/// Generate descriptions and write them as header comments into the scripts. Every script is written as soon as it is
/// described, a run can stop at any point without losing descriptions.
export async function describeFiles(
    files: DescribeFile[],
    analyzer: SqlAnalyzer,
    describer: Describer,
    options: DescribeOptions,
): Promise<DescribeRun> {
    const analyzeStart = performance.now();
    const analyzed = analyzer.analyze(files.map(f => ({ id: f.id, text: f.text })));
    const analyzeMs = Math.round(performance.now() - analyzeStart);
    const outcomes: (DescribeOutcome | undefined)[] = new Array(files.length);
    const report = (i: number, outcome: DescribeOutcome) => {
        outcomes[i] = outcome;
        options.onOutcome?.(outcome);
    };

    // Scripts that are left out are reported right away, they take no slot of a request
    const targets: { index: number; target: DescribeTarget }[] = [];
    files.forEach((file, i) => {
        if (!analyzed[i].parsed) {
            report(i, { scriptName: file.id, status: 'skipped', reason: 'script could not be parsed' });
            return;
        }
        const { input, blocks } = prepareDescribeInput(file, analyzed[i]);
        const reason = exclusion(blocks, input, options);
        if (reason != null) report(i, { scriptName: file.id, status: 'skipped', reason });
        else targets.push({ index: i, target: { file, input, blocks } });
    });

    // A request mostly waits for the model, the workers keep several of them in flight
    const workers = Math.max(1, Math.min(options.concurrency, targets.length));
    options.onStart?.({ targets: targets.length, skipped: files.length - targets.length, workers, analyzeMs });
    let next = 0;
    let failuresInARow = 0;
    const stopped = () => failuresInARow >= MAX_CONSECUTIVE_FAILURES;
    const worker = async () => {
        while (next < targets.length && !stopped()) {
            const { index, target } = targets[next++];
            const outcome = await describeOne(target, describer, options);
            failuresInARow = outcome.status === 'failed' ? failuresInARow + 1 : 0;
            report(index, outcome);
        }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    return { outcomes: outcomes.filter((o): o is DescribeOutcome => o != null), stopped: stopped() };
}

async function describeOne(target: DescribeTarget, describer: Describer, options: DescribeOptions): Promise<DescribeOutcome> {
    const { file, input, blocks } = target;
    const startedAt = performance.now();
    const ms = () => Math.round(performance.now() - startedAt);
    try {
        const description = await describer.describe(input);
        const applied = applyHeader(file.text, blocks, description, options.force);
        if (!options.dryRun && applied.action !== 'kept') {
            await writeAtomic(file.path, applied.text);
        }
        return {
            scriptName: file.id,
            status: 'described',
            action: applied.action,
            header: renderHeader(description, detectEol(file.text)),
            ms: ms(),
        };
    } catch (error) {
        if (error instanceof DescribeSkipError) {
            return { scriptName: file.id, status: 'skipped', reason: error.message, ms: ms() };
        }
        return { scriptName: file.id, status: 'failed', reason: error instanceof Error ? error.message : String(error), ms: ms() };
    }
}
