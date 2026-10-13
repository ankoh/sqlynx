import * as core from '@ankoh/dashql-core';
import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import type { CancelQuery, QueryExecutor } from '../connections/query_executor.js';
import { runNotebookExecution, type NotebookExecutionState } from './notebook_execution.js';
import { REGISTER_QUERY, REGISTER_SCRIPT_RESULT, type NotebookScripts } from './notebook_scripts.js';
import type { ModifyNotebookScripts } from './notebook_scripts_registry.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture(entries = [
    { file: '10_last.sql', outputs: [true] },
    { file: '2_commands.sql', outputs: [false, true, false] },
    { file: '1_empty.sql', outputs: [] as boolean[] },
]) {
    const preparation: string[] = [];
    let catalogRevision = 0n;
    const sessions = entries.map((entry, index) => ({
        version: 1n,
        getCatalogEntryId: () => index + 100,
        getTextVersion() { return this.version; },
        getCatalogRevision: () => catalogRevision,
        analyze: vi.fn(() => {
            preparation.push(`analyze:${entry.file}`);
            return { status: core.buffers.editor.EditorUpdateStatus.OK, analysisAvailable: true, statusMessage: null };
        }),
        loadIntoCatalog: vi.fn((rank: number) => {
            preparation.push(`load:${entry.file}:${rank}`);
            catalogRevision++;
        }),
        startExecution: vi.fn(() => { throw new Error('Must not start core script execution'); }),
    }));
    const ordered = entries.map((entry, index) => ({ ...entry, index }))
        .sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
    const graph = {
        valid: true,
        scripts: [] as Array<{ scriptId: number; textVersion: bigint; analyzedTextVersion: bigint; analyzedCatalogRevision: bigint }>,
        nodes: ordered.flatMap((entry, script) => entry.outputs.map((producesOutput, statementId) => ({
            script, statementId, producesOutput, sql: `${entry.file}:${statementId + 1}`,
        }))),
        edges: [] as Array<{ from: number; to: number }>,
        diagnostics: [] as Array<{ message: string }>,
    };
    const unpackAndDestroy = vi.fn(() => graph as unknown as core.buffers.execution.ExecutionGraphT);
    const plan = vi.fn((input: core.DashQLScriptSession[]) => {
        graph.scripts = input.map(session => ({
            scriptId: session.getCatalogEntryId(), textVersion: session.getTextVersion(),
            analyzedTextVersion: session.getTextVersion(), analyzedCatalogRevision: session.getCatalogRevision(),
        }));
        return { unpackAndDestroy };
    });
    const notebook = {
        notebookId: 'notebook', databaseId: 'connection', instance: { plan }, connectionCatalog: {},
        scriptRefs: Object.fromEntries(entries.map((entry, index) => [entry.file, { scriptId: index + 100 }])),
        scripts: Object.fromEntries(entries.map((entry, index) => [index + 100, {
            scriptKey: index + 100, fileName: entry.file, scriptSession: sessions[index], latestQueryId: 50 + index,
            latestResultQueryId: 50 + index,
        }])),
    } as unknown as NotebookScripts;
    let nextQueryId = 0;
    const executeQuery = vi.fn<QueryExecutor>(() => [++nextQueryId, Promise.resolve(null)]);
    const cancelQuery = vi.fn<CancelQuery>(async () => {});
    const modifyNotebookScripts = vi.fn<ModifyNotebookScripts>(action => {
        if (action.type === REGISTER_QUERY) notebook.scripts[action.value[0]].latestQueryId = action.value[1];
        if (action.type === REGISTER_SCRIPT_RESULT) notebook.scripts[action.value[0]].latestResultQueryId = action.value[1];
    });
    const getNotebook = vi.fn((): NotebookScripts | null => notebook);
    const controller = new AbortController();
    const states: NotebookExecutionState[] = [];
    const onState = vi.fn((state: NotebookExecutionState) => { states.push(state); });
    const args = { notebook, getNotebook, executeQuery, cancelQuery, modifyNotebookScripts,
        signal: controller.signal, onState };
    const lastState = () => states[states.length - 1];
    return { args, notebook, sessions, graph, plan, unpackAndDestroy, preparation,
        executeQuery, cancelQuery, modifyNotebookScripts, getNotebook, controller, states, onState, lastState };
}

describe('runNotebookExecution', () => {
    it('prepares synchronously and executes natural committed order, including empty scripts', async () => {
        const f = fixture();
        const run = runNotebookExecution(f.args);
        expect(f.preparation).toEqual([
            'analyze:1_empty.sql', 'load:1_empty.sql:102',
            'analyze:2_commands.sql', 'load:2_commands.sql:101',
            'analyze:10_last.sql', 'load:10_last.sql:100',
            'analyze:1_empty.sql', 'analyze:2_commands.sql', 'analyze:10_last.sql',
        ]);
        expect(f.plan).toHaveBeenCalledWith([f.sessions[2], f.sessions[1], f.sessions[0]]);
        await run;
        expect(f.executeQuery.mock.calls.map(([connection, args]) => [connection, args.query])).toEqual([
            ['connection', '2_commands.sql:1'], ['connection', '2_commands.sql:2'],
            ['connection', '2_commands.sql:3'], ['connection', '10_last.sql:1'],
        ]);
        expect(f.lastState()).toEqual({
            phase: 'succeeded', totalScripts: 3, completedScripts: 3,
            totalStatements: 4, completedStatements: 4,
            activeScriptKey: null, activeFileName: null,
            activeStatementIndex: null, activeStatementCount: null, error: null,
        });
        expect(f.states.some(state => state.completedScripts === 1 && state.completedStatements === 0)).toBe(true);
        expect(f.states.filter(state => state.activeScriptKey === 101).map(state => state.activeStatementIndex))
            .toEqual(expect.arrayContaining([1, 2, 3]));
        expect(f.unpackAndDestroy).toHaveBeenCalledOnce();
        f.sessions.forEach(session => expect(session.startExecution).not.toHaveBeenCalled());
    });

    it('waits for execution to settle before launching another statement', async () => {
        const f = fixture();
        const first = deferred<null>();
        const started = deferred<void>();
        f.executeQuery.mockImplementationOnce(() => { started.resolve(); return [1, first.promise]; });
        const run = runNotebookExecution(f.args);
        await started.promise;
        expect(f.executeQuery).toHaveBeenCalledTimes(1);
        expect(f.lastState()?.completedStatements).toBe(0);
        first.resolve(null);
        await run;
        expect(f.executeQuery).toHaveBeenCalledTimes(4);
    });

    it.each(['invalid', 'text', 'analysis', 'catalog', 'membership', 'session', 'connection', 'missing', 'order', 'edge'])
        ('rejects %s plans before backend execution', async kind => {
            const f = fixture();
            if (kind === 'invalid') {
                f.graph.valid = false;
                f.graph.diagnostics.push({ message: 'Invalid SQL' });
            }
            f.onState.mockImplementation(state => {
                f.states.push(state);
                if (state.phase !== 'running') return;
                switch (kind) {
                    case 'text': f.sessions[2].version++; break;
                    case 'analysis': f.graph.scripts[0].analyzedTextVersion = 0n; break;
                    case 'catalog': f.graph.scripts[0].analyzedCatalogRevision = 0n; break;
                    case 'membership': delete f.notebook.scriptRefs['1_empty.sql']; break;
                    case 'session': f.notebook.scripts[102].scriptSession = f.notebook.scripts[101].scriptSession; break;
                    case 'connection': f.getNotebook.mockReturnValue({ ...f.notebook, databaseId: 'other' }); break;
                    case 'missing': f.getNotebook.mockReturnValue(null); break;
                    case 'order': f.graph.nodes.reverse(); break;
                    case 'edge': f.graph.edges.push({ from: 3, to: 0 }); break;
                }
            });
            await runNotebookExecution(f.args);
            expect(f.executeQuery).not.toHaveBeenCalled();
            expect(f.lastState()?.phase).toBe('failed');
            expect(f.lastState()?.error).toBeTruthy();
            expect(f.unpackAndDestroy).toHaveBeenCalledOnce();
        });

    it('checks editor update status before publishing', async () => {
        const f = fixture();
        f.sessions[2].analyze.mockReturnValue({ status: -1 as core.buffers.editor.EditorUpdateStatus,
            analysisAvailable: true, statusMessage: null });
        await runNotebookExecution(f.args);
        expect(f.sessions[2].loadIntoCatalog).not.toHaveBeenCalled();
        expect(f.plan).not.toHaveBeenCalled();
        expect(f.executeQuery).not.toHaveBeenCalled();
        expect(f.lastState()?.phase).toBe('failed');
    });

    it('fails fast while retaining the failing query and earlier successful work', async () => {
        const f = fixture();
        f.executeQuery.mockImplementationOnce(() => [1, Promise.resolve(null)])
            .mockImplementationOnce(() => [2, Promise.reject(new Error('Backend failure'))]);
        await expect(runNotebookExecution(f.args)).resolves.toBeUndefined();
        expect(f.executeQuery).toHaveBeenCalledTimes(2);
        expect(f.notebook.scripts[101].latestQueryId).toBe(2);
        expect(f.lastState()).toMatchObject({ phase: 'failed', error: 'Backend failure',
            completedScripts: 1, completedStatements: 1, activeStatementIndex: 2 });
    });

    it('accepts null results for command-only scripts', async () => {
        const f = fixture([{ file: '1_commands.sql', outputs: [false, false] }]);
        await runNotebookExecution(f.args);
        expect(f.executeQuery.mock.calls.every(([, args]) => args.analyzeResults === false)).toBe(true);
        expect(f.lastState()).toMatchObject({ phase: 'succeeded', completedScripts: 1, completedStatements: 2 });
        expect(f.notebook.scripts[100].latestResultQueryId).toBe(50);
        f.graph.nodes[0].producesOutput = true;
        await runNotebookExecution(f.args);
        expect(f.executeQuery.mock.calls[2][1].replaceComputationId).toBe(50);
        expect(f.modifyNotebookScripts.mock.calls.some(([action]) => action.type === REGISTER_SCRIPT_RESULT)).toBe(false);
    });

    it('analyzes only the last output and restores it after successful trailing commands', async () => {
        const f = fixture([{ file: '1_output.sql', outputs: [true, false, true, false] }]);
        f.executeQuery.mockImplementation(() => [f.executeQuery.mock.calls.length, Promise.resolve(tableFromArrays({ value: [1] }))]);
        await runNotebookExecution(f.args);
        expect(f.executeQuery.mock.calls.map(([, args]) => args.analyzeResults)).toEqual([false, false, true, false]);
        expect(f.executeQuery.mock.calls[2][1].replaceComputationId).toBe(50);
        for (const [, args] of f.executeQuery.mock.calls) {
            expect(args).toMatchObject({ cacheable: false, throwOnError: true, abortSignal: f.controller.signal });
            expect(args.scriptExecution).toBeUndefined();
        }
        expect(f.modifyNotebookScripts.mock.calls.filter(([action]) => action.type === REGISTER_QUERY).map(([action]) => action.value)).toEqual([
            [100, 1], [100, 2], [100, 3], [100, 4], [100, 3],
        ]);
        expect(f.notebook.scripts[100].latestQueryId).toBe(3);
        expect(f.notebook.scripts[100].latestResultQueryId).toBe(3);
        expect(f.modifyNotebookScripts).toHaveBeenCalledWith({ type: REGISTER_SCRIPT_RESULT, value: [100, 3] });
    });

    it.each([undefined, null, 42])('captures retained result id %s before registering command ids', async latestResultQueryId => {
        const f = fixture([{ file: '1_output.sql', outputs: [false, true] }]);
        f.notebook.scripts[100].latestResultQueryId = latestResultQueryId;
        await runNotebookExecution(f.args);
        expect(f.executeQuery.mock.calls[1][1].replaceComputationId)
            .toBe(latestResultQueryId === undefined ? 50 : latestResultQueryId);
        expect(f.modifyNotebookScripts.mock.calls.some(([action]) => action.type === REGISTER_SCRIPT_RESULT)).toBe(false);
    });

    it('retains output cleanup identity after a trailing command fails and reuses it on the next run', async () => {
        const f = fixture([{ file: '1_output.sql', outputs: [true, false] }]);
        f.executeQuery.mockImplementationOnce(() => [1, Promise.resolve(tableFromArrays({ value: [1] }))])
            .mockImplementationOnce(() => [2, Promise.reject(new Error('Command failed'))]);
        await runNotebookExecution(f.args);
        expect(f.notebook.scripts[100].latestQueryId).toBe(2);
        expect(f.modifyNotebookScripts.mock.calls.filter(([action]) => action.type === REGISTER_QUERY)).toHaveLength(2);
        expect(f.lastState()?.phase).toBe('failed');
        expect(f.notebook.scripts[100].latestResultQueryId).toBe(1);
        expect(f.modifyNotebookScripts).toHaveBeenCalledWith({ type: REGISTER_SCRIPT_RESULT, value: [100, 1] });
        await runNotebookExecution(f.args);
        expect(f.executeQuery.mock.calls[2][1].replaceComputationId).toBe(1);
        expect(f.notebook.scripts[100].latestResultQueryId).toBe(1);
    });

    it('retains output cleanup identity when a later output fails', async () => {
        const f = fixture([{ file: '1_output.sql', outputs: [true] }]);
        f.executeQuery.mockImplementationOnce(() => [1, Promise.resolve(tableFromArrays({ value: [1] }))])
            .mockImplementationOnce(() => [2, Promise.reject(new Error('Output failed'))]);
        await runNotebookExecution(f.args);
        await runNotebookExecution(f.args);
        expect(f.notebook.scripts[100].latestQueryId).toBe(2);
        expect(f.notebook.scripts[100].latestResultQueryId).toBe(1);
        await runNotebookExecution(f.args);
        expect(f.executeQuery.mock.calls[2][1].replaceComputationId).toBe(1);
    });

    it('uses captured SQL after execution starts, even when live text changes', async () => {
        const f = fixture();
        f.executeQuery.mockImplementationOnce(() => {
            f.sessions[1].version++;
            return [1, Promise.resolve(null)];
        });
        await runNotebookExecution(f.args);
        expect(f.executeQuery.mock.calls[1][1].query).toBe('2_commands.sql:2');
        expect(f.lastState()?.phase).toBe('succeeded');
    });

    it('stops queued SQL when a notebook script is removed during execution', async () => {
        const f = fixture();
        f.executeQuery.mockImplementationOnce(() => {
            delete f.notebook.scriptRefs['10_last.sql'];
            return [1, Promise.resolve(null)];
        });
        await runNotebookExecution(f.args);
        expect(f.executeQuery).toHaveBeenCalledTimes(1);
        expect(f.lastState()?.phase).toBe('failed');
        expect(f.lastState()?.error).toContain('Notebook changed');
    });

    it.each(['execution', 'cancellation'])('drains both promises when %s settles first on abort', async first => {
        const f = fixture();
        const execution = deferred<null>();
        const cancellation = deferred<void>();
        const started = deferred<void>();
        f.executeQuery.mockImplementationOnce(() => { started.resolve(); return [42, execution.promise]; });
        f.cancelQuery.mockReturnValue(cancellation.promise);
        const run = runNotebookExecution(f.args);
        await started.promise;
        f.controller.abort();
        expect(f.cancelQuery).toHaveBeenCalledExactlyOnceWith('connection', 42);
        expect(f.lastState()?.phase).toBe('stopping');
        if (first === 'execution') {
            execution.resolve(null);
            await execution.promise;
        } else {
            cancellation.resolve();
            await cancellation.promise;
        }
        expect(f.lastState()?.phase).toBe('stopping');
        expect(f.executeQuery).toHaveBeenCalledTimes(1);
        execution.resolve(null);
        cancellation.resolve();
        await run;
        expect(f.lastState()).toMatchObject({ phase: 'cancelled', error: null, completedStatements: 0 });
        expect(f.executeQuery).toHaveBeenCalledTimes(1);
    });

    it('handles cancellation rejection immediately while execution remains pending', async () => {
        const f = fixture();
        const execution = deferred<null>();
        const started = deferred<void>();
        f.executeQuery.mockImplementationOnce(() => { started.resolve(); return [42, execution.promise]; });
        f.cancelQuery.mockRejectedValue(new Error('Cancel failed'));
        const run = runNotebookExecution(f.args);
        await started.promise;
        f.controller.abort();
        await f.cancelQuery.mock.results[0].value.catch(() => {});
        expect(f.lastState()?.phase).toBe('stopping');
        execution.reject(new Error('Aborted'));
        await expect(run).resolves.toBeUndefined();
        expect(f.lastState()?.phase).toBe('cancelled');
    });

    it('waits for analysis synchronization and catches synchronous executor errors', async () => {
        const f = fixture();
        const registration = deferred<NotebookScripts | null>();
        f.modifyNotebookScripts.mockReturnValueOnce(registration.promise);
        const run = runNotebookExecution(f.args);
        await Promise.resolve();
        expect(f.executeQuery).not.toHaveBeenCalled();
        registration.resolve(f.notebook);
        await run;
        expect(f.lastState()?.phase).toBe('succeeded');

        const failed = fixture();
        failed.executeQuery.mockImplementation(() => { throw new Error('Cannot launch'); });
        await expect(runNotebookExecution(failed.args)).resolves.toBeUndefined();
        expect(failed.lastState()).toMatchObject({ phase: 'failed', error: 'Cannot launch' });
        expect(failed.executeQuery).toHaveBeenCalledTimes(1);
    });

    it('handles synchronous cancellation errors without launching queued work', async () => {
        const f = fixture();
        f.cancelQuery.mockImplementation(() => { throw new Error('Cannot cancel'); });
        f.modifyNotebookScripts.mockImplementation(action => { if (action.type === REGISTER_QUERY) f.controller.abort(); });
        await expect(runNotebookExecution(f.args)).resolves.toBeUndefined();
        expect(f.executeQuery).toHaveBeenCalledTimes(1);
        expect(f.cancelQuery).toHaveBeenCalledTimes(1);
        expect(f.lastState()?.phase).toBe('cancelled');
    });

    it('launches nothing when already aborted and removes its abort listener after finishing', async () => {
        const f = fixture();
        f.controller.abort();
        await runNotebookExecution(f.args);
        expect(f.plan).not.toHaveBeenCalled();
        expect(f.executeQuery).not.toHaveBeenCalled();
        expect(f.lastState()?.phase).toBe('cancelled');
        const completed = fixture();
        await runNotebookExecution(completed.args);
        const count = completed.states.length;
        completed.controller.abort();
        expect(completed.states).toHaveLength(count);
        expect(completed.cancelQuery).not.toHaveBeenCalled();
    });

    it('succeeds on an empty notebook', async () => {
        const f = fixture([]);
        await runNotebookExecution(f.args);
        expect(f.lastState()).toMatchObject({ phase: 'succeeded', totalScripts: 0, totalStatements: 0 });
        expect(f.executeQuery).not.toHaveBeenCalled();
    });
});
