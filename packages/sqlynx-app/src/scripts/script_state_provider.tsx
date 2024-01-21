import * as React from 'react';

import { ScriptState } from './script_state';
import { Dispatch } from '../utils/variant';
import { ScriptStateAction, useGlobalScriptState } from './script_state_reducer';

const SCRIPT_SELECTOR_CTX = React.createContext<((id: number) => void) | null>(null);
const SCRIPT_STATE_CTX = React.createContext<ScriptState | null>(null);
const SCRIPT_DISPATCH_CTX = React.createContext<Dispatch<ScriptStateAction> | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const ScriptStateProvider: React.FC<Props> = (props: Props) => {
    const [selectedScript, selectScript] = React.useState<number | null>(null);
    const [state, dispatch] = useGlobalScriptState(selectedScript);
    return (
        <SCRIPT_SELECTOR_CTX.Provider value={selectScript}>
            <SCRIPT_STATE_CTX.Provider value={state}>
                <SCRIPT_DISPATCH_CTX.Provider value={dispatch}>{props.children}</SCRIPT_DISPATCH_CTX.Provider>
            </SCRIPT_STATE_CTX.Provider>
        </SCRIPT_SELECTOR_CTX.Provider>
    );
};

export const useScriptState = (): ScriptState | null => React.useContext(SCRIPT_STATE_CTX);
export const useScriptStateDispatch = (): Dispatch<ScriptStateAction> => React.useContext(SCRIPT_DISPATCH_CTX)!;
export const useScriptSelector = (): ((id: number) => void) => React.useContext(SCRIPT_SELECTOR_CTX)!;
