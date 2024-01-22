import * as arrow from 'apache-arrow';
import * as sqlynx from '@ankoh/sqlynx';
import * as React from 'react';

import Immutable from 'immutable';

import { SQLynxScriptBuffers, analyzeScript, parseAndAnalyzeScript } from '../view/editor/sqlynx_processor';
import { ScriptState, ScriptKey, destroyState } from './script_state';
import { deriveScriptFocusFromCursor, focusGraphEdge, focusGraphNode } from './focus';
import { VariantKind } from '../utils/variant';
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
} from '../connectors/query_execution';

export const DESTROY = Symbol('DESTROY');

export const SELECT_CONNECTOR = Symbol('SELECT_CONNECTOR');
export const SELECT_NEXT_CONNECTOR = Symbol('SELECT_NEXT_CONNECTOR');

export const UPDATE_SCRIPT_ANALYSIS = Symbol('UPDATE_SCRIPT_ANALYSIS');
export const UPDATE_SCRIPT_CURSOR = Symbol('UPDATE_SCRIPT_CURSOR');
export const REPLACE_SCRIPT_CONTENT = Symbol('REPLACE_SCRIPT_CONTENT');

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
    | VariantKind<typeof DESTROY, null>
    | VariantKind<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, SQLynxScriptBuffers, sqlynx.proto.ScriptCursorInfoT]>
    | VariantKind<typeof UPDATE_SCRIPT_CURSOR, [ScriptKey, sqlynx.proto.ScriptCursorInfoT]>
    | VariantKind<typeof REPLACE_SCRIPT_CONTENT, { [key: number]: string }>
    | VariantKind<typeof LOAD_SCRIPTS, { [key: number]: ScriptMetadata }>
    | VariantKind<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | VariantKind<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | VariantKind<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
    | VariantKind<typeof UPDATE_CATALOG, CatalogUpdateRequestVariant>
    | VariantKind<typeof CATALOG_UPDATE_STARTED, CatalogUpdateTaskState[]>
    | VariantKind<typeof CATALOG_UPDATE_CANCELLED, number>
    | VariantKind<typeof CATALOG_UPDATE_SUCCEEDED, number>
    | VariantKind<typeof CATALOG_UPDATE_FAILED, [number, any]>
    | VariantKind<typeof EXECUTE_QUERY, null>
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

export function reduceScriptState(state: ScriptState, action: ScriptStateAction): ScriptState {
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
            const next: ScriptState = {
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
            const prevScript = state.scripts[scriptKey];
            if (!prevScript) {
                return state;
            }
            // Store new cursor
            const newState: ScriptState = {
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
                    next.catalog!.loadScript(schema.script, SCHEMA_SCRIPT_CATALOG_RANK);
                    // Update the state
                    next.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                        ...next.scripts[ScriptKey.SCHEMA_SCRIPT],
                        scriptVersion: ++schema.scriptVersion,
                        processed: analyzed,
                        statistics: rotateStatistics(schema.statistics, schema.script!.getStatistics() ?? null),
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
                        startedAt: prevScript.loading.startedAt,
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
            const next = {
                ...state,
                catalogUpdates: state.catalogUpdates.set(taskId, {
                    ...task,
                    status: CatalogUpdateTaskStatus.SUCCEEDED,
                    finishedAt: new Date(),
                }),
            };
            // Update the scripts
            const main = next.scripts[ScriptKey.MAIN_SCRIPT];
            const schema = next.scripts[ScriptKey.SCHEMA_SCRIPT];
            try {
                if (schema && schema.script) {
                    // Destroy the old script and buffers
                    schema.processed.destroy(schema.processed);
                    // Analyze the new schema
                    const schemaAnalyzed = parseAndAnalyzeScript(schema.script);
                    // Update the catalog
                    next.catalog!.loadScript(schema.script, SCHEMA_SCRIPT_CATALOG_RANK);
                    // Update the state
                    next.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                        ...next.scripts[ScriptKey.SCHEMA_SCRIPT],
                        scriptVersion: ++schema.scriptVersion,
                        processed: schemaAnalyzed,
                        statistics: rotateStatistics(schema.statistics, schema.script!.getStatistics() ?? null),
                    };
                }
                if (main && main.script) {
                    // Destroy the old buffers
                    main.processed.destroy(main.processed);
                    const analysis = parseAndAnalyzeScript(main.script);
                    // Update the state
                    next.scripts[ScriptKey.MAIN_SCRIPT] = {
                        ...main,
                        scriptVersion: ++main.scriptVersion,
                        processed: analysis,
                        statistics: rotateStatistics(main.statistics, main.script!.getStatistics() ?? null),
                    };
                }
            } catch (e: any) {
                console.warn(e);
            }
            // Update the schema graph
            return computeSchemaGraph(next);
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

            // XXX Build arrow table from execution state
            const columnA = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
            const columnB = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
            const columnC = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
            const table = arrow.tableFromArrays({
                A: columnA,
                B: columnB,
                C: columnC,
            });

            return {
                ...state,
                queryExecutionState: {
                    ...state.queryExecutionState!,
                    status: QueryExecutionTaskStatus.SUCCEEDED,
                    lastUpdatedAt: now,
                    finishedAt: now,
                },
                queryExecutionResult: {
                    startedAt: state.queryExecutionState!.startedAt,
                    finishedAt: state.queryExecutionState!.finishedAt,
                    latestProgressUpdate: state.queryExecutionState!.lastUpdatedAt!,
                    resultTable: table,
                },
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
