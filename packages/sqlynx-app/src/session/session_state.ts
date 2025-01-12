import * as sqlynx from '@ankoh/sqlynx-core';

import Immutable from 'immutable';

import { ScriptMetadata } from './script_metadata.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { analyzeScript, parseAndAnalyzeScript, SQLynxScriptBuffers } from '../view/editor/sqlynx_processor.js';
import { ScriptLoadingInfo } from './script_loader.js';
import { deriveFocusFromCompletionCandidates, deriveFocusFromScriptCursor, FOCUSED_COMPLETION, UserFocus } from './focus.js';
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
    /// The connection catalog
    connectionCatalog: sqlynx.SQLynxCatalog;
    /// The scripts (main or external)
    scripts: { [id: number]: ScriptData };
    /// The running queries of this session
    runningQueries: Set<number>;
    /// The finished queries of this session
    finishedQueries: number[];
    /// The id of the latest query fired through the editor
    editorQuery: number | null;
    /// The user focus info
    userFocus: UserFocus | null;
}

/// The script data
export interface ScriptData {
    /// The script key
    scriptKey: ScriptKey;
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
    cursor: sqlynx.proto.ScriptCursorT | null;
    /// The completion
    completion: sqlynx.proto.CompletionT | null;
    /// The selected completion candidate
    selectedCompletionCandidate: number | null;
}

/// Destroy a state
export function destroyState(state: SessionState): SessionState {
    const main = state.scripts[ScriptKey.MAIN_SCRIPT];
    const schema = state.scripts[ScriptKey.SCHEMA_SCRIPT];
    main.processed.destroy(main.processed);
    schema.processed.destroy(schema.processed);
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

export const COMPLETION_STARTED = Symbol('SCRIPT_COMPLETION_STARTED')
export const COMPLETION_CHANGED = Symbol('COMPLETION_CHANGED')
export const COMPLETION_STOPPED = Symbol('COMPLETION_STOPPED')

export const LOAD_SCRIPTS = Symbol('LOAD_SCRIPTS');
export const SCRIPT_LOADING_STARTED = Symbol('SCRIPT_LOADING_STARTED');
export const SCRIPT_LOADING_SUCCEEDED = Symbol('SCRIPT_LOADING_SUCCEEDED');
export const SCRIPT_LOADING_FAILED = Symbol('SCRIPT_LOADING_FAILED');

export const REGISTER_EDITOR_QUERY = Symbol('REGISTER_EDITOR_QUERY');

export type SessionStateAction =
    | VariantKind<typeof DESTROY, null>
    | VariantKind<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, SQLynxScriptBuffers, sqlynx.proto.ScriptCursorT]>
    | VariantKind<typeof UPDATE_SCRIPT_CURSOR, [ScriptKey, sqlynx.proto.ScriptCursorT]>
    | VariantKind<typeof REPLACE_SCRIPT_CONTENT, { [key: number]: string }>
    | VariantKind<typeof COMPLETION_STARTED, [ScriptKey, sqlynx.proto.CompletionT]>
    | VariantKind<typeof COMPLETION_CHANGED, [ScriptKey, sqlynx.proto.CompletionT, number]>
    | VariantKind<typeof COMPLETION_STOPPED, ScriptKey>
    | VariantKind<typeof LOAD_SCRIPTS, { [key: number]: ScriptMetadata }>
    | VariantKind<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | VariantKind<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | VariantKind<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
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
            const prevFocus = state.userFocus;
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

            let scriptData = next.scripts[scriptKey];
            if (scriptData != null) {
                // Previous completion?
                if (prevFocus?.focusTarget?.type == FOCUSED_COMPLETION) {
                    // Keep old events
                    // XXX This assumes that keeping a stale user focus is NOT doing any harm!
                    next.userFocus = state.userFocus;
                } else {
                    // Otherwise derive a new user focus
                    next.userFocus = deriveFocusFromScriptCursor(scriptKey, scriptData, cursor);
                }
            }
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
            return next;
        }
        case UPDATE_SCRIPT_CURSOR: {
            // Destroy previous cursor
            const [scriptKey, cursor] = action.value;
            const prevScript = state.scripts[scriptKey];
            if (!prevScript) {
                return state;
            }
            // Store new cursor
            const newScriptData: ScriptData = {
                ...prevScript,
                cursor,
            };
            const newState: SessionState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: newScriptData,
                },
                userFocus: null,
            };
            newState.userFocus = deriveFocusFromScriptCursor(scriptKey, newScriptData, cursor);
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
                        processed: analysis,
                        statistics: rotateStatistics(main.statistics, main.script!.getStatistics() ?? null),
                        cursor: null,
                    };
                }
            } catch (e: any) {
                console.warn(e);
            }
            // Update the schema graph
            return next;
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
                    completion: null,
                    selectedCompletionCandidate: null,
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
            const [scriptKey, error] = action.value;
            const prevScript = state.scripts[scriptKey];
            if (!prevScript) {
                return state;
            }
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...prevScript,
                        loading: {
                            status: ScriptLoadingStatus.FAILED,
                            startedAt: prevScript.loading.startedAt,
                            finishedAt: new Date(),
                            error,
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
                                processed: mainAnalyzed,
                                statistics: rotateStatistics(main.statistics, main.script.getStatistics() ?? null),
                            };
                        }
                        next.scripts[ScriptKey.SCHEMA_SCRIPT] = {
                            ...next.scripts[ScriptKey.SCHEMA_SCRIPT],
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
            return next;
        }

        case REGISTER_EDITOR_QUERY:
            return {
                ...state,
                editorQuery: action.value
            };

        case COMPLETION_STARTED: {
            const [targetKey, completion] = action.value;
            const scripts = { ...state.scripts };
            let userFocus: UserFocus | null = null;
            for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                const data = scripts[key];
                if (data) {
                    if (key == targetKey) {
                        let scriptData = {
                            ...data,
                            completion: completion,
                            selectedCompletionCandidate: 0
                        };
                        userFocus = deriveFocusFromCompletionCandidates(targetKey, scriptData);
                        scripts[key] = scriptData;
                    } else if (data.completion != null) {
                        scripts[key] = {
                            ...data,
                            completion: null,
                            selectedCompletionCandidate: null
                        };
                    }
                }
            }
            return {
                ...state,
                scripts,
                userFocus
            };
        }
        case COMPLETION_CHANGED: {
            const [key, completion, index] = action.value;
            const scriptData: ScriptData = {
                ...state.scripts[key],
                completion: completion,
                selectedCompletionCandidate: index
            };
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [key]: scriptData,
                },
                userFocus: deriveFocusFromCompletionCandidates(key, scriptData),
            };
        }
        case COMPLETION_STOPPED: {
            const scripts = { ...state.scripts };
            for (const key of [ScriptKey.MAIN_SCRIPT, ScriptKey.SCHEMA_SCRIPT]) {
                const data = scripts[key];
                if (data) {
                    if (key == action.value || data.completion != null) {
                        scripts[key] = {
                            ...data,
                            completion: null,
                            selectedCompletionCandidate: null
                        };
                    }
                }
            }
            const next: SessionState = { ...state, scripts, userFocus: null };
            let scriptData = next.scripts[action.value];
            if (scriptData != null && scriptData.cursor) {
                next.userFocus = deriveFocusFromScriptCursor(action.value, scriptData, scriptData.cursor);
            }
            return next;
        }
    }
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
