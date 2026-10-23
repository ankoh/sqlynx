// @vitest-environment node
import * as arrow from 'apache-arrow';

import { QueryExecutionStatus } from '../query/query_execution_state.js';
import { createEmbeddedDatabaseShellEnvironment } from './embedded_database_shell_environment.js';
import { ShellQueryExecutionTracker } from '../shell/query_execution.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

describe('embedded database shell environment', () => {
    it('executes against the provided connection', async () => {
        const result = arrow.tableToIPC(arrow.tableFromArrays({ value: [42] }), 'file');
        const queryArrowIPC = vi.fn().mockResolvedValue(result);
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any);

        await expect(environment.executeQuery('SELECT 42')).resolves.toBe(result);
        expect(queryArrowIPC).toHaveBeenCalledWith('SELECT 42', expect.any(AbortSignal));
    });

    it('executes repeated queries against the database instead of caching results', async () => {
        const first = arrow.tableToIPC(arrow.tableFromArrays({ value: [1] }), 'file');
        const second = arrow.tableToIPC(arrow.tableFromArrays({ value: [2] }), 'file');
        const queryArrowIPC = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second);
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any);

        const firstResult = await environment.executeQuery('SELECT value');
        const secondResult = await environment.executeQuery('SELECT value');

        expect(queryArrowIPC).toHaveBeenCalledTimes(2);
        expect(arrow.tableFromIPC(firstResult).getChild('value')?.get(0)).toBe(1);
        expect(arrow.tableFromIPC(secondResult).getChild('value')?.get(0)).toBe(2);
    });

    it('reports progress while the database query is running', async () => {
        const result = arrow.tableToIPC(arrow.tableFromArrays({ value: [42] }), 'file');
        const queryArrowIPC = vi.fn().mockResolvedValue(result);
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any);
        const onProgress = vi.fn();

        await environment.executeQuery('SELECT 42', undefined, onProgress);

        expect(onProgress).toHaveBeenCalledWith('Executing query');
    });

    it('passes Arrow IPC streams through to the shell renderer', async () => {
        const stream = arrow.tableToIPC(arrow.tableFromArrays({ value: [42] }), 'stream');
        const queryArrowIPC = vi.fn().mockResolvedValue(stream);
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any);

        const result = await environment.executeQuery('SELECT 42');

        expect(result).toBe(stream);
    });

    it('normalizes successful queries without result chunks', async () => {
        const queryArrowIPC = vi.fn().mockResolvedValue(new Uint8Array());
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any);

        const result = await environment.executeQuery('CREATE TABLE foo(a INT)');

        expect(arrow.tableFromIPC(result).numCols).toBe(0);
        expect(queryArrowIPC).toHaveBeenCalledWith('CREATE TABLE foo(a INT)', expect.any(AbortSignal));
    });

    it('prepares and opens results in UI mode', async () => {
        const table = arrow.tableFromArrays({ value: [42] });
        const queryArrowIPC = vi.fn().mockResolvedValue(arrow.tableToIPC(table, 'file'));
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { queryArrowIPC } as any,
            undefined,
            {
                getOutputMode: () => 'ui',
                prepareResult,
            },
        );
        const onResult = vi.fn();

        const result = await environment.executeQuery('SELECT 42', undefined, undefined, onResult);

        expect(arrow.tableFromIPC(result).numCols).toBe(0);
        expect(prepareResult).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ numRows: 1 }));
        expect(onResult).toHaveBeenCalledWith(expect.any(Number), 1);
    });

    it('opens the UI result only after aggregate preparation completes', async () => {
        const table = arrow.tableFromArrays({ value: [42] });
        const preparation = deferred<void>();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { queryArrowIPC: vi.fn().mockResolvedValue(arrow.tableToIPC(table, 'file')) } as any,
            undefined,
            { getOutputMode: () => 'ui', prepareResult: () => preparation.promise },
        );
        const onResult = vi.fn();
        const execution = environment.executeQuery('SELECT 42', undefined, undefined, onResult);

        await Promise.resolve();
        expect(onResult).not.toHaveBeenCalled();
        preparation.resolve();
        await execution;
        expect(onResult).toHaveBeenCalledWith(expect.any(Number), 1);
    });

    it('reports UI result analysis as postprocessing', async () => {
        const table = arrow.tableFromArrays({ value: [42] });
        const events: string[] = [];
        const queryArrowIPC = vi.fn().mockResolvedValue(arrow.tableToIPC(table, 'file'));
        const environment = createEmbeddedDatabaseShellEnvironment(
            { queryArrowIPC } as any,
            undefined,
            {
                getOutputMode: () => 'ui',
                prepareResult: () => { events.push('prepare'); },
            },
        );

        await environment.executeQuery(
            'SELECT 42',
            undefined,
            undefined,
            vi.fn(),
            (label, elapsedMs) => {
                expect(elapsedMs).toBeGreaterThanOrEqual(0);
                events.push(label);
            },
        );

        expect(events).toEqual(['Results', 'prepare', 'Postprocess']);
    });

    it('omits postprocessing when results stay in the terminal', async () => {
        const table = arrow.tableFromArrays({ value: [42] });
        const queryArrowIPC = vi.fn().mockResolvedValue(arrow.tableToIPC(table, 'file'));
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { queryArrowIPC } as any,
            undefined,
            {
                getOutputMode: () => 'term',
                prepareResult,
            },
        );
        const timings: string[] = [];

        await environment.executeQuery(
            'SELECT 42',
            undefined,
            undefined,
            undefined,
            label => { timings.push(label); },
        );

        expect(prepareResult).not.toHaveBeenCalled();
        expect(timings).toEqual(['Results', 'Postprocess']);
    });

    it('prepares and opens a 1x1 plan candidate in auto mode', async () => {
        const plan = '{"operator":"executiontarget","operatorId":1}';
        const table = arrow.tableFromArrays({ value: [plan] });
        const queryArrowIPC = vi.fn().mockResolvedValue(arrow.tableToIPC(table, 'file'));
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { queryArrowIPC } as any,
            undefined,
            {
                getOutputMode: () => 'auto',
                getTerminalColumns: () => 1000,
                prepareResult,
            },
        );
        const onResult = vi.fn();

        const result = await environment.executeQuery('SELECT plan', undefined, undefined, onResult);

        expect(arrow.tableFromIPC(result).numCols).toBe(0);
        expect(prepareResult).toHaveBeenCalledOnce();
        expect(onResult).toHaveBeenCalledWith(expect.any(Number), 1);
    });

    it('does not open a result UI for successful statements without columns', async () => {
        const queryArrowIPC = vi.fn().mockResolvedValue(new Uint8Array());
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { queryArrowIPC } as any,
            undefined,
            {
                getOutputMode: () => 'ui',
                prepareResult,
            },
        );
        const onResult = vi.fn();

        const result = await environment.executeQuery('CREATE TABLE foo(a INT)', undefined, undefined, onResult);

        expect(arrow.tableFromIPC(result).numCols).toBe(0);
        expect(prepareResult).not.toHaveBeenCalled();
        expect(onResult).not.toHaveBeenCalled();
    });

    it('suppresses query output in off mode', async () => {
        const table = arrow.tableFromArrays({ value: [42] });
        const queryArrowIPC = vi.fn().mockResolvedValue(arrow.tableToIPC(table, 'file'));
        const environment = createEmbeddedDatabaseShellEnvironment(
            { queryArrowIPC } as any,
            undefined,
            { getOutputMode: () => 'off' },
        );
        const onResult = vi.fn();

        const result = await environment.executeQuery('SELECT 42', undefined, undefined, onResult);

        expect(arrow.tableFromIPC(result).numCols).toBe(0);
        expect(queryArrowIPC).toHaveBeenCalledWith('SELECT 42', expect.any(AbortSignal));
        expect(onResult).not.toHaveBeenCalled();
    });

    it('rejects an already cancelled query before reaching the database', async () => {
        const queryArrowIPC = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any);
        const abort = new AbortController();
        abort.abort();

        await expect(environment.executeQuery('SELECT 42', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(queryArrowIPC).not.toHaveBeenCalled();
    });

    it('tracks successful queries with their row count', async () => {
        const result = arrow.tableToIPC(arrow.tableFromArrays({ value: [1, 2, 3] }), 'file');
        const queryArrowIPC = vi.fn().mockResolvedValue(result);
        const tracker = new ShellQueryExecutionTracker();
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any, tracker);

        await expect(environment.executeQuery('SELECT * FROM values')).resolves.toBe(result);

        expect(tracker.getSnapshot()).toMatchObject([{
            queryText: 'SELECT * FROM values',
            status: QueryExecutionStatus.SUCCEEDED,
            error: null,
        }]);
        expect(tracker.getSnapshot()[0].resultTable?.numRows).toBe(3);
        expect(tracker.getSnapshot()[0].metrics.querySucceededAt).toBeInstanceOf(Date);
        expect(tracker.getSnapshot()[0].metrics.queryDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks failed queries', async () => {
        const queryArrowIPC = vi.fn().mockRejectedValue(new Error('syntax error'));
        const tracker = new ShellQueryExecutionTracker();
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any, tracker);

        await expect(environment.executeQuery('SELEC 1')).rejects.toThrow('syntax error');

        expect(tracker.getSnapshot()).toMatchObject([{
            status: QueryExecutionStatus.FAILED,
            resultTable: null,
        }]);
        expect(tracker.getSnapshot()[0].error?.message).toBe('syntax error');
        expect(tracker.getSnapshot()[0].metrics.queryDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks cancelled queries', async () => {
        const queryArrowIPC = vi.fn();
        const tracker = new ShellQueryExecutionTracker();
        const environment = createEmbeddedDatabaseShellEnvironment({ queryArrowIPC } as any, tracker);
        const abort = new AbortController();
        abort.abort();

        await expect(environment.executeQuery('SELECT 42', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });

        expect(tracker.getSnapshot()).toMatchObject([{
            status: QueryExecutionStatus.CANCELLED,
            resultTable: null,
        }]);
        expect(tracker.getSnapshot()[0].metrics.queryDurationMs).toBeGreaterThanOrEqual(0);
        expect(queryArrowIPC).not.toHaveBeenCalled();
    });
});
