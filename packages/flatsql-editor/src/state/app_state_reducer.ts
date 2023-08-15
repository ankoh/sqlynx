import * as flatsql from '@ankoh/flatsql';

import { FlatSQLScriptBuffers, analyzeScript, parseAndAnalyzeScript } from '../editor/flatsql_processor';
import { AppState, ScriptKey, createEmptyScript, destroyState } from './app_state';
import { deriveScriptFocusFromCursor, focusGraphEdge, focusGraphNode } from './focus';
import { Action } from '../utils/action';
import { ScriptMetadata } from '../script_loader/script_metadata';
import { LoadingStatus } from '../script_loader/script_loader';
import { GraphConnectionId, GraphNodeDescriptor, computeGraphViewModel } from '../schema_graph/graph_view_model';
import Immutable from 'immutable';

export const INITIALIZE = Symbol('INITIALIZE');
export const LOAD_SCRIPTS = Symbol('LOAD_SCRIPTS');
export const UPDATE_SCRIPT_ANALYSIS = Symbol('UPDATE_SCRIPT_ANALYSIS');
export const UPDATE_SCRIPT_CURSOR = Symbol('UPDATE_SCRIPT_CURSOR');
export const SCRIPT_LOADING_STARTED = Symbol('SCRIPT_LOADING_STARTED');
export const SCRIPT_LOADING_SUCCEEDED = Symbol('SCRIPT_LOADING_SUCCEEDED');
export const SCRIPT_LOADING_FAILED = Symbol('SCRIPT_LOADING_FAILED');
export const FOCUS_GRAPH_NODE = Symbol('FOCUS_GRAPH_NODE');
export const FOCUS_GRAPH_EDGE = Symbol('FOCUS_GRAPH_EDGE');
export const RESIZE_SCHEMA_GRAPH = Symbol('RESIZE_EDITOR');
export const DEBUG_GRAPH_LAYOUT = Symbol('DEBUG_GRAPH_LAYOUT');
export const DESTROY = Symbol('DESTROY');

export type AppStateAction =
    | Action<typeof INITIALIZE, flatsql.FlatSQL>
    | Action<typeof LOAD_SCRIPTS, { [key: number]: ScriptMetadata }>
    | Action<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, FlatSQLScriptBuffers, flatsql.proto.ScriptCursorInfoT]>
    | Action<typeof UPDATE_SCRIPT_CURSOR, [ScriptKey, flatsql.proto.ScriptCursorInfoT]>
    | Action<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | Action<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | Action<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
    | Action<typeof FOCUS_GRAPH_NODE, GraphNodeDescriptor | null>
    | Action<typeof FOCUS_GRAPH_EDGE, GraphConnectionId.Value | null>
    | Action<typeof RESIZE_SCHEMA_GRAPH, [number, number]> // width, height
    | Action<typeof DEBUG_GRAPH_LAYOUT, boolean>
    | Action<typeof DESTROY, undefined>;

const STATS_HISTORY_LIMIT = 20;
function rotateStatistics(
    log: Immutable.List<flatsql.FlatBufferRef<flatsql.proto.ScriptStatistics>>,
    stats: flatsql.FlatBufferRef<flatsql.proto.ScriptStatistics> | null,
) {
    if (stats == null) {
        return log;
    } else {
        return log.withMutations(m => {
            m.push(stats);
            if (m.size > STATS_HISTORY_LIMIT) {
                m.first()!.delete();
                m.shift();
            }
        });
    }
}

/// Reducer for application actions
export function reduceAppState(state: AppState, action: AppStateAction): AppState {
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
            const [scriptKey, buffers, cursor] = action.value;
            // Store the new buffers
            let scriptData = state.scripts[scriptKey];
            scriptData.processed.destroy(scriptData.processed);
            const newState: AppState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...scriptData,
                        processed: buffers,
                        statistics: rotateStatistics(scriptData.statistics, scriptData.script?.getStatistics() ?? null),
                        cursor,
                    },
                },
                focus: null,
            };
            newState.focus = deriveScriptFocusFromCursor(scriptKey, newState.scripts, state.graphViewModel, cursor);
            // Is schema script?
            // Then we also have to update the main script since the schema graph depends on it.
            const mainData = newState.scripts[ScriptKey.MAIN_SCRIPT];
            const mainScript = mainData.script;
            if (scriptKey == ScriptKey.SCHEMA_SCRIPT && mainScript != null) {
                const newMain = { ...mainData };
                const external = newState.scripts[ScriptKey.SCHEMA_SCRIPT].script;
                newMain.processed = analyzeScript(mainData.processed, mainScript, external);
                newMain.statistics = rotateStatistics(newMain.statistics, mainScript.getStatistics());
                newState.scripts[ScriptKey.MAIN_SCRIPT] = newMain;
            }
            return computeSchemaGraph(newState);
        }
        case UPDATE_SCRIPT_CURSOR: {
            // Destroy previous cursor
            const [scriptKey, cursor] = action.value;
            // Store new cursor
            const newState: AppState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...state.scripts[scriptKey],
                        cursor,
                    },
                },
                focus: null,
            };
            newState.focus = deriveScriptFocusFromCursor(scriptKey, newState.scripts, state.graphViewModel, cursor);
            return newState;
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
            const newScript = state.instance!.createScript(scriptKey);
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
            try {
                // Analyze newly loaded scripts
                switch (scriptKey) {
                    case ScriptKey.MAIN_SCRIPT: {
                        // Destroy the old script and buffers
                        const old = newState.scripts[ScriptKey.MAIN_SCRIPT];
                        old.processed.destroy(old.processed);
                        old.script?.delete();
                        old.script = null;
                        // Analyze the new script
                        const external = newState.scripts[ScriptKey.SCHEMA_SCRIPT].script;
                        const analysis = parseAndAnalyzeScript(newScript, external);
                        newState.scripts[ScriptKey.MAIN_SCRIPT] = {
                            ...newState.scripts[ScriptKey.MAIN_SCRIPT],
                            script: newScript,
                            processed: analysis,
                            statistics: rotateStatistics(old.statistics, newScript.getStatistics() ?? null),
                        };
                        break;
                    }
                    case ScriptKey.SCHEMA_SCRIPT: {
                        // Destroy the old script and buffers
                        const old = newState.scripts[ScriptKey.SCHEMA_SCRIPT];
                        old.processed.destroy(old.processed);
                        old.script?.delete();
                        old.script = null;
                        // Analyze the new script
                        const schemaAnalyzed = parseAndAnalyzeScript(newScript, null);
                        const main = newState.scripts[ScriptKey.MAIN_SCRIPT];
                        if (main.script) {
                            // Analyze the old main script with the new script as external
                            const mainAnalyzed = analyzeScript(main.processed, main.script, newScript);
                            // Store the new main script
                            newState.scripts[ScriptKey.MAIN_SCRIPT] = {
                                ...main,
                                processed: mainAnalyzed,
                                statistics: rotateStatistics(main.statistics, main.script.getStatistics() ?? null),
                            };
                        }
                        newState.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                            ...newState.scripts[ScriptKey.SCHEMA_SCRIPT],
                            script: newScript,
                            processed: schemaAnalyzed,
                            statistics: rotateStatistics(old.statistics, newScript.getStatistics() ?? null),
                        };
                        break;
                    }
                }
            } catch (e: any) {
                console.error(e);
                newScript.delete();
                newState.scripts[scriptKey] = {
                    ...newState.scripts[scriptKey],
                    script: null,
                    loading: {
                        status: LoadingStatus.FAILED,
                        startedAt: data.loading.startedAt,
                        finishedAt: new Date(),
                        error: e,
                    },
                };
            }
            return computeSchemaGraph(newState);
        }
        case LOAD_SCRIPTS: {
            const newState = { ...state };
            for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                if (!action.value[key]) continue;
                // Destroy previous analysis & script
                const previous = state.scripts[key];
                previous.processed.destroy(previous.processed);
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
                    processed: {
                        scanned: null,
                        parsed: null,
                        analyzed: null,
                        destroy: () => {},
                    },
                    cursor: null,
                    statistics: Immutable.List(),
                };
            }
            return newState;
        }
        case FOCUS_GRAPH_NODE:
            return focusGraphNode(state, action.value);
        case FOCUS_GRAPH_EDGE:
            return focusGraphEdge(state, action.value);
        case RESIZE_SCHEMA_GRAPH:
            return computeSchemaGraph({
                ...state,
                graphConfig: {
                    ...state.graphConfig,
                    boardWidth: action.value[0],
                    boardHeight: action.value[1] * 0.9,
                },
            });
        case DEBUG_GRAPH_LAYOUT:
            return computeSchemaGraph({ ...state }, action.value);
        case DESTROY:
            return destroyState({ ...state });
    }
}

/// Compute a schema graph
function computeSchemaGraph(state: AppState, debug?: boolean): AppState {
    if (state.scripts[ScriptKey.MAIN_SCRIPT].script == null) {
        return state;
    }
    state.graph!.configure(state.graphConfig);
    state.graphLayout?.delete();
    state.graphLayout = state.graph!.loadScript(state.scripts[ScriptKey.MAIN_SCRIPT].script);
    state.graphDebugMode = debug ?? state.graphDebugMode;
    if (state.graphDebugMode) {
        state.graphDebugInfo?.delete();
        state.graphDebugInfo = state.graph?.describe() ?? null;
    }
    state.graphViewModel = computeGraphViewModel(state);
    return state;
}
