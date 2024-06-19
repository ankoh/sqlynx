import * as sqlynx from '@ankoh/sqlynx-core';
import Immutable from 'immutable';

import { ScriptMetadata } from './script_metadata.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { analyzeScript, parseAndAnalyzeScript, SQLynxScriptBuffers } from '../view/editor/sqlynx_processor.js';
import {
    computeGraphViewModel,
    GraphConnectionId,
    GraphNodeDescriptor,
    GraphViewModel,
} from '../view/schema/graph_view_model.js';
import { ScriptLoadingInfo } from './script_loader.js';
import { deriveScriptFocusFromCursor, focusGraphEdge, focusGraphNode, FocusInfo } from './focus.js';
import { ConnectorInfo } from '../connectors/connector_info.js';
import { VariantKind } from '../utils/index.js';

/// A key to identify the target script
export enum ScriptKey {
    MAIN_SCRIPT = 1,
    SCHEMA_SCRIPT = 2,
}
/// The state of the session
export interface SessionState {
    /// The session id
    sessionId: number;
    /// The session state contains many references into the Wasm heap.
    /// It therefore makes sense that script state users resolve the "right" module through here.
    instance: sqlynx.SQLynx | null;
    /// The connector info
    connectorInfo: ConnectorInfo;
    /// The connector state
    connectionId: number;
    /// THe connection catalog
    connectionCatalog: sqlynx.SQLynxCatalog;
    /// The scripts (main or external)j
    scripts: { [id: number]: ScriptData };
    /// The running queries of this session
    runningQueries: Set<number>;
    /// The finished queries of this session
    finishedQueries: number[];
    /// The editor query
    editorQuery: number | null;
    /// The graph
    graph: sqlynx.SQLynxQueryGraphLayout | null;
    /// The graph config
    graphConfig: sqlynx.SQLynxQueryGraphLayoutConfig;
    /// The graph layout
    graphLayout: sqlynx.FlatBufferPtr<sqlynx.proto.QueryGraphLayout> | null;
    /// The graph view model
    graphViewModel: GraphViewModel;
    /// The user focus info
    userFocus: FocusInfo | null;
}

/// The script data
export interface ScriptData {
    /// The script key
    scriptKey: ScriptKey;
    /// The version, changes trigger reloads in the editor
    scriptVersion: number;
    /// The script
    script: sqlynx.SQLynxScript | null;
    /// The metadata
    metadata: ScriptMetadata;
    /// The loading info
    loading: ScriptLoadingInfo;
    /// The processed scripts
    processed: SQLynxScriptBuffers;
    /// The statistics
    statistics: Immutable.List<sqlynx.FlatBufferPtr<sqlynx.proto.ScriptStatistics>>;
    /// The cursor
    cursor: sqlynx.proto.ScriptCursorInfoT | null;
}

/// Destroy a state
export function destroyState(state: SessionState): SessionState {
    const main = state.scripts[ScriptKey.MAIN_SCRIPT];
    const schema = state.scripts[ScriptKey.SCHEMA_SCRIPT];
    main.processed.destroy(main.processed);
    schema.processed.destroy(schema.processed);
    if (state.graphLayout) {
        state.graphLayout.delete();
        state.graphLayout = null;
    }
    for (const stats of main.statistics) {
        stats.delete();
    }
    for (const stats of schema.statistics) {
        stats.delete();
    }
    return state;
}

export const DESTROY = Symbol('DESTROY');

export const UPDATE_SCRIPT_ANALYSIS = Symbol('UPDATE_SCRIPT_ANALYSIS');
export const UPDATE_SCRIPT_CURSOR = Symbol('UPDATE_SCRIPT_CURSOR');
export const REPLACE_SCRIPT_CONTENT = Symbol('REPLACE_SCRIPT_CONTENT');

export const LOAD_SCRIPTS = Symbol('LOAD_SCRIPTS');
export const SCRIPT_LOADING_STARTED = Symbol('SCRIPT_LOADING_STARTED');
export const SCRIPT_LOADING_SUCCEEDED = Symbol('SCRIPT_LOADING_SUCCEEDED');
export const SCRIPT_LOADING_FAILED = Symbol('SCRIPT_LOADING_FAILED');

export const FOCUS_QUERY_GRAPH_NODE = Symbol('FOCUS_GRAPH_NODE');
export const FOCUS_QUERY_GRAPH_EDGE = Symbol('FOCUS_GRAPH_EDGE');
export const RESIZE_QUERY_GRAPH = Symbol('RESIZE_EDITOR');

export const REGISTER_EDITOR_QUERY = Symbol('REGISTER_EDITOR_QUERY');

export type SessionStateAction =
    | VariantKind<typeof DESTROY, null>
    | VariantKind<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, SQLynxScriptBuffers, sqlynx.proto.ScriptCursorInfoT]>
    | VariantKind<typeof UPDATE_SCRIPT_CURSOR, [ScriptKey, sqlynx.proto.ScriptCursorInfoT]>
    | VariantKind<typeof REPLACE_SCRIPT_CONTENT, { [key: number]: string }>
    | VariantKind<typeof LOAD_SCRIPTS, { [key: number]: ScriptMetadata }>
    | VariantKind<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | VariantKind<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | VariantKind<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
    | VariantKind<typeof FOCUS_QUERY_GRAPH_NODE, GraphNodeDescriptor | null>
    | VariantKind<typeof FOCUS_QUERY_GRAPH_EDGE, GraphConnectionId.Value | null>
    | VariantKind<typeof RESIZE_QUERY_GRAPH, [number, number]> // width, height
    | VariantKind<typeof REGISTER_EDITOR_QUERY, number>;

const SCHEMA_SCRIPT_CATALOG_RANK = 1e9;
const STATS_HISTORY_LIMIT = 20;

export function reduceSessionState(state: SessionState, action: SessionStateAction): SessionState {
    switch (action.type) {
        case DESTROY:
            return destroyState({ ...state });

        case UPDATE_SCRIPT_ANALYSIS: {
            // Destroy the previous buffers
            const [scriptKey, buffers, cursor] = action.value;
            const prevScript = state.scripts[scriptKey];
            if (!prevScript) {
                return state;
            }
            // Store the new buffers
            prevScript.processed.destroy(prevScript.processed);
            const next: SessionState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...prevScript,
                        processed: buffers,
                        statistics: rotateStatistics(prevScript.statistics, prevScript.script?.getStatistics() ?? null),
                        cursor,
                    },
                },
                userFocus: null,
            };

            next.userFocus = deriveScriptFocusFromCursor(scriptKey, next.scripts, state.graphViewModel, cursor);
            // Is schema script?
            if (scriptKey == ScriptKey.SCHEMA_SCRIPT) {
                // Update the catalog since the schema might have changed
                next.connectionCatalog!.loadScript(state.scripts[ScriptKey.SCHEMA_SCRIPT].script!, SCHEMA_SCRIPT_CATALOG_RANK);
                // Update the main script since the schema graph depends on it
                const mainData = next.scripts[ScriptKey.MAIN_SCRIPT];
                const newMain = { ...mainData };
                newMain.processed = analyzeScript(mainData.processed, mainData.script!);
                newMain.statistics = rotateStatistics(newMain.statistics, mainData.script!.getStatistics());
                next.scripts[ScriptKey.MAIN_SCRIPT] = newMain;
            }
            return computeSchemaGraph(next);
        }
        case UPDATE_SCRIPT_CURSOR: {
            // Destroy previous cursor
            const [scriptKey, cursor] = action.value;
            const prevScript = state.scripts[scriptKey];
            if (!prevScript) {
                return state;
            }
            // Store new cursor
            const newState: SessionState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...prevScript,
                        cursor,
                    },
                },
                userFocus: null,
            };
            newState.userFocus = deriveScriptFocusFromCursor(scriptKey, newState.scripts, state.graphViewModel, cursor);
            return newState;
        }

        case REPLACE_SCRIPT_CONTENT: {
            const next = {
                ...state,
            };
            // Update the scripts
            const main = next.scripts[ScriptKey.MAIN_SCRIPT];
            const schema = next.scripts[ScriptKey.SCHEMA_SCRIPT];
            try {
                // Replace the schema
                const newSchema = action.value[ScriptKey.SCHEMA_SCRIPT];
                if (schema && schema.script && newSchema) {
                    schema.processed.destroy(schema.processed);
                    schema.script.replaceText(newSchema);
                    const analyzed = parseAndAnalyzeScript(schema.script);
                    // Update the catalog
                    next.connectionCatalog!.loadScript(schema.script, SCHEMA_SCRIPT_CATALOG_RANK);
                    // Update the state
                    next.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                        ...next.scripts[ScriptKey.SCHEMA_SCRIPT],
                        scriptVersion: ++schema.scriptVersion,
                        processed: analyzed,
                        statistics: rotateStatistics(schema.statistics, schema.script!.getStatistics() ?? null),
                        cursor: null,
                    };
                }
                // Replace the main script
                const newMain = action.value[ScriptKey.MAIN_SCRIPT];
                if (main && main.script && newMain) {
                    main.processed.destroy(main.processed);
                    main.script.replaceText(newMain);
                    const analysis = parseAndAnalyzeScript(main.script);
                    // Update the state
                    next.scripts[ScriptKey.MAIN_SCRIPT] = {
                        ...main,
                        scriptVersion: ++main.scriptVersion,
                        processed: analysis,
                        statistics: rotateStatistics(main.statistics, main.script!.getStatistics() ?? null),
                        cursor: null,
                    };
                }
            } catch (e: any) {
                console.warn(e);
            }
            // Update the schema graph
            return computeSchemaGraph(next);
        }

        case LOAD_SCRIPTS: {
            const next = { ...state };
            for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                if (!action.value[key]) continue;
                // Destroy previous analysis & script
                const prev = state.scripts[key];
                prev.processed.destroy(prev.processed);
                // Update the script metadata
                const metadata = action.value[key];
                next.scripts[key] = {
                    scriptKey: key,
                    scriptVersion: ++prev.scriptVersion,
                    script: prev.script,
                    metadata: metadata,
                    loading: {
                        status: ScriptLoadingStatus.PENDING,
                        error: null,
                        startedAt: null,
                        finishedAt: null,
                    },
                    processed: {
                        scanned: null,
                        parsed: null,
                        analyzed: null,
                        destroy: () => { },
                    },
                    cursor: null,
                    statistics: Immutable.List(),
                };
            }
            return next;
        }
        case SCRIPT_LOADING_STARTED:
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [action.value]: {
                        ...state.scripts[action.value],
                        loading: {
                            status: ScriptLoadingStatus.STARTED,
                            startedAt: new Date(),
                            finishedAt: null,
                            error: null,
                        },
                    },
                },
            };
        case SCRIPT_LOADING_FAILED: {
            const prevScript = state.scripts[action.value[0]];
            if (!prevScript) {
                return state;
            }
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [action.value[0]]: {
                        ...prevScript,
                        loading: {
                            status: ScriptLoadingStatus.FAILED,
                            startedAt: prevScript.loading.startedAt,
                            finishedAt: new Date(),
                            error: action.value[1],
                        },
                    },
                },
            };
        }
        case SCRIPT_LOADING_SUCCEEDED: {
            const [scriptKey, content] = action.value;
            const prevScript = state.scripts[scriptKey];
            if (!prevScript) {
                return state;
            }
            // Create new state
            const next = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...prevScript,
                        loading: {
                            status: ScriptLoadingStatus.SUCCEEDED,
                            startedAt: prevScript.loading.startedAt,
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
                        // Destroy the old buffers
                        const prev = next.scripts[ScriptKey.MAIN_SCRIPT];
                        prev.processed.destroy(prev.processed);
                        // Analyze the new script
                        const script = prev.script!;
                        script.replaceText(content);
                        const analysis = parseAndAnalyzeScript(script);
                        // Update the state
                        next.scripts[ScriptKey.MAIN_SCRIPT] = {
                            ...prev,
                            scriptVersion: ++prev.scriptVersion,
                            processed: analysis,
                            statistics: rotateStatistics(prev.statistics, script.getStatistics() ?? null),
                        };
                        break;
                    }
                    case ScriptKey.SCHEMA_SCRIPT: {
                        // Destroy the old script and buffers
                        const prev = next.scripts[ScriptKey.SCHEMA_SCRIPT];
                        prev.processed.destroy(prev.processed);
                        // Analyze the new schema
                        const script = prev.script!;
                        script.replaceText(content);
                        const schemaAnalyzed = parseAndAnalyzeScript(script);
                        // Update the catalog
                        next.connectionCatalog!.loadScript(script, SCHEMA_SCRIPT_CATALOG_RANK);
                        // We updated the schema script, do we have to re-analyze the main script?
                        const main = next.scripts[ScriptKey.MAIN_SCRIPT];
                        if (main.script && main.processed.parsed != null) {
                            // Analyze the old main script with the new schema
                            const mainAnalyzed = analyzeScript(main.processed, main.script);
                            // Store the new main script
                            next.scripts[ScriptKey.MAIN_SCRIPT] = {
                                ...main,
                                scriptVersion: ++prev.scriptVersion,
                                processed: mainAnalyzed,
                                statistics: rotateStatistics(main.statistics, main.script.getStatistics() ?? null),
                            };
                        }
                        next.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                            ...next.scripts[ScriptKey.SCHEMA_SCRIPT],
                            scriptVersion: ++prev.scriptVersion,
                            processed: schemaAnalyzed,
                            statistics: rotateStatistics(prev.statistics, script.getStatistics() ?? null),
                        };
                        break;
                    }
                }
            } catch (e: any) {
                console.error(e);
                next.scripts[scriptKey] = {
                    ...next.scripts[scriptKey],
                    loading: {
                        status: ScriptLoadingStatus.FAILED,
                        startedAt: prevScript.loading.startedAt,
                        finishedAt: new Date(),
                        error: e,
                    },
                };
            }
            return computeSchemaGraph(next);
        }

        case REGISTER_EDITOR_QUERY:
            return {
                ...state,
                editorQuery: action.value
            };
        case FOCUS_QUERY_GRAPH_NODE:
            return focusGraphNode(state, action.value);
        case FOCUS_QUERY_GRAPH_EDGE:
            return focusGraphEdge(state, action.value);
        case RESIZE_QUERY_GRAPH:
            return computeSchemaGraph({
                ...state,
                graphConfig: {
                    ...state.graphConfig,
                    boardWidth: action.value[0],
                    boardHeight: action.value[1],
                },
            });
    }
}

/// Compute a schema graph
function computeSchemaGraph(state: SessionState, debug?: boolean): SessionState {
    const main = state.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
    if (main == null || main.script == null || main.processed.analyzed == null) {
        return state;
    }
    state.graph!.configure(state.graphConfig);
    state.graphLayout?.delete();
    state.graphLayout = state.graph!.loadScript(main.script);
    state.graphViewModel = computeGraphViewModel(state);
    return state;
}

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
