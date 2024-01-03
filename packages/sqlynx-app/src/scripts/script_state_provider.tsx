import * as React from 'react';

import { useSQLynx } from '../sqlynx_loader';
import { ScriptState, ScriptKey } from './script_state';
import { Dispatch } from '../utils/action';
import { RESULT_OK } from '../utils/result';
import { TPCH_SCHEMA, exampleScripts } from './example_scripts';
import { ScriptStateAction, INITIALIZE, LOAD_SCRIPTS, useGlobalScriptState } from './script_state_reducer';

const SCRIPT_STATE_CTX = React.createContext<ScriptState | null>(null);
const SCRIPT_DISPATCH_CTX = React.createContext<Dispatch<ScriptStateAction> | null>(null);

type Props = {
    children: React.ReactElement[];
};

export const ScriptStateProvider: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = useGlobalScriptState();
    const scriptsLoaded = React.useRef<boolean>(false);

    const lnxSetup = useSQLynx();
    React.useEffect(() => {
        if (lnxSetup?.type == RESULT_OK && !state.instance) {
            dispatch({ type: INITIALIZE, value: lnxSetup.value });
        }
    }, [lnxSetup, state.instance]);

    // TODO move this to a dedicated loader
    React.useEffect(() => {
        if (state.instance != null && scriptsLoaded.current == false) {
            scriptsLoaded.current = true;
            dispatch({
                type: LOAD_SCRIPTS,
                value: {
                    [ScriptKey.MAIN_SCRIPT]: exampleScripts[2],
                    [ScriptKey.SCHEMA_SCRIPT]: TPCH_SCHEMA,
                },
            });
        }
    }, [state.instance]);

    return (
        <SCRIPT_STATE_CTX.Provider value={state}>
            <SCRIPT_DISPATCH_CTX.Provider value={dispatch}>{props.children}</SCRIPT_DISPATCH_CTX.Provider>
        </SCRIPT_STATE_CTX.Provider>
    );
};

export const useScriptState = (): ScriptState => React.useContext(SCRIPT_STATE_CTX)!;
export const useScriptStateDispatch = (): Dispatch<ScriptStateAction> => React.useContext(SCRIPT_DISPATCH_CTX)!;
