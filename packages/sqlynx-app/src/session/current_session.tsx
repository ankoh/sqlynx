import * as React from 'react';

import { Dispatch } from '../utils/variant.js';
import { SessionState } from './session_state.js';
import { ModifySessionAction, useSessionState } from './session_state_registry.js';

type CurrentSessionSetter = Dispatch<React.SetStateAction<number | null>>;

const SESSION_CTX = React.createContext<[number | null, CurrentSessionSetter] | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const CurrentSessionStateProvider: React.FC<Props> = (props: Props) => {
    const active = React.useState<number | null>(null);
    return (
        <SESSION_CTX.Provider value={active}>
            {props.children}
        </SESSION_CTX.Provider>
    );
};

export function useCurrentSessionSelector(): CurrentSessionSetter {
    const [_CurrentSession, setCurrentSession] = React.useContext(SESSION_CTX)!;
    return setCurrentSession;
}

export function useCurrentSessionState(): [SessionState | null, ModifySessionAction] {
    const [CurrentSession, _setCurrentSession] = React.useContext(SESSION_CTX)!;
    return useSessionState(CurrentSession);
};
