import * as React from 'react';

import { ConnectionHealth } from '../connections/attached_database_state.js';
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
    return {
        state,
        busy: notebookExecutionIsBusy(state),
        start: (modify: ModifyNotebookScripts) => context?.start(notebookId, modify),
        stop: () => context?.stop(notebookId),
    };
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

    const start = (notebookId: string, modifyNotebookScripts: ModifyNotebookScripts) => {
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
            getNotebook: () => registry.notebookScriptsMap.get(notebookId) ?? null,
            executeQuery, cancelQuery, modifyNotebookScripts,
            signal: controller.signal,
            onState: state => setStates(previous => new Map(previous).set(notebookId, state)),
        }).finally(() => {
            runs.current.delete(notebookId);
            runningDatabases.current.delete(notebook.databaseId);
        });
    };

    return <CONTEXT.Provider value={{ states, start, stop: id => runs.current.get(id)?.abort() }}>
        {props.children}
    </CONTEXT.Provider>;
}
