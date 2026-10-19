import * as React from 'react';

import { ConnectionHealth } from '../connections/attached_database_state.js';
import { ConnectorType, HYPER_CONNECTOR } from '../connections/connector_info.js';
import { useAttachedDatabaseRegistry } from '../connections/attached_database_registry.js';
import { useCancelQuery, useQueryExecutor } from '../connections/query_executor.js';
import { useNotebookScriptsRegistry, type ModifyNotebookScripts } from './notebook_scripts_registry.js';
import { runNotebookExecution, type NotebookExecutionState } from './notebook_execution.js';

interface ExecutionContext {
    states: Map<string, NotebookExecutionState>;
    start: (notebookId: string, modify: ModifyNotebookScripts) => void;
    stop: (notebookId: string) => void;
}

const CONTEXT = React.createContext<ExecutionContext | null>(null);

export function notebookExecutionIsBusy(state: NotebookExecutionState | null | undefined): boolean {
    return state?.phase === 'planning' || state?.phase === 'running' || state?.phase === 'stopping';
}

export function useNotebookExecution(notebookId: string) {
    const context = React.useContext(CONTEXT);
    const state = context?.states.get(notebookId) ?? null;
    const start = context?.start;
    const stop = context?.stop;
    return React.useMemo(() => ({
        state,
        busy: notebookExecutionIsBusy(state),
        start: (modify: ModifyNotebookScripts) => start?.(notebookId, modify),
        stop: () => stop?.(notebookId),
    }), [state, start, stop, notebookId]);
}

export function NotebookExecutionProvider(props: React.PropsWithChildren) {
    const [registry] = useNotebookScriptsRegistry();
    const [connections] = useAttachedDatabaseRegistry();
    const executeQuery = useQueryExecutor();
    const cancelQuery = useCancelQuery();
    const [states, setStates] = React.useState(new Map<string, NotebookExecutionState>());
    const runs = React.useRef(new Map<string, AbortController>());
    const runningDatabases = React.useRef(new Set<string>());

    React.useEffect(() => () => {
        for (const controller of runs.current.values()) controller.abort();
    }, []);
    React.useEffect(() => {
        for (const [id, controller] of runs.current) {
            const notebook = registry.notebookScriptsMap.get(id);
            if (!notebook || connections.attachedDatabases.get(notebook.databaseId)?.connectionHealth !== ConnectionHealth.ONLINE) {
                controller.abort();
            }
        }
    }, [registry, connections]);

    // The provider re-renders with every registry change.
    // Keep the context value stable and read the latest registries when an execution starts.
    const latest = React.useRef({ registry, connections, executeQuery, cancelQuery });
    latest.current = { registry, connections, executeQuery, cancelQuery };

    const start = React.useCallback((notebookId: string, modifyNotebookScripts: ModifyNotebookScripts) => {
        const { registry, connections, executeQuery, cancelQuery } = latest.current;
        const notebook = registry.notebookScriptsMap.get(notebookId);
        if (!notebook || runs.current.has(notebookId) || runningDatabases.current.has(notebook.databaseId)
            || Object.keys(notebook.scriptRefs).length === 0) return;
        const connection = connections.attachedDatabases.get(notebook.databaseId);
        if (connection?.connectionHealth !== ConnectionHealth.ONLINE || connection.queriesActive.size > 0) return;
        const controller = new AbortController();
        runs.current.set(notebookId, controller);
        runningDatabases.current.add(notebook.databaseId);
        void runNotebookExecution({
            notebook,
            getNotebook: () => latest.current.registry.notebookScriptsMap.get(notebookId) ?? null,
            executeQuery, cancelQuery, modifyNotebookScripts,
            maxConcurrentQueries: connection.connectorInfo.connectorType === ConnectorType.HYPER
                && connection.details.type === HYPER_CONNECTOR
                && connection.details.value.proto?.setupParams?.protocol != null
                && connection.details.value.proto.setupParams.protocol !== 'WASM' ? 4 : 1,
            signal: controller.signal,
            onState: state => setStates(previous => new Map(previous).set(notebookId, state)),
        }).finally(() => {
            runs.current.delete(notebookId);
            runningDatabases.current.delete(notebook.databaseId);
        });
    }, []);
    const stop = React.useCallback((id: string) => runs.current.get(id)?.abort(), []);
    const value = React.useMemo<ExecutionContext>(() => ({ states, start, stop }), [states, start, stop]);

    return <CONTEXT.Provider value={value}>
        {props.children}
    </CONTEXT.Provider>;
}
