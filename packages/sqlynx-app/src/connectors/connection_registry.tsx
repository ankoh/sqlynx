import * as React from 'react';

import { ConnectionState, ConnectionStateAction, ConnectionStateWithoutId, reduceConnectionState } from './connection_state.js';
import { Dispatch } from '../utils/variant.js';

/// The connection registry
///
/// Note that we're deliberately not using immutable maps for the connections here.
/// Following the same reasoning as with the session registry, we don't have code that
/// explicitly observes modifications of the registry map.
/// Instead, shallow-compare the entire registry object again.
interface ConnectionRegistry {
    connectionMap: Map<number, ConnectionState>;
}

type SetConnectionRegistryAction = React.SetStateAction<ConnectionRegistry>;
type ConnectionAllocator = (state: ConnectionStateWithoutId) => number;
export type ConnectionDispatch = (action: ConnectionStateAction) => void;
export type DynamicConnectionDispatch = (id: number | null, action: ConnectionStateAction) => void;

const CONNECTION_REGISTRY_CTX = React.createContext<[ConnectionRegistry, Dispatch<SetConnectionRegistryAction>] | null>(null);
let NEXT_CONNECTION_ID: number = 1;

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const ConnectionRegistry: React.FC<Props> = (props: Props) => {
    const reg = React.useState<ConnectionRegistry>(() => ({
        connectionMap: new Map(),
    }));
    return (
        <CONNECTION_REGISTRY_CTX.Provider value={reg}>
            {props.children}
        </CONNECTION_REGISTRY_CTX.Provider>
    );
};

export function useConnectionStateAllocator(): ConnectionAllocator {
    const [_reg, setReg] = React.useContext(CONNECTION_REGISTRY_CTX)!;
    return React.useCallback((state: ConnectionStateWithoutId) => {
        const cid = NEXT_CONNECTION_ID++;
        setReg((reg) => {
            reg.connectionMap.set(cid, { ...state, connectionId: cid });
            return { ...reg };
        });
        return cid;
    }, [setReg]);
}

export const useConnectionRegistry = () => React.useContext(CONNECTION_REGISTRY_CTX)![0];

export function useDynamicConnectionDispatch(): [ConnectionRegistry, DynamicConnectionDispatch] {
    const [registry, setRegistry] = React.useContext(CONNECTION_REGISTRY_CTX)!;

    /// Helper to modify a dynamic connection
    const dispatch = React.useCallback((id: number | null, action: ConnectionStateAction) => {
        // No id provided? Then do nothing.
        if (!id) {
            return;
        }
        setRegistry(
            (reg: ConnectionRegistry) => {
                // Find the previous session state
                const prev = reg.connectionMap.get(id);
                // Ignore if the session does not exist
                if (!prev) {
                    console.warn(`no session registered with id ${id}`);
                    return reg;
                }
                // Reduce the session action
                const next = reduceConnectionState(prev, action);
                reg.connectionMap.set(id, next);
                return { ...reg };
            }
        );
    }, [setRegistry]);

    return [registry, dispatch];
}

export function useConnectionState(id: number | null): [ConnectionState | null, ConnectionDispatch] {
    const [registry, dispatch] = useDynamicConnectionDispatch();
    const capturingDispatch = React.useCallback((action: ConnectionStateAction) => dispatch(id, action), [id, dispatch]);
    return [id == null ? null : (registry.connectionMap.get(id) ?? null), capturingDispatch]
}