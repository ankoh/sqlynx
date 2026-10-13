import * as React from 'react';
import * as core from '@ankoh/dashql-core';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComputationRegistry } from '../../../compute/computation_registry.js';
import { ComputeConnectionProvider } from '../../../compute/compute_connection_provider.js';
import { EmbeddedDatabaseProvider } from '../../../platform/database/embedded_database_provider.js';
import type { EmbeddedComputeDatabase } from '../../../platform/database/embedded_database.js';
import { LoggerProvider } from '../../../platform/logger/logger_provider.js';
import { createQueryResponseStreamMetrics, QueryExecutionStatus, type QueryExecutionResponseStream } from '../../../query/query_execution_state.js';
import { AttachedDatabaseRegistry, useAttachedDatabaseRegistry } from '../connections/attached_database_registry.js';
import { ConnectionHealth, createConnectionMetrics, type AttachedDatabaseState } from '../connections/attached_database_state.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR } from '../connections/connector_info.js';
import { QueryExecutorProvider } from '../connections/query_executor.js';
import { NotebookTestBackend } from '../persistence/notebook_test_backend.js';
import { StorageProvider } from '../persistence/storage_provider.js';
import { NotebookExecutionProvider, notebookExecutionIsBusy, useNotebookExecution } from './notebook_execution_provider.js';
import { isNotebookExecutionRunning, type NotebookExecutionState } from './notebook_execution.js';
import { REGISTER_QUERY, type NotebookScripts } from './notebook_scripts.js';
import { NotebookScriptsRegistryProvider, useNotebookScriptsRegistry, type ModifyNotebookScripts } from './notebook_scripts_registry.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}

function fixture(notebookId: string, deferStream = false) {
    const acquisition = deferred();
    if (!deferStream) acquisition.resolve();
    const execution = deferred();
    const cancellation = deferred();
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    const stream: QueryExecutionResponseStream = {
        cancel: vi.fn(() => cancellation.promise),
        getMetadata: () => new Map(),
        getMetrics: createQueryResponseStreamMetrics,
        getStatus: () => QueryExecutionStatus.RUNNING,
        getSchema: async () => null,
        produce: vi.fn<QueryExecutionResponseStream['produce']>(async (_batches, _progress, abort) => {
            signal = abort;
            abort?.addEventListener('abort', aborted, { once: true });
            await execution.promise;
            abort?.removeEventListener('abort', aborted);
            abort?.throwIfAborted();
        }),
    };
    const executeQuery = vi.fn(async (_query: unknown, abort?: AbortSignal) => {
        signal = abort;
        await acquisition.promise;
        return stream;
    });
    const session = {
        analyze: vi.fn(() => ({ status: core.buffers.editor.EditorUpdateStatus.OK, analysisAvailable: true })),
        loadIntoCatalog: vi.fn(),
        getCatalogEntryId: () => 1,
        getTextVersion: () => 1n,
        getCatalogRevision: () => 1n,
    };
    const plan = vi.fn(() => ({ unpackAndDestroy: () => ({
        valid: true,
        scripts: [{ scriptId: 1, textVersion: 1n, analyzedTextVersion: 1n, analyzedCatalogRevision: 1n }],
        // Command-only nodes avoid exercising result computation in provider lifecycle tests.
        nodes: [0, 1].map(statementId => ({ script: 0, statementId, producesOutput: false, sql: `command ${statementId}` })),
        edges: [], diagnostics: [],
    }) }));
    const notebook = {
        notebookId, databaseId: `${notebookId}-database`, instance: { plan }, connectionCatalog: {},
        scriptRefs: { '1_commands.sql': { scriptId: 1, fileName: '1_commands.sql' } },
        scripts: { 1: { scriptKey: 1, fileName: '1_commands.sql', scriptSession: session, latestQueryId: null } },
    } as unknown as NotebookScripts;
    const database = {
        databaseId: notebook.databaseId, active: false,
        connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
        connectionSignature: { signatureString: notebook.databaseId },
        connectionHealth: ConnectionHealth.ONLINE, metrics: createConnectionMetrics(),
        details: { type: HYPER_CONNECTOR, value: { proto: {}, channel: { executeQuery } } },
        queriesActive: new Map(), queriesActiveOrdered: [],
        queriesFinished: new Map(), queriesFinishedOrdered: [], snapshotQueriesActiveFinished: 0,
    } as unknown as AttachedDatabaseState;
    const modify = vi.fn<ModifyNotebookScripts>(action => {
        if (action.type === REGISTER_QUERY) notebook.scripts[action.value[0]].latestQueryId = action.value[1];
    });
    return { notebook, database, plan, stream, executeQuery, modify, acquisition, execution, cancellation, aborted,
        get signal() { return signal; } };
}

type Fixture = ReturnType<typeof fixture>;
type Execution = ReturnType<typeof useNotebookExecution>;

function Consumer(props: { notebookId: string; capture: (execution: Execution) => void }) {
    const execution = useNotebookExecution(props.notebookId);
    React.useLayoutEffect(() => props.capture(execution));
    return null;
}

function SeedRegistries(props: { fixtures: Fixture[]; children: React.ReactNode }) {
    const [, setNotebooks] = useNotebookScriptsRegistry();
    const [, setConnections] = useAttachedDatabaseRegistry();
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
        setNotebooks(registry => ({ ...registry,
            notebookScriptsMap: new Map(props.fixtures.map(f => [f.notebook.notebookId, f.notebook])),
        }));
        setConnections(registry => ({ ...registry,
            attachedDatabases: new Map(props.fixtures.map(f => [f.database.databaseId, f.database])),
            attachedDatabasesByNotebook: new Map(props.fixtures.map(f => [f.notebook.notebookId, {
                mainDatabaseId: f.database.databaseId, attachedDatabaseIds: [],
            }])),
        }));
        setReady(true);
    }, [props.fixtures, setNotebooks, setConnections]);
    return ready ? props.children : null;
}

describe('NotebookExecutionProvider', () => {
    let container: HTMLDivElement;
    let root: Root;
    let fixtures: Fixture[];
    let current: Execution;
    let observer: Execution;
    let backend: NotebookTestBackend;
    let setupDatabase: () => Promise<EmbeddedComputeDatabase>;
    const capture = (execution: Execution) => { current = execution; };
    const captureObserver = (execution: Execution) => { observer = execution; };

    beforeEach(() => {
        fixtures = [fixture('first'), fixture('second')];
        backend = new NotebookTestBackend();
        setupDatabase = async () => ({ terminate: vi.fn() }) as unknown as EmbeddedComputeDatabase;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        act(() => root.unmount());
        await act(async () => {
            fixtures.forEach(f => { f.acquisition.resolve(); f.execution.resolve(); f.cancellation.resolve(); });
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        container.remove();
    });

    async function render(notebookId = 'first', showConsumer = true, showProvider = true) {
        await act(async () => {
            root.render(<LoggerProvider>
                <StorageProvider backend={backend}>
                    <AttachedDatabaseRegistry>
                        <NotebookScriptsRegistryProvider>
                            <EmbeddedDatabaseProvider setupDatabase={setupDatabase}>
                                <ComputeConnectionProvider>
                                    <ComputationRegistry>
                                        <SeedRegistries fixtures={fixtures}>
                                            <QueryExecutorProvider>
                                                {showProvider ? <NotebookExecutionProvider>
                                                    {showConsumer ? <Consumer key={notebookId} notebookId={notebookId} capture={capture} /> : null}
                                                    <Consumer notebookId="first" capture={captureObserver} />
                                                </NotebookExecutionProvider> : <></>}
                                            </QueryExecutorProvider>
                                        </SeedRegistries>
                                    </ComputationRegistry>
                                </ComputeConnectionProvider>
                            </EmbeddedDatabaseProvider>
                        </NotebookScriptsRegistryProvider>
                    </AttachedDatabaseRegistry>
                </StorageProvider>
            </LoggerProvider>);
            await new Promise(resolve => setTimeout(resolve, 0));
        });
    }

    async function start(f = fixtures[0]) {
        act(() => current.start(f.modify));
        await vi.waitFor(() => expect(f.stream.produce).toHaveBeenCalledTimes(1));
        expect(current.busy).toBe(true);
        expect(current.state?.phase).toBe('running');
    }

    it('prevents duplicate starts synchronously and after consumers rerender', async () => {
        await render();
        act(() => { current.start(fixtures[0].modify); current.start(fixtures[0].modify); });
        await vi.waitFor(() => expect(fixtures[0].stream.produce).toHaveBeenCalledTimes(1));
        act(() => current.start(fixtures[0].modify));
        expect(fixtures[0].plan).toHaveBeenCalledTimes(1);
        expect(fixtures[0].executeQuery).toHaveBeenCalledTimes(1);
        expect(fixtures[0].modify.mock.calls.filter(([action]) => action.type === REGISTER_QUERY)).toHaveLength(1);
    });

    it.each(['execution', 'cancellation'] as const)('keeps stopping busy until both promises drain, with %s settling first', async first => {
        await render();
        await start();
        const f = fixtures[0];
        act(() => { current.stop(); current.stop(); });
        expect(f.signal?.aborted).toBe(true);
        expect(f.stream.cancel).toHaveBeenCalledTimes(1);
        expect(current.state?.phase).toBe('stopping');
        expect(current.busy).toBe(true);

        await act(async () => {
            f[first].resolve();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(current.state?.phase).toBe('stopping');
        expect(current.busy).toBe(true);
        act(() => current.start(f.modify));
        expect(f.plan).toHaveBeenCalledTimes(1);
        expect(f.executeQuery).toHaveBeenCalledTimes(1);

        await act(async () => {
            f.execution.resolve(); f.cancellation.resolve();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        await vi.waitFor(() => expect(current.state?.phase).toBe('cancelled'));
        expect(current.busy).toBe(false);
        expect(f.executeQuery).toHaveBeenCalledTimes(1);
        expect(isNotebookExecutionRunning(f.notebook)).toBe(false);

        act(() => current.start(f.modify));
        await vi.waitFor(() => expect(current.state?.phase).toBe('succeeded'));
        expect(f.plan).toHaveBeenCalledTimes(2);
        expect(f.executeQuery).toHaveBeenCalledTimes(3);
    });

    it('cancels a stream acquired after stop without consuming it or starting queued statements', async () => {
        const f = fixtures[0] = fixture('first', true);
        await render();
        act(() => current.start(f.modify));
        await vi.waitFor(() => expect(f.executeQuery).toHaveBeenCalledTimes(1));
        expect(f.stream.produce).not.toHaveBeenCalled();
        expect(current.busy).toBe(true);

        act(() => current.stop());
        expect(f.signal?.aborted).toBe(true);
        expect(current.state?.phase).toBe('stopping');
        expect(f.stream.cancel).not.toHaveBeenCalled();

        await act(async () => {
            f.acquisition.resolve();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        await vi.waitFor(() => expect(f.stream.cancel).toHaveBeenCalledTimes(1));
        expect(f.stream.produce).not.toHaveBeenCalled();
        expect(current.state?.phase).toBe('stopping');
        expect(current.busy).toBe(true);
        act(() => current.start(f.modify));
        expect(f.plan).toHaveBeenCalledTimes(1);
        expect(f.executeQuery).toHaveBeenCalledTimes(1);

        await act(async () => {
            f.cancellation.resolve();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        await vi.waitFor(() => expect(current.state?.phase).toBe('cancelled'));
        expect(current.state).toMatchObject({ totalStatements: 2, completedStatements: 0 });
        expect(current.busy).toBe(false);
        expect(isNotebookExecutionRunning(f.notebook)).toBe(false);
        expect(f.executeQuery).toHaveBeenCalledTimes(1);
        expect(f.stream.cancel).toHaveBeenCalledTimes(1);
        expect(f.stream.produce).not.toHaveBeenCalled();
        expect(f.modify.mock.calls.filter(([action]) => action.type === REGISTER_QUERY)).toHaveLength(1);
    });

    it('completes schema-less commands without requesting their unresolved schema', async () => {
        const f = fixtures[0];
        const getSchema = vi.fn(() => new Promise<null>(() => {}));
        f.stream.getSchema = getSchema;
        await render();
        await start();
        expect(getSchema).not.toHaveBeenCalled();

        await act(async () => {
            f.execution.resolve();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        await vi.waitFor(() => expect(current.state?.phase).toBe('succeeded'));
        expect(current.state).toMatchObject({ totalStatements: 2, completedStatements: 2, completedScripts: 1 });
        expect(current.busy).toBe(false);
        expect(f.executeQuery).toHaveBeenCalledTimes(2);
        expect(f.stream.produce).toHaveBeenCalledTimes(2);
        expect(getSchema).not.toHaveBeenCalled();
        expect(f.stream.cancel).not.toHaveBeenCalled();
        expect(f.modify.mock.calls.filter(([action]) => action.type === REGISTER_QUERY)).toHaveLength(2);
    });

    it('retains per-notebook state when route consumers switch ids and remount', async () => {
        await render();
        await start();
        await render('second');
        expect(current.state).toBeNull();
        expect(current.busy).toBe(false);
        expect(observer.state?.phase).toBe('running');
        expect(observer.busy).toBe(true);
        expect(fixtures[0].signal?.aborted).toBe(false);
        await start(fixtures[1]);
        expect(fixtures[1].plan).toHaveBeenCalledTimes(1);

        await render('second', false);
        await act(async () => {
            fixtures[0].execution.resolve();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        await vi.waitFor(() => expect(observer.state?.phase).toBe('succeeded'));
        const completed = observer.state;
        await render('first');
        expect(current.state).toBe(completed);
        expect(current.busy).toBe(false);
        expect(fixtures[0].plan).toHaveBeenCalledTimes(1);
        await render('second');
        expect(current.state?.phase).toBe('running');
        expect(current.busy).toBe(true);
        expect(fixtures[1].signal?.aborted).toBe(false);
    });

    it.each(['offline', 'active query'] as const)('does not start with an %s connection', async reason => {
        const f = fixtures[0];
        if (reason === 'offline') f.database.connectionHealth = ConnectionHealth.FAILED;
        else f.database.queriesActive.set(99, {} as never);
        await render();
        act(() => current.start(f.modify));
        expect(f.plan).not.toHaveBeenCalled();
        expect(f.executeQuery).not.toHaveBeenCalled();
        expect(f.modify).not.toHaveBeenCalled();
        expect(current.state).toBeNull();
        expect(current.busy).toBe(false);
    });

    it('aborts every active run when the provider unmounts, not when route consumers unmount', async () => {
        await render();
        await start();
        await render('second');
        await start(fixtures[1]);
        await render('second', false, false);
        for (const f of fixtures) {
            expect(f.signal?.aborted).toBe(true);
            expect(f.aborted).toHaveBeenCalledTimes(1);
            expect(f.stream.cancel).toHaveBeenCalledTimes(1);
            expect(f.executeQuery).toHaveBeenCalledTimes(1);
        }
    });

    it.each(['planning', 'running', 'stopping', 'succeeded', 'failed', 'cancelled'] as const)('classifies the %s phase', phase => {
        expect(notebookExecutionIsBusy({ phase } as NotebookExecutionState))
            .toBe(phase === 'planning' || phase === 'running' || phase === 'stopping');
        expect(notebookExecutionIsBusy(null)).toBe(false);
        expect(notebookExecutionIsBusy(undefined)).toBe(false);
    });
});
