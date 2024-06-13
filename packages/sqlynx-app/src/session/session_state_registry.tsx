import * as React from 'react';

import { SessionState } from './session_state.js';
import { Dispatch } from '../utils/variant.js';
import { DESTROY, SessionStateAction, reduceSessionState } from './session_state_reducer.js';

/// The session registry.
///
/// Note that we're deliberately not using immutable maps for sessions and the connection index.
/// We're never "observing" these maps directly and thus can live with the simple variants.
/// Shallow-compare the entire registry object instead when reacting to session list changes.
interface SessionRegistry {
    /// The session map
    sessionMap: Map<number, SessionState>;
    /// The index to find sessions associated with a connection id
    sessionsByConnection: Map<number, number[]>;
}

type SessionStateWithoutId = Omit<SessionState, "sessionId">;
type SetSessionRegistryAction = React.SetStateAction<SessionRegistry>;
export type SessionAllocator = (session: SessionStateWithoutId) => number;
export type ModifySessionAction = (action: SessionStateAction) => void;

const SESSION_REGISTRY_CTX = React.createContext<[SessionRegistry, Dispatch<SetSessionRegistryAction>] | null>(null);
let NEXT_SESSION_ID: number = 1;

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const SessionStateRegistry: React.FC<Props> = (props: Props) => {
    const reg = React.useState<SessionRegistry>(() => ({
        sessionMap: new Map(),
        sessionsByConnection: new Map()
    }));
    return (
        <SESSION_REGISTRY_CTX.Provider value={reg}>
            {props.children}
        </SESSION_REGISTRY_CTX.Provider>
    );
};

export function useSessionStates(): SessionRegistry {
    return React.useContext(SESSION_REGISTRY_CTX)![0];
}

export function useSessionStateAllocator(): SessionAllocator {
    const [_reg, setReg] = React.useContext(SESSION_REGISTRY_CTX)!;
    return React.useCallback((state: SessionStateWithoutId) => {
        const sessionId = NEXT_SESSION_ID++;
        setReg((reg) => {
            const sameConnection = reg.sessionsByConnection.get(state.connectionId);
            if (sameConnection) {
                sameConnection.push(sessionId);
            } else {
                reg.sessionsByConnection.set(state.connectionId, [sessionId]);
            }
            reg.sessionMap.set(sessionId, { ...state, sessionId })
            return { ...reg };
        });
        return sessionId;
    }, [setReg]);
}

export function useSessionState(id: number | null): [SessionState | null, ModifySessionAction] {
    const [registry, setRegistry] = React.useContext(SESSION_REGISTRY_CTX)!;

    /// Wrapper to modify an individual session
    const setSession = React.useCallback((action: SessionStateAction) => {
        setRegistry(
            (reg: SessionRegistry) => {
                // No id provided? Then do nothing.
                if (!id) {
                    return reg;
                }
                // Find the previous session state
                const prev = reg.sessionMap.get(id);
                // Ignore if the session does not exist
                if (!prev) {
                    console.warn(`no session registered with id ${id}`);
                    return reg;
                }
                // Reduce the session action
                const next = reduceSessionState(prev, action);
                // Should we delete the entry?
                if (action.type == DESTROY) {
                    reg.sessionMap.delete(id)
                    let sameConnection = reg.sessionsByConnection.get(prev.connectionId) ?? [];
                    sameConnection = sameConnection.filter(c => c != prev.sessionId);
                    if (sameConnection.length == 0) {
                        reg.sessionsByConnection.delete(prev.connectionId);
                    } else {
                        reg.sessionsByConnection.set(prev.connectionId, sameConnection);
                    }
                    return { ...reg }
                } else {
                    reg.sessionMap.set(id, next);
                    return { ...reg };
                }
            }
        );
    }, [id, setRegistry]);

    return [id == null ? null : registry.sessionMap.get(id) ?? null, setSession];
};
