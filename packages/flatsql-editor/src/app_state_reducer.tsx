import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';

import { useFlatSQL } from './flatsql_loader';
import { FlatSQLScriptBuffers, parseAndAnalyzeScript } from './editor/flatsql_analyzer';
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
    | Action<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, FlatSQLScriptBuffers]>
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
            return newState;
        }
        case UPDATE_SCRIPT_ANALYSIS: {
            // Destroy the previous buffers
            const [scriptKey, data] = action.value;
            const script = state.scripts[scriptKey];
            script.buffers.destroy(script.buffers);
            // Store the new buffers
            const newState: AppState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...script,
                        buffers: data,
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
            // Create the FlatSQL script and insert the text
            const newScript = state.instance!.createScript();
            newScript.insertTextAt(0, content);
            // Create new state
            const newState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...data,
                        loading: {
                            status: LoadingStatus.SUCCEEDED,
                            startedAt: data.loading.startedAt,
                            finishedAt: new Date(),
                            error: null,
                        },
                    },
                },
            };
            // Analyze newly loaded scripts
            switch (scriptKey) {
                case ScriptKey.MAIN_SCRIPT: {
                    console.log('LOADED MAIN');
                    // Destroy the old script and buffers
                    const old = newState.scripts[ScriptKey.MAIN_SCRIPT];
                    old.buffers.destroy(old.buffers);
                    old.script?.delete();
                    old.script = null;
                    // Analyze the new script
                    const external = newState.scripts[ScriptKey.SCHEMA_SCRIPT].script;
                    const analysis = parseAndAnalyzeScript(newScript, external);
                    newState.scripts[ScriptKey.MAIN_SCRIPT] = {
                        ...newState.scripts[ScriptKey.MAIN_SCRIPT],
                        script: newScript,
                        buffers: analysis,
                    };
                    break;
                }
                case ScriptKey.SCHEMA_SCRIPT: {
                    console.log('LOADED SCHEMA');
                    // Destroy the old script and buffers
                    const old = newState.scripts[ScriptKey.SCHEMA_SCRIPT];
                    old.buffers.destroy(old.buffers);
                    old.script?.delete();
                    old.script = null;
                    // Analyze the new script
                    const schemaAnalyzed = parseAndAnalyzeScript(newScript, null);
                    const main = newState.scripts[ScriptKey.MAIN_SCRIPT];
                    if (main.script) {
                        // Delete the old main analysis
                        main.buffers.analyzed?.delete();
                        main.buffers.analyzed = null;
                        // Analyze the old main script with the new script as external
                        const mainAnalyzed = main.script.analyze(newScript);
                        newState.scripts[ScriptKey.MAIN_SCRIPT] = {
                            ...newState.scripts[ScriptKey.MAIN_SCRIPT],
                            buffers: {
                                ...main.buffers,
                                analyzed: mainAnalyzed,
                            },
                        };
                    }
                    newState.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                        ...newState.scripts[ScriptKey.SCHEMA_SCRIPT],
                        script: newScript,
                        buffers: schemaAnalyzed,
                    };
                    break;
                }
            }
            return computeSchemaGraph(newState);
        }
        case LOAD_SCRIPTS: {
            const newState = { ...state };
            for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                if (!action.value[key]) continue;
                // Destroy previous analysis & script
                const previous = state.scripts[key];
                previous.buffers.destroy(previous.buffers);
                previous.script?.delete();
                // Store
                const metadata = action.value[key];
                newState.scripts[key] = {
                    scriptKey: key,
                    script: null,
                    metadata: metadata,
                    loading: {
                        status: LoadingStatus.PENDING,
                        error: null,
                        startedAt: null,
                        finishedAt: null,
                    },
                    buffers: {
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
