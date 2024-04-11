import * as React from "react";

import { ConnectionState } from "./connection_state.js";
import { Dispatch } from "../utils/variant.js";

type RegisteredConnection = ConnectionState & { readonly registryEntryId: number };
export type SetConnectionAction<V> = (prev: V) => V;

let GLOBAL_CONNECTIONS: Map<number, RegisteredConnection> = new Map();
let NEXT_CONNECTION_ID = 1;

/// Resolve a session state by id.
/// We deliberately pass in the id as parameter since we'll later use multiple connections of the same connector.
export function useOrCreateConnectionState<V>(id: number, init: () => ConnectionState): [V, Dispatch<SetConnectionAction<V>>] {
    let conn = GLOBAL_CONNECTIONS.get(id);
    if (!conn) {
        conn = {
            registryEntryId: id,
            ...init(),
        };
        GLOBAL_CONNECTIONS.set(id, conn);
    };
    const reducer = React.useCallback(
        (action: SetConnectionAction<V>) => {
            const prev = GLOBAL_CONNECTIONS.get(id);
            const next = {
                ...prev,
                value: action(prev!.value as V),
            } as RegisteredConnection;
            GLOBAL_CONNECTIONS.set(id, next);
        }, []
    );
    return [conn.value as V, reducer];
};

/// Use state of a connection that was created upfront
export function useConnectionState<V>(id: number | null): [V | null, Dispatch<SetConnectionAction<V>>] {
    const reducer = React.useCallback(
        (action: SetConnectionAction<V>) => {
            if (id == null) return;
            const prev = GLOBAL_CONNECTIONS.get(id);
            const next = {
                ...prev,
                value: action(prev!.value as V),
            } as RegisteredConnection;
            GLOBAL_CONNECTIONS.set(id, next);
        }, []
    );
    if (id != null && GLOBAL_CONNECTIONS.has(id)) {
        const conn = GLOBAL_CONNECTIONS.get(id)!;
        return [conn.value as V, reducer];
    } else {
        return [null, reducer];
    }
}

/// Create a connection id
export function createConnectionId(): number {
    return NEXT_CONNECTION_ID++;
}
