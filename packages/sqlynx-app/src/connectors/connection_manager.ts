import * as React from "react";

import { ConnectorState } from "./connector_state.js";
import { Dispatch } from "../utils/variant.js";

type RegisteredConnection = ConnectorState & { readonly registryEntryId: number };
type SetConnectionAction = (prev: ConnectorState) => ConnectorState;

let GLOBAL_CONNECTIONS: Map<number, RegisteredConnection> = new Map();
let NEXT_CONNECTION_ID = 1;

/// Resolve a session state by id
export function useSessionState(id: number | null): [ConnectorState | null, Dispatch<SetConnectionAction>] {
    const [state, setState] = React.useState<RegisteredConnection | null>(null);
    React.useEffect(() => {
        setState(id == null ? null : GLOBAL_CONNECTIONS.get(id) ?? null);
    }, [id]);
    const reducer = React.useCallback(
        (action: SetConnectionAction) => {
            if (id == null) {
                return;
            }
            const prev = GLOBAL_CONNECTIONS.get(id)!;
            const next = {
                ...action(prev),
                registryEntryId: id,
            };
            GLOBAL_CONNECTIONS.set(id, next);
            setState(next);
        },
        [id, setState],
    );
    return [state, reducer];
}

/// Register a new session
export function registerSession(state: ConnectorState): number {
    const entryId = NEXT_CONNECTION_ID++;
    GLOBAL_CONNECTIONS.set(entryId, {
        ...state,
        registryEntryId: entryId,
    });
    return entryId;
}
