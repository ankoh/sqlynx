import * as React from 'react';

import { ScriptState } from './script_state';
import { Dispatch } from '../utils/variant';
import { ScriptStateAction } from './script_state_reducer';
import { getNextRegisteredScript, getRegisteredScriptCount, useScriptState } from './script_state_registry';

interface ScriptIterator {
    count: number;
    next: () => void;
}

const SCRIPT_SELECTOR_CTX = React.createContext<((id: number) => void) | null>(null);
const SCRIPT_ITERATOR_CTX = React.createContext<ScriptIterator | null>(null);
const SCRIPT_STATE_CTX = React.createContext<ScriptState | null>(null);
const SCRIPT_DISPATCH_CTX = React.createContext<Dispatch<ScriptStateAction> | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const ScriptStateProvider: React.FC<Props> = (props: Props) => {
    const [selectedScript, selectScript] = React.useState<number | null>(null);
    const [state, dispatch] = useScriptState(selectedScript);
    const iterator: ScriptIterator = {
        count: getRegisteredScriptCount(),
        next: () => selectScript(s => getNextRegisteredScript(s)),
    };
    return (
        <SCRIPT_SELECTOR_CTX.Provider value={selectScript}>
            <SCRIPT_ITERATOR_CTX.Provider value={iterator}>
                <SCRIPT_STATE_CTX.Provider value={state}>
                    <SCRIPT_DISPATCH_CTX.Provider value={dispatch}>{props.children}</SCRIPT_DISPATCH_CTX.Provider>
                </SCRIPT_STATE_CTX.Provider>
            </SCRIPT_ITERATOR_CTX.Provider>
        </SCRIPT_SELECTOR_CTX.Provider>
    );
};

export const useSelectedScriptState = (): ScriptState | null => React.useContext(SCRIPT_STATE_CTX);
export const useSelectedScriptStateDispatch = (): Dispatch<ScriptStateAction> => React.useContext(SCRIPT_DISPATCH_CTX)!;
export const useScriptSelector = (): ((id: number) => void) => React.useContext(SCRIPT_SELECTOR_CTX)!;
export const useScriptSelectionIterator = (): ScriptIterator => React.useContext(SCRIPT_ITERATOR_CTX)!;
