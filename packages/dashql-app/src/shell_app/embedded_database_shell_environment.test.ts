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
        const query = vi.fn().mockResolvedValue(arrow.tableFromArrays({ value: [42] }));
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any);

        const result = await environment.executeQuery('SELECT 42');
        expect(arrow.tableFromIPC(result).getChild('value')?.get(0)).toBe(42);
        expect(query).toHaveBeenCalledWith('SELECT 42', expect.any(AbortSignal));
    });

    it('executes repeated queries against the database instead of caching results', async () => {
        const first = arrow.tableFromArrays({ value: [1] });
        const second = arrow.tableFromArrays({ value: [2] });
        const query = vi.fn()
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second);
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any);

        const firstResult = await environment.executeQuery('SELECT value');
        const secondResult = await environment.executeQuery('SELECT value');

        expect(query).toHaveBeenCalledTimes(2);
        expect(arrow.tableFromIPC(firstResult).getChild('value')?.get(0)).toBe(1);
        expect(arrow.tableFromIPC(secondResult).getChild('value')?.get(0)).toBe(2);
    });

    it('reports progress while the database query is running', async () => {
        const query = vi.fn().mockResolvedValue(arrow.tableFromArrays({ value: [42] }));
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any);
        const onProgress = vi.fn();

        await environment.executeQuery('SELECT 42', undefined, onProgress);

        expect(onProgress).toHaveBeenCalledWith('Executing query');
    });

    it('passes results as Arrow IPC streams to the shell renderer', async () => {
        const query = vi.fn().mockResolvedValue(arrow.tableFromArrays({ value: [42] }));
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any);

        const result = await environment.executeQuery('SELECT 42');

        expect(arrow.RecordBatchReader.from(result).isStream()).toBe(true);
        expect(arrow.tableFromIPC(result).getChild('value')?.get(0)).toBe(42);
    });

    it('normalizes successful queries without result chunks', async () => {
        const query = vi.fn().mockResolvedValue(arrow.tableFromArrays({}));
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any);

        const result = await environment.executeQuery('CREATE TABLE foo(a INT)');

        expect(arrow.tableFromIPC(result).numCols).toBe(0);
        expect(query).toHaveBeenCalledWith('CREATE TABLE foo(a INT)', expect.any(AbortSignal));
    });

    it('prepares and opens results in UI mode', async () => {
        const table = arrow.tableFromArrays({ value: [42] });
        const query = vi.fn().mockResolvedValue(table);
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { query } as any,
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
            { query: vi.fn().mockResolvedValue(table) } as any,
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
        const query = vi.fn().mockResolvedValue(table);
        const environment = createEmbeddedDatabaseShellEnvironment(
            { query } as any,
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
        const query = vi.fn().mockResolvedValue(table);
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { query } as any,
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
        const query = vi.fn().mockResolvedValue(table);
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { query } as any,
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
        const query = vi.fn().mockResolvedValue(arrow.tableFromArrays({}));
        const prepareResult = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment(
            { query } as any,
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
        const query = vi.fn().mockResolvedValue(table);
        const environment = createEmbeddedDatabaseShellEnvironment(
            { query } as any,
            undefined,
            { getOutputMode: () => 'off' },
        );
        const onResult = vi.fn();

        const result = await environment.executeQuery('SELECT 42', undefined, undefined, onResult);

        expect(arrow.tableFromIPC(result).numCols).toBe(0);
        expect(query).toHaveBeenCalledWith('SELECT 42', expect.any(AbortSignal));
        expect(onResult).not.toHaveBeenCalled();
    });

    it('rejects an already cancelled query before reaching the database', async () => {
        const query = vi.fn();
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any);
        const abort = new AbortController();
        abort.abort();

        await expect(environment.executeQuery('SELECT 42', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(query).not.toHaveBeenCalled();
    });

    it('tracks successful queries with their row count', async () => {
        const query = vi.fn().mockResolvedValue(arrow.tableFromArrays({ value: [1, 2, 3] }));
        const tracker = new ShellQueryExecutionTracker();
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any, tracker);

        const result = await environment.executeQuery('SELECT * FROM values');
        expect(arrow.tableFromIPC(result).numRows).toBe(3);

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
        const query = vi.fn().mockRejectedValue(new Error('syntax error'));
        const tracker = new ShellQueryExecutionTracker();
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any, tracker);

        await expect(environment.executeQuery('SELEC 1')).rejects.toThrow('syntax error');

        expect(tracker.getSnapshot()).toMatchObject([{
            status: QueryExecutionStatus.FAILED,
            resultTable: null,
        }]);
        expect(tracker.getSnapshot()[0].error?.message).toBe('syntax error');
        expect(tracker.getSnapshot()[0].metrics.queryDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks cancelled queries', async () => {
        const query = vi.fn();
        const tracker = new ShellQueryExecutionTracker();
        const environment = createEmbeddedDatabaseShellEnvironment({ query } as any, tracker);
        const abort = new AbortController();
        abort.abort();

        await expect(environment.executeQuery('SELECT 42', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });

        expect(tracker.getSnapshot()).toMatchObject([{
            status: QueryExecutionStatus.CANCELLED,
            resultTable: null,
        }]);
        expect(tracker.getSnapshot()[0].metrics.queryDurationMs).toBeGreaterThanOrEqual(0);
        expect(query).not.toHaveBeenCalled();
    });
});
