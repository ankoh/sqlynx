import * as React from 'react';
import * as Immutable from 'immutable';

import { ConnectionState } from './connection_state.js';
import { Dispatch } from '../utils/variant.js';

type ConnectionRegistry = Immutable.Map<number, ConnectionState>;
type SetConnectionRegistryAction = React.SetStateAction<ConnectionRegistry>;
type ConnectionReducer = (prev: ConnectionState) => ConnectionState;
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

export function useAllocatedConnectionState(init: (id: number) => ConnectionState): number {
    const [_reg, setReg] = React.useContext(CONNECTION_REGISTRY_CTX)!;
    const cid = React.useMemo(() => NEXT_CONNECTION_ID++, []);
    React.useEffect(() => {
        setReg((reg) => reg.set(cid, init(cid)));
    }, []);
    return cid;
}

export function useConnectionState(id: number): [ConnectionState | null, ModifyConnectionAction] {
    const [registry, setRegistry] = React.useContext(CONNECTION_REGISTRY_CTX)!;
    const setConnection = React.useCallback((reducer: ConnectionReducer) => {
        setRegistry(
            (reg: ConnectionRegistry) => {
                const prev = reg.get(id);
                if (!prev) {
                    return reg;
                }
                const next = reducer(prev);
                return reg.set(id, next);
            }
        );
    }, [id, setRegistry]);
    return [registry.get(id) ?? null, setConnection];
};
