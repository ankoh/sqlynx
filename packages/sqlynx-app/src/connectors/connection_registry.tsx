import * as React from 'react';
import * as Immutable from 'immutable';

import { ConnectionState } from './connection_state.js';
import { Dispatch } from '../utils/variant.js';

type ConnectionRegistry = Immutable.Map<number, ConnectionState>;
type SetConnectionRegistryAction = React.SetStateAction<ConnectionRegistry>;
type ConnectionReducer = (prev: ConnectionState) => ConnectionState;
type ConnectionAllocator = (prev: ConnectionState) => number;
export type ModifyConnectionAction = (reducer: ConnectionReducer) => void;

const CONNECTION_REGISTRY_CTX = React.createContext<[ConnectionRegistry, Dispatch<SetConnectionRegistryAction>] | null>(null);
let NEXT_CONNECTION_ID: number = 1;

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const ConnectionRegistry: React.FC<Props> = (props: Props) => {
    const reg = React.useState<Immutable.Map<number, ConnectionState>>(() => Immutable.Map<number, ConnectionState>());
    return (
        <CONNECTION_REGISTRY_CTX.Provider value={reg}>
            {props.children}
        </CONNECTION_REGISTRY_CTX.Provider>
    );
};

export function useConnectionStateAllocator(): ConnectionAllocator {
    const [_reg, setReg] = React.useContext(CONNECTION_REGISTRY_CTX)!;
    return React.useCallback((state: ConnectionState) => {
        const sessionId = NEXT_CONNECTION_ID++;
        setReg((reg) => reg.set(sessionId, state));
        return sessionId;
    }, [setReg]);
}

export function useConnectionState(id: number | null): [ConnectionState | null, ModifyConnectionAction] {
    const [registry, setRegistry] = React.useContext(CONNECTION_REGISTRY_CTX)!;
    const setConnection = React.useCallback((reducer: ConnectionReducer) => {
        setRegistry(
            (reg: ConnectionRegistry) => {
                if (!id) {
                    return reg;
                }
                const prev = registry.get(id);
                if (!prev) {
                    return reg;
                }
                const next = reducer(prev);
                return reg.set(id, next);
            }
        );
    }, [id, setRegistry]);
    return [id == null ? null : registry.get(id) ?? null, setConnection];
};
