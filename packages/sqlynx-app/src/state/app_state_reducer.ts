import * as sqlynx from '@ankoh/sqlynx';

import { SQLynxScriptBuffers, analyzeScript, parseAndAnalyzeScript } from '../view/editor/sqlynx_processor';
import { AppState, ScriptKey, createEmptyScript, destroyState } from './app_state';
import { deriveScriptFocusFromCursor, focusGraphEdge, focusGraphNode } from './focus';
import { Action } from '../utils/action';
import { ScriptMetadata } from '../scripts/script_metadata';
import { LoadingStatus } from '../scripts/script_loader';
import { GraphConnectionId, GraphNodeDescriptor, computeGraphViewModel } from '../view/schema/graph_view_model';
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
    | Action<typeof INITIALIZE, sqlynx.SQLynx>
    | Action<typeof LOAD_SCRIPTS, { [key: number]: ScriptMetadata }>
    | Action<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, SQLynxScriptBuffers, sqlynx.proto.ScriptCursorInfoT]>
    | Action<typeof UPDATE_SCRIPT_CURSOR, [ScriptKey, sqlynx.proto.ScriptCursorInfoT]>
    | Action<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | Action<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | Action<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
    | Action<typeof FOCUS_GRAPH_NODE, GraphNodeDescriptor | null>
    | Action<typeof FOCUS_GRAPH_EDGE, GraphConnectionId.Value | null>
    | Action<typeof RESIZE_SCHEMA_GRAPH, [number, number]> // width, height
    | Action<typeof DEBUG_GRAPH_LAYOUT, boolean>
    | Action<typeof DESTROY, undefined>;

const SCHEMA_SCRIPT_CATALOG_RANK = 1e9;
const STATS_HISTORY_LIMIT = 20;

function rotateStatistics(
    log: Immutable.List<sqlynx.FlatBufferPtr<sqlynx.proto.ScriptStatistics>>,
    stats: sqlynx.FlatBufferPtr<sqlynx.proto.ScriptStatistics> | null,
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
            console.assert(state.catalog == null);
            const catalog = action.value.createCatalog();
            const mainScript = createEmptyScript(ScriptKey.MAIN_SCRIPT, action.value, catalog);
            const schemaScript = createEmptyScript(ScriptKey.SCHEMA_SCRIPT, action.value, catalog);
            const next: AppState = {
                ...state,
                instance: action.value,
                scripts: {
                    [ScriptKey.MAIN_SCRIPT]: mainScript,
                    [ScriptKey.SCHEMA_SCRIPT]: schemaScript,
                },
                catalog,
                graph: action.value.createQueryGraphLayout(),
            };
            return next;
        }
        case UPDATE_SCRIPT_ANALYSIS: {
            // Destroy the previous buffers
            const [scriptKey, buffers, cursor] = action.value;
            // Store the new buffers
            let scriptData = state.scripts[scriptKey];
            scriptData.processed.destroy(scriptData.processed);
            const next: AppState = {
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
            next.focus = deriveScriptFocusFromCursor(scriptKey, next.scripts, state.graphViewModel, cursor);
            // Is schema script?
            if (scriptKey == ScriptKey.SCHEMA_SCRIPT) {
                // Update the catalog since the schema might have changed
                next.catalog?.addScript(state.scripts[scriptKey].script!, SCHEMA_SCRIPT_CATALOG_RANK);
                // Update the main script since the schema graph depends on it
                const mainData = next.scripts[ScriptKey.MAIN_SCRIPT];
                const mainScript = mainData.script;
                if (mainScript != null) {
                    const newMain = { ...mainData };
                    newMain.processed = analyzeScript(mainData.processed, mainScript);
                    newMain.statistics = rotateStatistics(newMain.statistics, mainScript.getStatistics());
                    next.scripts[ScriptKey.MAIN_SCRIPT] = newMain;
                }
            }
            return computeSchemaGraph(next);
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
            // Create new state
            const next = {
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
            let newScript: sqlynx.SQLynxScript | null = null;
            try {
                // Analyze newly loaded scripts
                switch (scriptKey) {
                    case ScriptKey.MAIN_SCRIPT: {
                        // Destroy the old script and buffers
                        const prev = next.scripts[ScriptKey.MAIN_SCRIPT];
                        prev.processed.destroy(prev.processed);
                        prev.script?.delete();
                        prev.script = null;
                        // Create the SQLynx script and insert the text
                        newScript = state.instance!.createScript(state.catalog, ScriptKey.MAIN_SCRIPT);
                        newScript.insertTextAt(0, content);
                        // Analyze the new script
                        const analysis = parseAndAnalyzeScript(newScript);
                        next.scripts[ScriptKey.MAIN_SCRIPT] = {
                            ...next.scripts[ScriptKey.MAIN_SCRIPT],
                            script: newScript,
                            processed: analysis,
                            statistics: rotateStatistics(prev.statistics, newScript.getStatistics() ?? null),
                        };
                        break;
                    }
                    case ScriptKey.SCHEMA_SCRIPT: {
                        // Destroy the old script and buffers
                        const prev = next.scripts[ScriptKey.SCHEMA_SCRIPT];
                        prev.processed.destroy(prev.processed);
                        prev.script?.delete();
                        prev.script = null;
                        // Create the script and insert the text
                        newScript = state.instance!.createScript(state.catalog, ScriptKey.SCHEMA_SCRIPT);
                        newScript.insertTextAt(0, content);
                        // Analyze the new schema
                        const schemaAnalyzed = parseAndAnalyzeScript(newScript);
                        next.catalog!.addScript(newScript, SCHEMA_SCRIPT_CATALOG_RANK);
                        // We updated the schema script, do we have to re-analyze the main script?
                        const main = next.scripts[ScriptKey.MAIN_SCRIPT];
                        if (main.script) {
                            // Analyze the old main script with the new schema
                            const mainAnalyzed = analyzeScript(main.processed, main.script);
                            // Store the new main script
                            next.scripts[ScriptKey.MAIN_SCRIPT] = {
                                ...main,
                                processed: mainAnalyzed,
                                statistics: rotateStatistics(main.statistics, main.script.getStatistics() ?? null),
                            };
                        }
                        next.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                            ...next.scripts[ScriptKey.SCHEMA_SCRIPT],
                            script: newScript,
                            processed: schemaAnalyzed,
                            statistics: rotateStatistics(prev.statistics, newScript.getStatistics() ?? null),
                        };
                        break;
                    }
                }
            } catch (e: any) {
                console.error(e);
                newScript?.delete();
                next.scripts[scriptKey] = {
                    ...next.scripts[scriptKey],
                    script: null,
                    loading: {
                        status: LoadingStatus.FAILED,
                        startedAt: data.loading.startedAt,
                        finishedAt: new Date(),
                        error: e,
                    },
                };
            }
            return computeSchemaGraph(next);
        }
        case LOAD_SCRIPTS: {
            const next = { ...state };
            for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                if (!action.value[key]) continue;
                // Destroy previous analysis & script
                const prev = state.scripts[key];
                prev.processed.destroy(prev.processed);
                prev.script?.delete();
                // Update the script metadata
                const metadata = action.value[key];
                next.scripts[key] = {
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
            return next;
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
                    boardHeight: action.value[1],
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
    const main = state.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
    if (main == null || main.script == null) {
        return state;
    }
    state.graph!.configure(state.graphConfig);
    state.graphLayout?.delete();
    state.graphLayout = state.graph!.loadScript(main.script);
    state.graphViewModel = computeGraphViewModel(state);
    return state;
}
