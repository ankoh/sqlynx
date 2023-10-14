import * as React from 'react';

import { useSQLynx } from '../sqlynx_loader';
import { AppState, ScriptKey, createDefaultState } from './app_state';
import { Dispatch } from '../utils/action';
import { RESULT_OK } from '../utils/result';
import { TPCH_SCHEMA, exampleScripts } from '../scripts/example_scripts';
import { AppStateAction, INITIALIZE, LOAD_SCRIPTS, reduceAppState } from './app_state_reducer';

const stateContext = React.createContext<AppState | null>(null);
const stateDispatch = React.createContext<Dispatch<AppStateAction> | null>(null);

type Props = {
    children: React.ReactElement;
};

export const AppStateProvider: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer(reduceAppState, null, () => createDefaultState());
    const scriptsLoaded = React.useRef<boolean>(false);

    const backend = useSQLynx();
    React.useEffect(() => {
        if (backend?.type == RESULT_OK && !state.instance) {
            dispatch({ type: INITIALIZE, value: backend.value });
        }
    }, [backend, state.instance]);

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
        <stateContext.Provider value={state}>
            <stateDispatch.Provider value={dispatch}>{props.children}</stateDispatch.Provider>
        </stateContext.Provider>
    );
};

export const useAppState = (): AppState => React.useContext(stateContext)!;
export const useAppStateDispatch = (): Dispatch<AppStateAction> => React.useContext(stateDispatch)!;
