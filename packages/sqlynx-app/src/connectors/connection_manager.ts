import * as React from "react";

import { ConnectorState } from "./connector_state.js";
import { Dispatch } from "../utils/variant.js";

type RegisteredConnection = ConnectorState & { readonly registryEntryId: number };
export type SetConnectionAction<V> = (prev: V) => V;

let GLOBAL_CONNECTIONS: Map<number, RegisteredConnection> = new Map();
let NEXT_CONNECTION_ID = 1;

/// Resolve a session state by id.
/// We deliberately pass in the id as parameter since we'll later use multiple connections of the same connector.
export function useConnectionState<V>(id: number, init: () => ConnectorState): [V, Dispatch<SetConnectionAction<V>>] {
    const [state, setState] = React.useState<RegisteredConnection>(() => {
        const conn = GLOBAL_CONNECTIONS.get(id);
        if (conn) {
            return conn;
        } else {
            const next = {
                registryEntryId: id,
                ...init(),
            };
            GLOBAL_CONNECTIONS.set(id, next);
            return next;
        }
    });
    const reducer = React.useCallback(
        (action: SetConnectionAction<V>) => {
            const prev = GLOBAL_CONNECTIONS.get(id);
            const next = {
                ...prev,
                value: action(prev!.value as V),
            } as RegisteredConnection;
            GLOBAL_CONNECTIONS.set(id, next);
            setState(next);
        }, []
    );
    return [state.value as V, reducer];
};

/// Create a connection id
export function createConnectionId(): number {
    return NEXT_CONNECTION_ID++;
}
