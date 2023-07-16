import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';

import { useFlatSQL } from './flatsql_loader';
import { FlatSQLAnalysisRecord } from './editor/flatsql_analyzer';
import { TMP_TPCH_SCHEMA } from './script_loader/example_scripts';
import { AppState, ScriptKey, createDefaultState, createEmptyScript, destroyState } from './app_state';
import { Action, Dispatch } from './utils/action';
import { RESULT_OK } from './utils/result';
import { ScriptMetadata } from './script_loader/script_metadata';
import { LoadingStatus } from './script_loader/script_loader';

export const INITIALIZE = Symbol('INITIALIZE');
export const LOAD_SCRIPTS = Symbol('LOAD_SCRIPTS');
export const UPDATE_SCRIPT_ANALYSIS = Symbol('UPDATE_SCRIPT_ANALYSIS');
export const SCRIPT_LOADING_STARTED = Symbol('SCRIPT_LOADING_STARTED');
export const SCRIPT_LOADING_SUCCEEDED = Symbol('SCRIPT_LOADING_SUCCEEDED');
export const SCRIPT_LOADING_FAILED = Symbol('SCRIPT_LOADING_FAILED');
export const RESIZE_SCHEMA_GRAPH = Symbol('RESIZE_EDITOR');
export const DESTROY = Symbol('DESTROY');

export type AppStateAction =
    | Action<typeof INITIALIZE, flatsql.FlatSQL>
    | Action<typeof LOAD_SCRIPTS, { [key: number]: ScriptMetadata }>
    | Action<typeof UPDATE_SCRIPT_ANALYSIS, FlatSQLAnalysisRecord>
    | Action<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | Action<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | Action<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
    | Action<typeof RESIZE_SCHEMA_GRAPH, [number, number]>
    | Action<typeof DESTROY, undefined>;

/// Reducer for application actions
const reducer = (state: AppState, action: AppStateAction): AppState => {
    switch (action.type) {
        case INITIALIZE: {
            const newState: AppState = {
                ...state,
                instance: action.value,
                scripts: {
                    [ScriptKey.MAIN_SCRIPT]: createEmptyScript(ScriptKey.MAIN_SCRIPT, action.value),
                    [ScriptKey.SCHEMA_SCRIPT]: createEmptyScript(ScriptKey.SCHEMA_SCRIPT, action.value),
                },
                graph: action.value.createSchemaGraph(),
            };
            newState.scripts[ScriptKey.MAIN_SCRIPT].script!.insertTextAt(0, TMP_TPCH_SCHEMA);
            return newState;
        }
        case UPDATE_SCRIPT_ANALYSIS: {
            const script = state.scripts[action.value.scriptKey];
            script.analysis.destroy(script.analysis);
            const newState: AppState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [action.value.scriptKey]: {
                        ...script,
                        analysis: action.value,
                    },
                },
            };
            return computeSchemaGraph(newState);
        }
        case SCRIPT_LOADING_STARTED:
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [action.value]: {
                        ...state.scripts[action.value],
                        loading: {
                            status: LoadingStatus.STARTED,
                            startedAt: new Date(),
                            finishedAt: null,
                            error: null,
                        },
                    },
                },
            };
        case SCRIPT_LOADING_FAILED: {
            const data = state.scripts[action.value[0]];
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [action.value[0]]: {
                        ...data,
                        loading: {
                            status: LoadingStatus.FAILED,
                            startedAt: data.loading.startedAt,
                            finishedAt: new Date(),
                            error: action.value[1],
                        },
                    },
                },
            };
        }
        case SCRIPT_LOADING_SUCCEEDED: {
            const [scriptKey, content] = action.value;
            const data = state.scripts[scriptKey];
            const script = state.instance!.createScript();
            script.insertTextAt(0, content);
            // XXX Remove old?
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...data,
                        script: script,
                        loading: {
                            status: LoadingStatus.SUCCEEDED,
                            startedAt: data.loading.startedAt,
                            finishedAt: new Date(),
                            error: null,
                        },
                    },
                },
            };
        }
        case LOAD_SCRIPTS: {
            const newState = { ...state };
            for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                if (!action.value[key]) continue;
                // Destroy previous analysis & script
                const previous = state.scripts[key];
                previous.analysis.destroy(previous.analysis);
                previous.script?.delete();
                // Store
                const metadata = action.value[key];
                newState.scripts[key] = {
                    scriptKey: key,
                    script: state.instance!.createScript(),
                    metadata: metadata,
                    loading: {
                        status: LoadingStatus.PENDING,
                        error: null,
                        startedAt: null,
                        finishedAt: null,
                    },
                    analysis: {
                        scanned: null,
                        parsed: null,
                        analyzed: null,
                        destroy: () => {},
                    },
                };
            }
            return newState;
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
    if (state.scripts[ScriptKey.SCHEMA_SCRIPT].script == null) {
        return state;
    }
    console.time('Schema Graph Layout');
    if (state.graphLayout != null) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    state.graph!.configure(state.graphConfig);
    state.graphLayout = state.graph!.loadScript(state.scripts[ScriptKey.SCHEMA_SCRIPT].script);
    console.timeEnd('Schema Graph Layout');
    return state;
}

const stateContext = React.createContext<AppState | null>(null);
const stateDispatch = React.createContext<Dispatch<AppStateAction> | null>(null);

type Props = {
    children: React.ReactElement;
};

export const AppStateProvider: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer(reducer, null, () => createDefaultState());

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
export const useAppStateDispatch = (): Dispatch<AppStateAction> => React.useContext(stateDispatch)!;
