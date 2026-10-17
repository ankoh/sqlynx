import type { Execution } from './execute.js';
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

/// Format the report of one script, the file name followed by one indented line per finding
export function formatFile(report: FileReport, style: Style = plain): string {
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
