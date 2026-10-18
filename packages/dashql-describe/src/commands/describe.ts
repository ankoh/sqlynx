import { writeFile, rename } from 'node:fs/promises';
import { extractComments, type CommentBlock } from '../analysis/comments.js';
import type { AnalyzedSql, SqlAnalyzer } from '../analysis/core.js';
import { statementTexts } from '../analysis/statements.js';
import { DescribeSkipError, type DescribeInput, type Describer } from '../describe/describe.js';
import { applyHeader, renderHeader, detectEol, type HeaderAction } from '../describe/header.js';
import type { SqlFile } from '../inputs.js';

export interface DescribeOptions {
    force: boolean;
    dryRun: boolean;
    skipCommented: boolean;
    concurrency: number;
    log: (message: string) => void;
}

export type DescribeOutcome =
    | { scriptName: string; status: 'described'; action: HeaderAction; header: string }
    | { scriptName: string; status: 'skipped'; reason: string }
    | { scriptName: string; status: 'failed'; reason: string };

/// What the describer gets to see: the statements of the script and nothing else.
/// The comment blocks are returned to find an existing description.
export function prepareDescribeInput(
    file: Pick<SqlFile, 'id'>,
    analyzed: AnalyzedSql,
): { input: DescribeInput; blocks: CommentBlock[] } {
    const sql = statementTexts(analyzed).map(statement => `${statement};`).join('\n\n');
    return { input: { scriptName: file.id, sql }, blocks: extractComments(analyzed) };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
    return results;
}

async function writeAtomic(path: string, text: string): Promise<void> {
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
}

/// Generate descriptions and write them as header comments into the scripts
export async function describeFiles(
    files: SqlFile[],
    analyzer: SqlAnalyzer,
    describer: Describer,
    options: DescribeOptions,
): Promise<DescribeOutcome[]> {
    const analyzed = analyzer.analyze(files.map(f => ({ id: f.id, text: f.text })));
    return mapConcurrent(files.map((file, i) => ({ file, sql: analyzed[i] })), options.concurrency, async ({ file, sql }) => {
        const outcome = await describeOne(file, sql, describer, options);
        if (outcome.status === 'failed') options.log(`warning: ${file.id}: ${outcome.reason}`);
        return outcome;
    });
}

async function describeOne(
    file: SqlFile,
    sql: AnalyzedSql,
    describer: Describer,
    options: DescribeOptions,
): Promise<DescribeOutcome> {
    if (!sql.parsed) {
        return { scriptName: file.id, status: 'skipped', reason: 'script could not be parsed' };
    }
    const { input, blocks } = prepareDescribeInput(file, sql);
    if (blocks.some(b => b.source === 'dashql_description') && !options.force) {
        return { scriptName: file.id, status: 'skipped', reason: 'already has a description' };
    }
    if (options.skipCommented && blocks.some(b => b.source === 'comment')) {
        return { scriptName: file.id, status: 'skipped', reason: 'already has comments' };
    }
    if (input.sql.length === 0) {
        return { scriptName: file.id, status: 'skipped', reason: 'script has no statements' };
    }
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
        };
    } catch (error) {
        if (error instanceof DescribeSkipError) {
            return { scriptName: file.id, status: 'skipped', reason: error.message };
        }
        return { scriptName: file.id, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}
