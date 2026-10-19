import * as React from 'react';

import { createQueryExecutionMetrics } from '../query/query_execution_state.js';
import type { QueryExecutionHistoryState } from '../query/query_execution_state.js';
import { CONNECTOR_INFOS, ConnectorType } from '../app/notebook/connections/connector_info.js';
import { ConnectionHealth, ConnectionStatus, type AttachedDatabaseState } from '../app/notebook/connections/attached_database_state.js';
import { useAttachedDatabaseRegistrySetter } from '../app/notebook/connections/attached_database_registry.js';
import { ShellQueryExecutionTracker } from './query_execution.js';

export const SHELL_DATABASE_ID = 'shell';
export const SHELL_NOTEBOOK_ID = 'shell';

interface ShellConnectionContextValue {
    queryExecutions: ShellQueryExecutionTracker;
    setConnected: (connected: boolean) => void;
}

const SHELL_CONNECTION_CTX = React.createContext<ShellConnectionContextValue | null>(null);

function createShellAttachedDatabaseState(): AttachedDatabaseState {
    return {
        databaseId: SHELL_DATABASE_ID,
        active: false,
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
        metrics: createQueryExecutionMetrics(),
        queriesActive: new Map(),
        queriesActiveOrdered: [],
        queriesFinished: new Map(),
        queriesFinishedOrdered: [],
        snapshotQueriesActiveFinished: 1,
    } as unknown as AttachedDatabaseState;
}

export const ShellConnectionProvider: React.FC<{ children: React.ReactElement }> = props => {
    const setRegistry = useAttachedDatabaseRegistrySetter();
    const stateRef = React.useRef<AttachedDatabaseState>(createShellAttachedDatabaseState());

    const publish = React.useCallback((state: AttachedDatabaseState) => {
        stateRef.current = state;
        setRegistry(registry => {
            registry.attachedDatabases.set(SHELL_DATABASE_ID, state);
            registry.attachedDatabasesByNotebook.set(SHELL_NOTEBOOK_ID, {
                mainDatabaseId: SHELL_DATABASE_ID,
                attachedDatabaseIds: [],
            });
            if (!registry.attachedDatabasesByType[ConnectorType.HYPER].includes(SHELL_DATABASE_ID)) {
                registry.attachedDatabasesByType[ConnectorType.HYPER].push(SHELL_DATABASE_ID);
            }
            return { ...registry };
        });
    }, [setRegistry]);

    const [queryExecutions] = React.useState(() => new ShellQueryExecutionTracker((history: QueryExecutionHistoryState) => {
        publish({
            ...stateRef.current,
            ...history,
        });
    }));
    const setConnected = React.useCallback((connected: boolean) => {
        publish({
            ...stateRef.current,
            active: connected,
            connectionStatus: connected ? ConnectionStatus.CHANNEL_READY : ConnectionStatus.NOT_STARTED,
            connectionHealth: connected ? ConnectionHealth.ONLINE : ConnectionHealth.NOT_STARTED,
        });
    }, [publish]);

    React.useEffect(() => {
        publish(stateRef.current);
        return () => {
            setRegistry(registry => {
                registry.attachedDatabases.delete(SHELL_DATABASE_ID);
                registry.attachedDatabasesByNotebook.delete(SHELL_NOTEBOOK_ID);
                registry.attachedDatabasesByType[ConnectorType.HYPER] = registry.attachedDatabasesByType[ConnectorType.HYPER]
                    .filter(connectionId => connectionId !== SHELL_DATABASE_ID);
                return { ...registry };
            });
        };
    }, [publish, setRegistry]);

    const value = React.useMemo(() => ({ queryExecutions, setConnected }), [queryExecutions, setConnected]);
    return <SHELL_CONNECTION_CTX.Provider value={value}>{props.children}</SHELL_CONNECTION_CTX.Provider>;
};

export function useShellConnection(): ShellConnectionContextValue {
    return React.useContext(SHELL_CONNECTION_CTX)!;
}
