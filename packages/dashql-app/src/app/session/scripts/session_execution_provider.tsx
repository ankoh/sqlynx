import * as React from 'react';

import { ConnectionHealth } from '../../connections/connection_state.js';
import { ConnectorType, HYPER_CONNECTOR } from '../../connections/connector_info.js';
import { useConnectionRegistry } from '../../connections/connection_registry.js';
import { useCancelQuery, useQueryExecutor } from '../../connections/query_executor.js';
import { useSessionScriptsRegistry, type ModifySessionScripts } from './session_scripts_registry.js';
import { runSessionExecution, type SessionExecutionState } from './session_execution.js';

interface ExecutionContext {
    states: Map<string, SessionExecutionState>;
    start: (sessionId: string, modify: ModifySessionScripts) => void;
    stop: (sessionId: string) => void;
}

const CONTEXT = React.createContext<ExecutionContext | null>(null);

export function sessionExecutionIsBusy(state: SessionExecutionState | null | undefined): boolean {
    return state?.phase === 'planning' || state?.phase === 'running' || state?.phase === 'stopping';
}

export function useSessionExecution(sessionId: string) {
    const context = React.useContext(CONTEXT);
    const state = context?.states.get(sessionId) ?? null;
    const start = context?.start;
    const stop = context?.stop;
    return React.useMemo(() => ({
        state,
        busy: sessionExecutionIsBusy(state),
        start: (modify: ModifySessionScripts) => start?.(sessionId, modify),
        stop: () => stop?.(sessionId),
    }), [state, start, stop, sessionId]);
}

export function SessionExecutionProvider(props: React.PropsWithChildren) {
    const [registry] = useSessionScriptsRegistry();
    const [connections] = useConnectionRegistry();
    const executeQuery = useQueryExecutor();
    const cancelQuery = useCancelQuery();
    const [states, setStates] = React.useState(new Map<string, SessionExecutionState>());
    const runs = React.useRef(new Map<string, AbortController>());
    const runningDatabases = React.useRef(new Set<string>());

    React.useEffect(() => () => {
        for (const controller of runs.current.values()) controller.abort();
    }, []);
    React.useEffect(() => {
        for (const [id, controller] of runs.current) {
            const session = registry.sessionScriptsMap.get(id);
            if (!session || connections.connections.get(session.databaseId)?.connectionHealth !== ConnectionHealth.ONLINE) {
                controller.abort();
            }
        }
    }, [registry, connections]);

    // The provider re-renders with every registry change.
    // Keep the context value stable and read the latest registries when an execution starts.
    const latest = React.useRef({ registry, connections, executeQuery, cancelQuery });
    latest.current = { registry, connections, executeQuery, cancelQuery };

    const start = React.useCallback((sessionId: string, modifySessionScripts: ModifySessionScripts) => {
        const { registry, connections, executeQuery, cancelQuery } = latest.current;
        const session = registry.sessionScriptsMap.get(sessionId);
        if (!session || runs.current.has(sessionId) || runningDatabases.current.has(session.databaseId)
            || Object.keys(session.scriptRefs).length === 0) return;
        const connection = connections.connections.get(session.databaseId);
        if (connection?.connectionHealth !== ConnectionHealth.ONLINE || connection.queriesActive.size > 0) return;
        const controller = new AbortController();
        runs.current.set(sessionId, controller);
        runningDatabases.current.add(session.databaseId);
        void runSessionExecution({
            session,
            getSession: () => latest.current.registry.sessionScriptsMap.get(sessionId) ?? null,
            executeQuery, cancelQuery, modifySessionScripts,
            maxConcurrentQueries: connection.connectorInfo.connectorType === ConnectorType.HYPER
                && connection.details.type === HYPER_CONNECTOR
                && connection.details.value.proto?.setupParams?.protocol != null
                && connection.details.value.proto.setupParams.protocol !== 'WASM' ? 4 : 1,
            signal: controller.signal,
            onState: state => setStates(previous => new Map(previous).set(sessionId, state)),
        }).finally(() => {
            runs.current.delete(sessionId);
            runningDatabases.current.delete(session.databaseId);
        });
    }, []);
    const stop = React.useCallback((id: string) => runs.current.get(id)?.abort(), []);
    const value = React.useMemo<ExecutionContext>(() => ({ states, start, stop }), [states, start, stop]);

    return <CONTEXT.Provider value={value}>
        {props.children}
    </CONTEXT.Provider>;
}
