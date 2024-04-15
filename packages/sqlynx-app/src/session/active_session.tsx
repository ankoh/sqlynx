import * as React from 'react';

import { Dispatch } from '../utils/variant.js';
import { SessionState } from './session_state.js';
import { ModifySessionAction, useSession } from './session_state_registry.js';

type ActiveSessionSetter = Dispatch<React.SetStateAction<number | null>>;

const ACTIVE_SESSION_CTX = React.createContext<[number | null, ActiveSessionSetter] | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const ActiveSessionStateProvider: React.FC<Props> = (props: Props) => {
    const active = React.useState<number | null>(null);
    return (
        <ACTIVE_SESSION_CTX.Provider value={active}>
            {props.children}
        </ACTIVE_SESSION_CTX.Provider>
    );
};

export function useActiveSessionSelector(): ActiveSessionSetter {
    return React.useContext(ACTIVE_SESSION_CTX)![1];
}

export function useActiveSessionState(): [SessionState | null, ModifySessionAction] {
    const [activeSession, _setActiveSession] = React.useContext(ACTIVE_SESSION_CTX)!;
    return useSession(activeSession);
};
