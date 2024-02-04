import * as React from 'react';

import { SessionState } from './session_state.js';
import { Dispatch } from '../utils/variant.js';
import { SessionStateAction } from './session_state_reducer.js';
import { getNextRegisteredSession, getRegisteredSessionCount, useSessionState } from './session_state_registry.js';

interface ScriptIterator {
    count: number;
    next: () => void;
}

const SESSION_SELECTOR_CTX = React.createContext<((id: number) => void) | null>(null);
const SESSION_ITERATOR_CTX = React.createContext<ScriptIterator | null>(null);
const SESSION_STATE_CTX = React.createContext<SessionState | null>(null);
const SESSION_DISPATCH_CTX = React.createContext<Dispatch<SessionStateAction> | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const SessionStateProvider: React.FC<Props> = (props: Props) => {
    const [selectedScript, selectScript] = React.useState<number | null>(null);
    const [state, dispatch] = useSessionState(selectedScript);
    const iterator: ScriptIterator = {
        count: getRegisteredSessionCount(),
        next: () => selectScript(s => getNextRegisteredSession(s)),
    };
    return (
        <SESSION_SELECTOR_CTX.Provider value={selectScript}>
            <SESSION_ITERATOR_CTX.Provider value={iterator}>
                <SESSION_STATE_CTX.Provider value={state}>
                    <SESSION_DISPATCH_CTX.Provider value={dispatch}>{props.children}</SESSION_DISPATCH_CTX.Provider>
                </SESSION_STATE_CTX.Provider>
            </SESSION_ITERATOR_CTX.Provider>
        </SESSION_SELECTOR_CTX.Provider>
    );
};

export const useActiveSessionState = (): SessionState | null => React.useContext(SESSION_STATE_CTX);
export const useActiveSessionStateDispatch = (): Dispatch<SessionStateAction> => React.useContext(SESSION_DISPATCH_CTX)!;
export const useSessionSelector = (): ((id: number) => void) => React.useContext(SESSION_SELECTOR_CTX)!;
export const useSessionIterator = (): ScriptIterator => React.useContext(SESSION_ITERATOR_CTX)!;
