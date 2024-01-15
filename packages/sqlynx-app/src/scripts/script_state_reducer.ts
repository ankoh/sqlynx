import * as arrow from 'apache-arrow';
import * as sqlynx from '@ankoh/sqlynx';
import * as React from 'react';

import Immutable from 'immutable';

import { SQLynxScriptBuffers, analyzeScript, parseAndAnalyzeScript } from '../view/editor/sqlynx_processor';
import { ScriptState, ScriptKey, createEmptyScript, destroyState } from './script_state';
import { deriveScriptFocusFromCursor, focusGraphEdge, focusGraphNode } from './focus';
import { VariantKind, Dispatch } from '../utils/variant';
import { ScriptMetadata } from './script_metadata';
import { ScriptLoadingStatus } from './script_loader';
import { GraphConnectionId, GraphNodeDescriptor, computeGraphViewModel } from '../view/schema/graph_view_model';
import {
    CatalogUpdateRequestVariant,
    CatalogUpdateTaskState,
    CatalogUpdateTaskStatus,
} from '../connectors/catalog_update';
import {
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionTaskState,
    QueryExecutionTaskStatus,
    QueryExecutionTaskVariant,
} from '../connectors/query_execution';

export const INITIALIZE = Symbol('INITIALIZE');
export const DESTROY = Symbol('DESTROY');

export const UPDATE_SCRIPT_ANALYSIS = Symbol('UPDATE_SCRIPT_ANALYSIS');
export const UPDATE_SCRIPT_CURSOR = Symbol('UPDATE_SCRIPT_CURSOR');

export const LOAD_SCRIPTS = Symbol('LOAD_SCRIPTS');
export const SCRIPT_LOADING_STARTED = Symbol('SCRIPT_LOADING_STARTED');
export const SCRIPT_LOADING_SUCCEEDED = Symbol('SCRIPT_LOADING_SUCCEEDED');
export const SCRIPT_LOADING_FAILED = Symbol('SCRIPT_LOADING_FAILED');

export const UPDATE_CATALOG = Symbol('UPDATE_CATALOG');
export const CATALOG_UPDATE_STARTED = Symbol('CATALOG_UPDATE_STARTED');
export const CATALOG_UPDATE_SUCCEEDED = Symbol('CATALOG_UPDATE_SUCCEEDED');
export const CATALOG_UPDATE_FAILED = Symbol('CATALOG_UPDATE_FAILED');
export const CATALOG_UPDATE_CANCELLED = Symbol('CATALOG_UPDATE_CANCELLED');

export const EXECUTE_QUERY = Symbol('EXECUTE_QUERY');
export const QUERY_EXECUTION_ACCEPTED = Symbol('QUERY_EXECUTION_ACCEPTED');
export const QUERY_EXECUTION_STARTED = Symbol('QUERY_EXECUTION_STARTED');
export const QUERY_EXECUTION_PROGRESS_UPDATED = Symbol('QUERY_EXECUTION_PROGRESS_UPDATED');
export const QUERY_EXECUTION_RECEIVED_SCHEMA = Symbol('QUERY_EXECUTION_RECEIVED_SCHEMA');
export const QUERY_EXECUTION_RECEIVED_BATCH = Symbol('QUERY_EXECUTION_RECEIVED_BATCH');
export const QUERY_EXECUTION_SUCCEEDED = Symbol('QUERY_EXECUTION_SUCCEEDED');
export const QUERY_EXECUTION_FAILED = Symbol('QUERY_EXECUTION_FAILED');
export const QUERY_EXECUTION_CANCELLED = Symbol('QUERY_EXECUTION_CANCELLED');

export const FOCUS_QUERY_GRAPH_NODE = Symbol('FOCUS_GRAPH_NODE');
export const FOCUS_QUERY_GRAPH_EDGE = Symbol('FOCUS_GRAPH_EDGE');
export const RESIZE_QUERY_GRAPH = Symbol('RESIZE_EDITOR');

export type ScriptStateAction =
    | VariantKind<typeof INITIALIZE, sqlynx.SQLynx>
    | VariantKind<typeof DESTROY, null>
    | VariantKind<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, SQLynxScriptBuffers, sqlynx.proto.ScriptCursorInfoT]>
    | VariantKind<typeof UPDATE_SCRIPT_CURSOR, [ScriptKey, sqlynx.proto.ScriptCursorInfoT]>
    | VariantKind<typeof LOAD_SCRIPTS, { [key: number]: ScriptMetadata }>
    | VariantKind<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | VariantKind<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | VariantKind<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
    | VariantKind<typeof UPDATE_CATALOG, CatalogUpdateRequestVariant>
    | VariantKind<typeof CATALOG_UPDATE_STARTED, CatalogUpdateTaskState[]>
    | VariantKind<typeof CATALOG_UPDATE_CANCELLED, number>
    | VariantKind<typeof CATALOG_UPDATE_SUCCEEDED, number>
    | VariantKind<typeof CATALOG_UPDATE_FAILED, [number, any]>
    | VariantKind<typeof EXECUTE_QUERY, QueryExecutionTaskVariant>
    | VariantKind<typeof QUERY_EXECUTION_ACCEPTED, QueryExecutionTaskState>
    | VariantKind<typeof QUERY_EXECUTION_STARTED, QueryExecutionResponseStream>
    | VariantKind<typeof QUERY_EXECUTION_PROGRESS_UPDATED, QueryExecutionProgress>
    | VariantKind<typeof QUERY_EXECUTION_RECEIVED_SCHEMA, arrow.Schema>
    | VariantKind<typeof QUERY_EXECUTION_RECEIVED_BATCH, arrow.RecordBatch>
    | VariantKind<typeof QUERY_EXECUTION_SUCCEEDED, arrow.RecordBatch | null>
    | VariantKind<typeof QUERY_EXECUTION_FAILED, any>
    | VariantKind<typeof QUERY_EXECUTION_CANCELLED, null>
    | VariantKind<typeof FOCUS_QUERY_GRAPH_NODE, GraphNodeDescriptor | null>
    | VariantKind<typeof FOCUS_QUERY_GRAPH_EDGE, GraphConnectionId.Value | null>
    | VariantKind<typeof RESIZE_QUERY_GRAPH, [number, number]>; // width, height

const SCHEMA_SCRIPT_CATALOG_RANK = 1e9;
const STATS_HISTORY_LIMIT = 20;

/// ATTENTION
///
/// React reducers do not play nice together with the "impure" side-effects through state held in Wasm.
/// When running react in strict mode, React will call our reducers multiple times with the same state.
/// Moving all interactions and memory management OUT of the reducer is far too painful and nothing we want to do.
///
/// We therefore bypass the "pureness" rules for the top-level state and use a single global state instead.

let GLOBAL_STATE: ScriptState = createDefaultState();

function createDefaultState(): ScriptState {
    const DEFAULT_BOARD_WIDTH = 800;
    const DEFAULT_BOARD_HEIGHT = 600;
    return {
        instance: null,
        scripts: {},
        nextCatalogUpdateId: 1,
        catalogUpdateRequests: Immutable.Map(),
        catalogUpdates: Immutable.Map(),
        catalog: null,
        graph: null,
        graphConfig: {
            boardWidth: DEFAULT_BOARD_WIDTH,
            boardHeight: DEFAULT_BOARD_HEIGHT,
            cellWidth: 120,
            cellHeight: 64,
            tableWidth: 180,
            tableHeight: 36,
        },
        graphLayout: null,
        graphViewModel: {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
            boundaries: {
                minX: 0,
                maxX: 0,
                minY: 0,
                maxY: 0,
                totalWidth: 0,
                totalHeight: 0,
            },
        },
        userFocus: null,
        queryExecutionRequested: false,
        queryExecutionState: null,
        queryExecutionResult: null,
    };
}

export function useGlobalScriptState(): [ScriptState, Dispatch<ScriptStateAction>] {
    const [state, setState] = React.useState(GLOBAL_STATE);
    const reducer = React.useCallback(
        (action: ScriptStateAction) => {
            GLOBAL_STATE = reduceScriptState(GLOBAL_STATE, action);
            setState(GLOBAL_STATE);
        },
        [setState],
    );
    return [state, reducer];
}

function reduceScriptState(state: ScriptState, action: ScriptStateAction): ScriptState {
    switch (action.type) {
        case INITIALIZE: {
            const lnx = action.value;
            const catalog = lnx.createCatalog();
            const mainScript = lnx.createScript(catalog, ScriptKey.MAIN_SCRIPT);
            const schemaScript = lnx.createScript(catalog, ScriptKey.SCHEMA_SCRIPT);
            const graph = lnx.createQueryGraphLayout();
            const next: ScriptState = {
                ...state,
                instance: lnx,
                catalog,
                scripts: {
                    [ScriptKey.MAIN_SCRIPT]: createEmptyScript(ScriptKey.MAIN_SCRIPT, mainScript),
                    [ScriptKey.SCHEMA_SCRIPT]: createEmptyScript(ScriptKey.SCHEMA_SCRIPT, schemaScript),
                },
                graph,
            };
            return next;
        }
        case DESTROY:
            return destroyState({ ...state });

        case UPDATE_SCRIPT_ANALYSIS: {
            // Destroy the previous buffers
            const [scriptKey, buffers, cursor] = action.value;
            // Store the new buffers
            let scriptData = state.scripts[scriptKey];
            scriptData.processed.destroy(scriptData.processed);
            const next: ScriptState = {
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
                userFocus: null,
            };

            next.userFocus = deriveScriptFocusFromCursor(scriptKey, next.scripts, state.graphViewModel, cursor);
            // Is schema script?
            if (scriptKey == ScriptKey.SCHEMA_SCRIPT) {
                // Update the catalog since the schema might have changed
                next.catalog!.loadScript(state.scripts[ScriptKey.SCHEMA_SCRIPT].script!, SCHEMA_SCRIPT_CATALOG_RANK);
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
            // Store new cursor
            const newState: ScriptState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...state.scripts[scriptKey],
                        cursor,
                    },
                },
                userFocus: null,
            };
            newState.userFocus = deriveScriptFocusFromCursor(scriptKey, newState.scripts, state.graphViewModel, cursor);
            return newState;
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
                        destroy: () => {},
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
            const data = state.scripts[action.value[0]];
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [action.value[0]]: {
                        ...data,
                        loading: {
                            status: ScriptLoadingStatus.FAILED,
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
                            status: ScriptLoadingStatus.SUCCEEDED,
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
                        next.catalog!.loadScript(script, SCHEMA_SCRIPT_CATALOG_RANK);
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
                        startedAt: data.loading.startedAt,
                        finishedAt: new Date(),
                        error: e,
                    },
                };
            }
            return computeSchemaGraph(next);
        }

        case UPDATE_CATALOG: {
            const task = action.value;
            const taskId = state.nextCatalogUpdateId;
            return {
                ...state,
                nextCatalogUpdateId: taskId + 1,
                catalogUpdateRequests: state.catalogUpdateRequests.set(taskId, task),
            };
        }
        case CATALOG_UPDATE_STARTED: {
            const requests = state.catalogUpdateRequests.withMutations(requests => {
                for (const task of action.value) {
                    requests.delete(task.taskId);
                }
            });
            const updates = state.catalogUpdates.withMutations(updates => {
                for (const task of action.value) {
                    updates.set(task.taskId, task);
                }
            });
            return {
                ...state,
                catalogUpdateRequests: requests,
                catalogUpdates: updates,
            };
        }
        case CATALOG_UPDATE_CANCELLED: {
            const taskId = action.value;
            const task = state.catalogUpdates.get(taskId)!;
            return {
                ...state,
                catalogUpdates: state.catalogUpdates.set(taskId, {
                    ...task,
                    status: CatalogUpdateTaskStatus.CANCELLED,
                    finishedAt: new Date(),
                }),
            };
        }
        case CATALOG_UPDATE_FAILED: {
            const [taskId, error] = action.value;
            const task = state.catalogUpdates.get(taskId)!;
            return {
                ...state,
                catalogUpdates: state.catalogUpdates.set(taskId, {
                    ...task,
                    status: CatalogUpdateTaskStatus.FAILED,
                    error,
                    finishedAt: new Date(),
                }),
            };
        }
        case CATALOG_UPDATE_SUCCEEDED: {
            const taskId = action.value;
            const task = state.catalogUpdates.get(taskId)!;
            // XXX Trigger script updates
            return {
                ...state,
                catalogUpdates: state.catalogUpdates.set(taskId, {
                    ...task,
                    status: CatalogUpdateTaskStatus.SUCCEEDED,
                    finishedAt: new Date(),
                }),
            };
        }

        case EXECUTE_QUERY: {
            // Concurrent execution ongoing?
            // Should we force the user to cancel here?
            if (state.queryExecutionState != null && state.queryExecutionState.finishedAt == null) {
                return state;
            }
            return {
                ...state,
                queryExecutionRequested: true,
                queryExecutionState: null,
                queryExecutionResult: null,
            };
        }
        case QUERY_EXECUTION_ACCEPTED: {
            return {
                ...state,
                queryExecutionRequested: false,
                queryExecutionState: {
                    ...action.value,
                    status: QueryExecutionTaskStatus.ACCEPTED,
                    lastUpdatedAt: new Date(),
                },
                queryExecutionResult: null,
            };
        }
        case QUERY_EXECUTION_STARTED: {
            return {
                ...state,
                queryExecutionRequested: false,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    status: QueryExecutionTaskStatus.STARTED,
                    lastUpdatedAt: new Date(),
                    resultStream: action.value,
                },
                queryExecutionResult: null,
            };
        }
        case QUERY_EXECUTION_PROGRESS_UPDATED: {
            return {
                ...state,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    lastUpdatedAt: new Date(),
                    latestProgressUpdate: action.value,
                },
            };
        }
        case QUERY_EXECUTION_RECEIVED_SCHEMA: {
            return {
                ...state,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    status: QueryExecutionTaskStatus.RECEIVED_SCHEMA,
                    lastUpdatedAt: new Date(),
                    resultSchema: state.queryExecutionState!.resultSchema,
                },
            };
        }
        case QUERY_EXECUTION_RECEIVED_BATCH: {
            return {
                ...state,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    status: QueryExecutionTaskStatus.RECEIVED_FIRST_RESULT,
                    lastUpdatedAt: new Date(),
                    resultBatches: state.queryExecutionState!.resultBatches.push(action.value),
                },
            };
        }
        case QUERY_EXECUTION_SUCCEEDED: {
            const now = new Date();
            return {
                ...state,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    status: QueryExecutionTaskStatus.SUCCEEDED,
                    lastUpdatedAt: now,
                    finishedAt: now,
                },
                queryExecutionResult: null, // XXX Build arrow table
            };
        }
        case QUERY_EXECUTION_FAILED: {
            const now = new Date();
            return {
                ...state,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    status: QueryExecutionTaskStatus.FAILED,
                    lastUpdatedAt: now,
                    finishedAt: now,
                    error: action.value,
                },
            };
        }
        case QUERY_EXECUTION_CANCELLED: {
            const now = new Date();
            return {
                ...state,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    status: QueryExecutionTaskStatus.CANCELLED,
                    lastUpdatedAt: now,
                    finishedAt: now,
                    error: action.value,
                },
            };
        }

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
function computeSchemaGraph(state: ScriptState, debug?: boolean): ScriptState {
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
