import * as React from 'react';
import * as Immutable from 'immutable';

import { SessionState } from './session_state.js';
import { Dispatch } from '../utils/variant.js';
import { DESTROY, SessionStateAction, reduceSessionState } from './session_state_reducer.js';

type SessionRegistry = Immutable.Map<number, SessionState>;
type SetSessionRegistryAction = React.SetStateAction<SessionRegistry>;
export type ModifySessionAction = (action: SessionStateAction) => void;

const SESSION_REGISTRY_CTX = React.createContext<[SessionRegistry, Dispatch<SetSessionRegistryAction>] | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const SessionStateRegistry: React.FC<Props> = (props: Props) => {
    const reg = React.useState<Immutable.Map<number, SessionState>>(() => Immutable.Map<number, SessionState>());
    return (
        <SESSION_REGISTRY_CTX.Provider value={reg}>
            {props.children}
        </SESSION_REGISTRY_CTX.Provider>
    );
};

export function useSessionState(id: number | null): [SessionState | null, ModifySessionAction] {
    const [registry, setRegistry] = React.useContext(SESSION_REGISTRY_CTX)!;
    const setSession = React.useCallback((action: SessionStateAction) => {
        setRegistry(
            (reg: SessionRegistry) => {
                if (!id) {
                    return reg;
                }
                const prev = registry.get(id);
                if (!prev) {
                    return reg;
                }
                const next = reduceSessionState(prev, action);
                if (action.type == DESTROY) {
                    return reg.delete(id);
                } else {
                    return reg.set(id, next);
                }
            }
        );
    }, [id, setRegistry]);
    return [id == null ? null : registry.get(id) ?? null, setSession];
};
