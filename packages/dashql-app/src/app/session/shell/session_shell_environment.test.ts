// @vitest-environment node
import * as arrow from 'apache-arrow';

import { QueryExecutor } from '../connections/query_executor.js';
import {
    createSessionShellEnvironment,
} from './session_shell_environment.js';
import {
    createShellOutputCommand,
    estimateTerminalTableWidth,
    SHELL_AUTO_OVERLAY_ROW_LIMIT,
    type ShellOutputMode,
} from '../../../shell/shell_result.js';

describe('session shell environment', () => {
    it('renders small auto-mode results in the terminal', async () => {
        const progress = vi.fn();
        const execute = vi.fn<QueryExecutor>((connectionId, args) => {
            expect(connectionId).toBe('connection-7');
            expect(args.query).toBe('SELECT 42');
            expect(args.analyzeResults).toBe(true);
            expect(args.cacheable).toBe(false);
            expect(args.throwOnError).toBe(true);
            args.onLog?.('Executing query');
            return [7, Promise.resolve(arrow.tableFromArrays({ value: [42] }))];
        });
        const cancel = vi.fn();
        const environment = createSessionShellEnvironment('session', 'connection-7', execute, cancel);

        const result = vi.fn();
        const bytes = await environment.executeQuery('SELECT 42', undefined, progress, result);
        expect(arrow.tableFromIPC(bytes).getChild('value')?.get(0)).toBe(42);
        expect(progress).toHaveBeenCalledWith('Executing query');
        expect(result).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
    });

    it('forwards labeled timings from the query executor', async () => {
        const execute = vi.fn<QueryExecutor>((_connectionId, args) => {
            args.onTiming?.('Results', 12.5);
            return [7, Promise.resolve(arrow.tableFromArrays({ value: [42] }))];
        });
        const environment = createSessionShellEnvironment('session', 'connection-7', execute, vi.fn());
        const onTiming = vi.fn();

        await environment.executeQuery('SELECT 42', undefined, undefined, undefined, onTiming);

        expect(onTiming).toHaveBeenCalledWith('Results', 12.5);
        expect(onTiming).toHaveBeenCalledWith('Postprocess', expect.any(Number));
    });

    it('opens auto-mode results in the overlay above the row limit', async () => {
        const rowCount = SHELL_AUTO_OVERLAY_ROW_LIMIT + 1;
        const execute = vi.fn<QueryExecutor>(() => [7, Promise.resolve(arrow.tableFromArrays({
            value: Array.from({ length: rowCount }, (_, index) => index),
        }))]);
        const environment = createSessionShellEnvironment('session', 'session-1', execute, vi.fn());
        const result = vi.fn();

        const bytes = await environment.executeQuery('SELECT value', undefined, undefined, result);

        expect(arrow.tableFromIPC(bytes).numCols).toBe(0);
        expect(result).toHaveBeenCalledWith(7, rowCount);
    });

    it('opens auto-mode results in the overlay when their natural width exceeds the terminal', async () => {
        let terminalColumns = 20;
        const table = arrow.tableFromArrays({
            identifier: [1],
            description: ['a result value that does not fit'],
        });
        const execute = vi.fn<QueryExecutor>(() => [7, Promise.resolve(table)]);
        const environment = createSessionShellEnvironment(
            'session',
            'session-1',
            execute,
            vi.fn(),
            () => 'auto',
            () => terminalColumns,
        );
        const result = vi.fn();

        expect(estimateTerminalTableWidth(table)).toBeGreaterThan(terminalColumns);
        expect(arrow.tableFromIPC(await environment.executeQuery('SELECT wide', undefined, undefined, result)).numCols).toBe(0);
        expect(result).toHaveBeenCalledWith(7, 1);

        terminalColumns = estimateTerminalTableWidth(table);
        result.mockClear();
        expect(arrow.tableFromIPC(await environment.executeQuery('SELECT wide', undefined, undefined, result)).numCols).toBe(2);
        expect(result).not.toHaveBeenCalled();
    });

    it('opens a 1x1 plan candidate in auto mode even when it fits in the terminal', async () => {
        const plan = '{"operator":"executiontarget","operatorId":1}';
        const execute = vi.fn<QueryExecutor>(() => [7, Promise.resolve(arrow.tableFromArrays({ value: [plan] }))]);
        const environment = createSessionShellEnvironment('session', 'session-1', execute, vi.fn(), () => 'auto', () => 1000);
        const result = vi.fn();

        const bytes = await environment.executeQuery('SELECT plan', undefined, undefined, result);

        expect(arrow.tableFromIPC(bytes).numCols).toBe(0);
        expect(result).toHaveBeenCalledWith(7, 1);
    });

    it('honors forced UI, terminal, and off output modes', async () => {
        let mode: ShellOutputMode = 'ui';
        const execute = vi.fn<QueryExecutor>(() => [7, Promise.resolve(arrow.tableFromArrays({ value: [42] }))]);
        const environment = createSessionShellEnvironment('session', 'session-1', execute, vi.fn(), () => mode);
        const result = vi.fn();

        expect(arrow.tableFromIPC(await environment.executeQuery('SELECT 42', undefined, undefined, result)).numCols).toBe(0);
        expect(result).toHaveBeenCalledWith(7, 1);

        mode = 'term';
        result.mockClear();
        expect(arrow.tableFromIPC(await environment.executeQuery('SELECT 42', undefined, undefined, result))
            .getChild('value')?.get(0)).toBe(42);
        expect(result).not.toHaveBeenCalled();

        mode = 'off';
        expect(arrow.tableFromIPC(await environment.executeQuery('SELECT 42', undefined, undefined, result)).numCols).toBe(0);
        expect(result).not.toHaveBeenCalled();
    });

    it('does not open a result UI for successful statements without columns', async () => {
        const execute = vi.fn<QueryExecutor>(() => [7, Promise.resolve(arrow.tableFromArrays({}))]);
        const environment = createSessionShellEnvironment('session', 'session-1', execute, vi.fn(), () => 'ui');
        const result = vi.fn();

        const bytes = await environment.executeQuery('CREATE TABLE foo(a INT)', undefined, undefined, result);

        expect(arrow.tableFromIPC(bytes).numCols).toBe(0);
        expect(result).not.toHaveBeenCalled();
    });

    it('configures and reports the query output mode', async () => {
        let mode: ShellOutputMode = 'auto';
        const command = createShellOutputCommand(() => mode, next => { mode = next; });

        expect(await command[2]([], {})).toBe(
            `Query output: auto (UI when results exceed ${SHELL_AUTO_OVERLAY_ROW_LIMIT} rows or terminal width)`,
        );
        expect(await command[2](['ui'], {})).toBe('Query output: ui');
        expect(mode).toBe('ui');
        expect(await command[2](['term'], {})).toBe('Query output: term');
        expect(await command[2](['off'], {})).toBe('Query output: off');
        expect(() => command[2](['invalid'], {})).toThrow('usage: .output [auto|ui|term|off]');
    });

    it('propagates aborts to the connection query executor', async () => {
        let resolveExecution: ((table: arrow.Table | null) => void) | null = null;
        const execute = vi.fn<QueryExecutor>(() => [9, new Promise(resolve => {
            resolveExecution = resolve;
        })]);
        const cancel = vi.fn();
        const environment = createSessionShellEnvironment('session', 'connection-7', execute, cancel);
        const abort = new AbortController();
        const execution = environment.executeQuery('SELECT 42', abort.signal);

        abort.abort();
        expect(cancel).toHaveBeenCalledWith('connection-7', 9);
        resolveExecution!(arrow.tableFromArrays({ value: [42] }));
        await execution;
    });
});
