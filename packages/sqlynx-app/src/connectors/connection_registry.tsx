import * as React from 'react';

import {
    ConnectionDetailsVariant,
    ConnectionState,
    ConnectionStateWithoutId,
    createConnectionState,
} from './connection_state.js';
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
type ConnectionAllocator = (details: ConnectionDetailsVariant) => number;
type ConnectionReducer = (prev: ConnectionState) => ConnectionState;
export type ModifyConnectionAction = (reducer: ConnectionReducer) => void;

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

export function useAllocatedConnectionState(init: (id: number) => ConnectionStateWithoutId): number {
    const [_reg, setReg] = React.useContext(CONNECTION_REGISTRY_CTX)!;
    const cid = React.useMemo(() => NEXT_CONNECTION_ID++, []);
    React.useEffect(() => {
        setReg((reg) => {
            const state = init(cid);
            reg.connectionMap.set(cid, { connectionId: cid, ...state, })
            return { ...reg };
        });
    }, []);
    return cid;
}

export function useConnectionStateAllocator(): ConnectionAllocator {
    const [_reg, setReg] = React.useContext(CONNECTION_REGISTRY_CTX)!;
    return React.useCallback((details: ConnectionDetailsVariant) => {
        const cid = NEXT_CONNECTION_ID++;
        setReg((reg) => {
            const state = createConnectionState(details);
            reg.connectionMap.set(cid, { ...state, connectionId: cid });
            return { ...reg };
        });
        return cid;
    }, [setReg]);
}

export const useConnectionRegistry = () => React.useContext(CONNECTION_REGISTRY_CTX)![0];

export function useConnectionState(id: number | null): [ConnectionState | null, ModifyConnectionAction] {
    const [registry, setRegistry] = React.useContext(CONNECTION_REGISTRY_CTX)!;

    /// Wrapper to modify an individual connection
    const setConnection = React.useCallback((reducer: ConnectionReducer) => {
        setRegistry(
            (reg: ConnectionRegistry) => {
                // No id provided? Then do nothing.
                if (!id) {
                    return reg;
                }
                // Find the previous session state
                const prev = reg.connectionMap.get(id);
                // Ignore if the session does not exist
                if (!prev) {
                    console.warn(`no session registered with id ${id}`);
                    return reg;
                }
                // Reduce the session action
                const next = reducer(prev);
                reg.connectionMap.set(id, next);
                return { ...reg };
            }
        );
    }, [id, setRegistry]);
    return [id == null ? null : (registry.connectionMap.get(id) ?? null), setConnection]
}