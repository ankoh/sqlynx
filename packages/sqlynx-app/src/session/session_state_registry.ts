import * as React from 'react';

import { SessionState } from './session_state.js';
import { Dispatch } from '../utils/variant.js';
import { SessionStateAction, reduceSessionState } from './session_state_reducer.js';

/// ATTENTION
///
/// React reducers do not play nice together with the "impure" side-effects through state held in Wasm.
/// When running react in strict mode, React will call our reducers multiple times with the same state.
/// Moving all interactions and memory management OUT of the reducer is far too painful and nothing we want to do.
///
/// We therefore bypass the "pureness" rules for the top-level state and use a single global state instead.

let GLOBAL_SESSIONS: Map<number, SessionState> = new Map();
let NEXT_REGISTRY_ENTRY_ID = 1;

export function useSessionState(id: number | null): [SessionState | null, Dispatch<SessionStateAction>] {
    const [state, setState] = React.useState<SessionState | null>(null);
    React.useEffect(() => {
        setState(id == null ? null : GLOBAL_SESSIONS.get(id) ?? null);
    }, [id]);
    const reducer = React.useCallback(
        (action: SessionStateAction) => {
            if (id == null) {
                return;
            }
            const prev = GLOBAL_SESSIONS.get(id)!;
            const next = reduceSessionState(prev, action);
            GLOBAL_SESSIONS.set(id, next);
            setState(next);
        },
        [id, setState],
    );
    return [state, reducer];
}

export function registerSession(sessionState: Omit<SessionState, 'registryEntryId'>): number {
    const entryId = NEXT_REGISTRY_ENTRY_ID++;
    GLOBAL_SESSIONS.set(entryId, {
        ...sessionState,
        registryEntryId: entryId,
    });
    return entryId;
}

export function getRegisteredSessionCount(): number {
    return GLOBAL_SESSIONS.size;
}

export function getNextRegisteredSession(id: number | null): number | null {
    const keys = [...GLOBAL_SESSIONS.keys()];
    keys.sort();
    if (keys.length == 0) {
        return id;
    } else {
        return keys[(keys.findIndex(v => v == id) + 1) % keys.length];
    }
}
