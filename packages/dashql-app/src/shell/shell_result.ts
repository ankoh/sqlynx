import * as arrow from 'apache-arrow';

import type { DashQLShellCommand } from './api.js';
import { QueryType, type QueryMetadata } from '../query/query_execution_state.js';

export const SHELL_AUTO_OVERLAY_ROW_LIMIT = 100;
const TABLE_FRAME_WIDTH_PER_COLUMN = 3;

export type ShellOutputMode = 'auto' | 'ui' | 'term' | 'off';

/// The result of a query whose output the shell doesn't print
export const EMPTY_RESULT_IPC = arrow.tableToIPC(arrow.tableFromArrays({}), 'file');

/// The metadata of the queries that users enter in the shell
export const SHELL_QUERY_METADATA: QueryMetadata = {
    queryType: QueryType.USER_PROVIDED,
    title: 'Shell Query',
    description: null,
    issuer: 'DashQL Shell',
    userProvided: true,
};

/// Report a timing to an optional observer, observers must not interrupt the query execution
export function reportShellTiming(onTiming: ((label: string, elapsedMs: number) => void) | undefined, label: string, elapsedMs: number): void {
    try {
        onTiming?.(label, elapsedMs);
    } catch {
        // Timing observers must not interrupt query execution.
    }
}

export function getPlanResultText(table: arrow.Table | null): string | null {
    if (table == null || table.numRows !== 1 || table.numCols !== 1) return null;
    const value = table.getChildAt(0)?.get(0);
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.operator === 'string'
            ? value
            : null;
    } catch {
        return null;
    }
}

function textWidth(value: unknown): number {
    if (value == null) return 0;
    return String(value).split(/\r?\n/, -1).reduce((width, line) => Math.max(width, Array.from(line).length), 0);
}

export function estimateTerminalTableWidth(table: arrow.Table): number {
    if (table.numCols === 0) return 0;
    let width = TABLE_FRAME_WIDTH_PER_COLUMN * table.numCols + 1;
    for (let columnIndex = 0; columnIndex < table.numCols; ++columnIndex) {
        const column = table.getChildAt(columnIndex);
        let columnWidth = textWidth(table.schema.fields[columnIndex]?.name ?? '');
        if (column != null) {
            for (let rowIndex = 0; rowIndex < table.numRows; ++rowIndex) {
                columnWidth = Math.max(columnWidth, textWidth(column.get(rowIndex)));
            }
        }
        width += Math.max(columnWidth, 1);
    }
    return width;
}

export function shouldShowResultUI(mode: ShellOutputMode, table: arrow.Table, terminalColumns: number): boolean {
    return mode === 'ui'
        || (mode === 'auto' && (
            getPlanResultText(table) != null
            ||
            table.numRows > SHELL_AUTO_OVERLAY_ROW_LIMIT
            || estimateTerminalTableWidth(table) > Math.max(terminalColumns, 1)
        ));
}

export function createShellOutputCommand(
    getMode: () => ShellOutputMode,
    setMode: (mode: ShellOutputMode) => void,
): DashQLShellCommand {
    return [
        'output',
        'Set query output: auto, ui, term, or off',
        args => {
            if (args.length > 1 || (args.length === 1 && !['auto', 'ui', 'term', 'off'].includes(args[0]))) {
                throw new Error('usage: .output [auto|ui|term|off]');
            }
            if (args.length === 1) setMode(args[0] as ShellOutputMode);
            const mode = getMode();
            return mode === 'auto'
                ? `Query output: auto (UI when results exceed ${SHELL_AUTO_OVERLAY_ROW_LIMIT} rows or terminal width)`
                : `Query output: ${mode}`;
        },
    ];
}
