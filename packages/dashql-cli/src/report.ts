import type { Execution, ExecutionTimings } from './execute.js';
import { lineColumn, type Diagnostic } from './lint.js';

/// Applies a text style, e.g. `styleText` of node:util. Must not change the visible width.
export type Style = (format: 'bold' | 'dim' | 'red' | 'yellow' | 'green' | 'cyan', text: string) => string;
export const plain: Style = (_format, text) => text;

/// Everything that is reported about one script
export interface FileReport {
    file: string;
    text: string;
    diagnostics: Diagnostic[];
    /// The execution outcome, 'skipped' if linting found errors, absent if the script was only linted
    execution?: Execution | 'skipped';
}

const LABEL_WIDTH = 7; // "warning", "skipped"
const STAGE_WIDTH = 7; // "analyze", "execute", "failure"

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/// A duration in milliseconds, in seconds from one second on
export function duration(ms: number | null): string {
    if (ms === null) return '-';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/// Where the time of one script went
function timingRows(timings: ExecutionTimings): [string, string][] {
    const rows: [string, string][] = [['core', `analyze and compile ${duration(timings.core)}`]];
    timings.statements.forEach((statement, i) => {
        const hyper = statement.hyper;
        const parts = hyper
            ? ` (parse ${duration(hyper.parsing)}, compile ${duration(hyper.compilation)}, execute ${duration(hyper.execution)})`
            : '';
        rows.push(['hyper', `statement ${i + 1}: ${duration(statement.wall)}${parts}`]);
    });
    return rows;
}

/// The source line of a diagnostic with its span underlined
function codeFrame(lines: string[], bytes: Uint8Array, d: Diagnostic): [string, string] | null {
    if (d.line === undefined || d.column === undefined || d.offset === undefined) return null;
    // Columns count code points, tabs are shown as a single space to keep the caret aligned
    const line = Array.from((lines[d.line - 1] ?? '').replace(/\r$/, '').replace(/\t/g, ' '));
    const end = lineColumn(bytes, d.offset + (d.length ?? 0));
    const endColumn = end.line === d.line ? end.column : line.length + 1;
    const width = Math.max(1, endColumn - d.column);
    return [line.join(''), ' '.repeat(d.column - 1) + '^'.repeat(width)];
}

/// Format the report of one script, the file name followed by one indented line per finding.
/// `debug` adds where the time of the execution went.
export function formatFile(report: FileReport, style: Style = plain, debug = false): string {
    const lines = report.text.split('\n');
    const bytes = new TextEncoder().encode(report.text);
    const locations = report.diagnostics.map(d => (d.line === undefined ? '' : `${d.line}:${d.column}`));
    const locationWidth = Math.max(0, ...locations.map(l => l.length));
    const indent = ' '.repeat(2 + locationWidth + 2);
    const continuation = ' '.repeat(indent.length + LABEL_WIDTH + 2 + STAGE_WIDTH + 2);

    const out = [style('bold', report.file)];
    const row = (location: string, color: 'red' | 'yellow' | 'green' | 'dim', label: string, stage: string, message: string) => {
        const [first, ...rest] = message.split('\n');
        out.push(
            `  ${style('cyan', location.padEnd(locationWidth))}  ${style(color, label.padEnd(LABEL_WIDTH))}  ` +
                `${style('dim', stage.padEnd(STAGE_WIDTH))}  ${first}`,
        );
        for (const line of rest) out.push(continuation + line);
    };

    report.diagnostics.forEach((d, i) => {
        row(locations[i], d.severity === 'error' ? 'red' : 'yellow', d.severity, d.stage, d.message);
        const frame = codeFrame(lines, bytes, d);
        if (frame) {
            out.push(`${indent}${style('dim', '│')} ${frame[0]}`);
            out.push(`${indent}${style('dim', '│')} ${style(d.severity === 'error' ? 'red' : 'yellow', frame[1])}`);
        }
    });

    const execution = report.execution;
    if (execution === 'skipped') {
        row('', 'dim', 'skipped', 'execute', 'not executed due to errors');
    } else if (execution?.ok) {
        const result = execution.rows === undefined ? 'no result' : plural(execution.rows, 'row');
        row('', 'green', 'ok', 'execute', `${plural(execution.statements, 'statement')}, ${result}`);
    } else if (execution) {
        const where = execution.statement === undefined ? '' : `statement ${execution.statement}: `;
        const state = execution.sqlState ? ` ${style('dim', `[${execution.sqlState}]`)}` : '';
        row('', 'red', 'error', 'execute', `${where}${execution.message}${state}`);
        for (const extra of [execution.detail, execution.hint ? `hint: ${execution.hint}` : undefined]) {
            // Hyper starts the detail with a newline and points into the statement on its own
            for (const line of extra?.replace(/^\n+/, '').split('\n') ?? []) out.push(continuation + style('dim', line));
        }
    }
    if (debug && execution && execution !== 'skipped') {
        for (const [stage, message] of timingRows(execution.timings)) row('', 'dim', 'debug', stage, message);
    }
    return out.join('\n');
}

export interface Summary {
    files: number;
    errors: number;
    warnings: number;
    /// Absent if the scripts were only linted
    executed?: number;
}

export function formatSummary(summary: Summary, style: Style = plain): string {
    const parts = [
        plural(summary.files, 'file'),
        style(summary.errors > 0 ? 'red' : 'green', plural(summary.errors, 'error')),
        style(summary.warnings > 0 ? 'yellow' : 'green', plural(summary.warnings, 'warning')),
    ];
    if (summary.executed !== undefined) parts.push(`${summary.executed} executed`);
    return parts.join(', ');
}

/// Where the time of a whole run went, in milliseconds
export interface RunTimings {
    coreStartup: number;
    /// Absent if the scripts were only linted
    hyperStartup?: number;
    /// Scanning, parsing and analyzing all scripts, dashql-core does that in batches
    lint: number;
    /// Analysis and compilation before execution in dashql-core
    compile: number;
    /// Statements in Hyper, from the client and as reported by Hyper
    hyperWall: number;
    hyperParsing: number;
    hyperCompilation: number;
    hyperExecution: number;
    statements: number;
}

export function formatTimings(t: RunTimings, style: Style = plain): string {
    const lines = [
        ['startup', `dashql-core ${duration(t.coreStartup)}` + (t.hyperStartup === undefined ? '' : `, hyper ${duration(t.hyperStartup)}`)],
        ['dashql-core', `scan, parse and analyze ${duration(t.lint)}` + (t.hyperStartup === undefined ? '' : `, compile ${duration(t.compile)}`)],
    ];
    if (t.hyperStartup !== undefined) {
        lines.push([
            'hyper',
            `${plural(t.statements, 'statement')} ${duration(t.hyperWall)}: parse ${duration(t.hyperParsing)}, ` +
                `compile ${duration(t.hyperCompilation)}, execute ${duration(t.hyperExecution)}`,
        ]);
    }
    return lines.map(([label, text]) => `${style('dim', label.padEnd(11))}  ${text}`).join('\n');
}
