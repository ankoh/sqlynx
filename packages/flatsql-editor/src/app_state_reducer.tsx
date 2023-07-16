import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';

import { useFlatSQL } from './flatsql_loader';
import { FlatSQLScriptState, destroyScriptState } from './editor/flatsql_analyzer';
import { TMP_TPCH_SCHEMA } from './model/example_scripts';
import { AppState, destroyState } from './app_state';
import { Action, Dispatch } from './model/action';
import { RESULT_OK } from './utils/result';

export const INITIALIZE = Symbol('INITIALIZE');
export const UPDATE_SCRIPT = Symbol('UPDATE_SCRIPT');
export const RESIZE_SCHEMA_GRAPH = Symbol('RESIZE_EDITOR');
export const DESTROY = Symbol('DESTORY');

/// A key to identify the target script
export enum ScriptKey {
    MAIN_SCRIPT = 1,
    SCHEMA_SCRIPT = 2,
}

export type AppStateAction =
    | Action<typeof INITIALIZE, flatsql.FlatSQL>
    | Action<typeof UPDATE_SCRIPT, FlatSQLScriptState>
    | Action<typeof RESIZE_SCHEMA_GRAPH, [number, number]>
    | Action<typeof DESTROY, undefined>;

/// Reducer for application actions
const reducer = (state: AppState, action: AppStateAction): AppState => {
    switch (action.type) {
        case INITIALIZE: {
            const s: AppState = {
                ...state,
                instance: action.value,
                main: {
                    ...state.main,
                    script: action.value.createScript(),
                },
                schema: {
                    ...state.schema,
                    script: action.value.createScript(),
                },
                graph: action.value.createSchemaGraph(),
            };
            s.main.script!.insertTextAt(0, TMP_TPCH_SCHEMA);
            return s;
        }
        case UPDATE_SCRIPT: {
            const next = action.value;
            switch (next.scriptKey) {
                case ScriptKey.MAIN_SCRIPT:
                    destroyScriptState(state.main);
                    return computeSchemaGraph({
                        ...state,
                        main: next,
                    });
                case ScriptKey.SCHEMA_SCRIPT:
                    destroyScriptState(state.schema);
                    return computeSchemaGraph({
                        ...state,
                        schema: next,
                    });
            }
            return state;
        }
        case RESIZE_SCHEMA_GRAPH:
            return computeSchemaGraph({
                ...state,
                graphConfig: {
                    ...state.graphConfig,
                    boardWidth: action.value[0],
                    boardHeight: action.value[1],
                },
            });
        case DESTROY:
            return destroyState({ ...state });
    }
};

/// Compute a schema graph
function computeSchemaGraph(state: AppState): AppState {
    if (state.main.script == null) {
        return state;
    }
    console.time('Schema Graph Layout');
    if (state.graphLayout != null) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    state.graph!.configure(state.graphConfig);
    state.graphLayout = state.graph!.loadScript(state.main.script);
    console.timeEnd('Schema Graph Layout');
    return state;
}

const DEFAULT_BOARD_WIDTH = 800;
const DEFAULT_BOARD_HEIGHT = 600;

const defaultContext: AppState = {
    instance: null,
    main: {
        scriptKey: 0,
        script: null,
        scanned: null,
        parsed: null,
        analyzed: null,
    },
    schema: {
        scriptKey: 0,
        script: null,
        scanned: null,
        parsed: null,
        analyzed: null,
    },
    graph: null,
    graphLayout: null,
    graphConfig: {
        iterationCount: 50.0,
        forceScaling: 100.0,
        cooldownFactor: 0.96,
        repulsionForce: 0.5,
        edgeAttractionForce: 0.5,
        gravityForce: 1.6,
        initialRadius: 100.0,
        boardWidth: DEFAULT_BOARD_WIDTH,
        boardHeight: DEFAULT_BOARD_HEIGHT,
        tableWidth: 180,
        tableConstantHeight: 24,
        tableColumnHeight: 8,
        tableMaxHeight: 36,
        tableMargin: 20,
    },
};

const stateContext = React.createContext<AppState>(defaultContext);
const stateDispatch = React.createContext<Dispatch<AppStateAction>>(c => {});

type Props = {
    children: React.ReactElement;
};

export const AppStateProvider: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer(reducer, null, () => defaultContext);

    const backend = useFlatSQL();
    React.useEffect(() => {
        if (backend?.type == RESULT_OK && !state.instance) {
            dispatch({ type: INITIALIZE, value: backend.value });
        }
    }, [backend, state.instance]);
    return (
        <stateContext.Provider value={state}>
            <stateDispatch.Provider value={dispatch}>{props.children}</stateDispatch.Provider>
        </stateContext.Provider>
    );
};

export const useAppState = (): AppState => React.useContext(stateContext)!;
export const useAppStateDispatch = (): Dispatch<AppStateAction> => React.useContext(stateDispatch);
