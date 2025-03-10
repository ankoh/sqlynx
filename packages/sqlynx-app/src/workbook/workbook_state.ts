import * as sqlynx from '@ankoh/sqlynx-core';
import * as proto from '@ankoh/sqlynx-protobuf';

import Immutable from 'immutable';

import { ScriptMetadata, ScriptOriginType, ScriptType } from './script_metadata.js';
import { ScriptLoadingStatus } from './script_loader.js';
import { parseAndAnalyzeScript, SQLynxScriptBuffers } from '../view/workbook/sqlynx_processor.js';
import { ScriptLoadingInfo } from './script_loader.js';
import { deriveFocusFromCompletionCandidates, deriveFocusFromScriptCursor, FOCUSED_COMPLETION, UserFocus } from './focus.js';
import { ConnectorInfo } from '../connection/connector_info.js';
import { VariantKind } from '../utils/index.js';

/// The script key
export type ScriptKey = number;

/// The state of the workbook
export interface WorkbookState {
    /// The workbook id
    workbookId: number;
    /// The workbook state contains many references into the Wasm heap.
    /// It therefore makes sense that script state users resolve the "right" module through here.
    instance: sqlynx.SQLynx | null;
    /// The connector info
    connectorInfo: ConnectorInfo;
    /// The connector state
    connectionId: number;
    /// The connection catalog
    connectionCatalog: sqlynx.SQLynxCatalog;
    /// The scripts
    scripts: {
        [scriptKey: number]: ScriptData
    };
    /// The workbook entries.
    /// A workbook defines a layout for a set of scripts and links script data to query executions.
    workbookEntries: WorkbookEntry[]
    /// The selected workbook entry
    selectedWorkbookEntry: number;
    /// The user focus info (if any)
    userFocus: UserFocus | null;
}

/// A workbook workbook entry
export interface WorkbookEntry {
    /// The script key of this workbook entry
    scriptKey: ScriptKey;
    /// The latest query id (if the script was executed)
    queryId: number | null;
    /// The title of the workbook entry
    title: string | null;
}

/// A script data
export interface ScriptData {
    /// The script key
    scriptKey: number;
    /// The script
    script: sqlynx.SQLynxScript | null;
    /// The metadata
    metadata: ScriptMetadata;
    /// The loading info
    loading: ScriptLoadingInfo;
    /// The processed scripts
    processed: SQLynxScriptBuffers;
    /// The analysis was done against an outdated catalog?
    outdatedAnalysis: boolean;
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
export function destroyState(state: WorkbookState): WorkbookState {
    for (const key in state.scripts) {
        const script = state.scripts[key];
        script.processed.destroy(script.processed);
        for (const stats of script.statistics) {
            stats.delete();
        }
        script.script?.delete();
    }
    return state;
}

export const DESTROY = Symbol('DESTROY');
export const RESTORE_WORKBOOK = Symbol('RESTORE_WORKBOOK');
export const UPDATE_SCRIPT = Symbol('UPDATE_SCRIPT');
export const UPDATE_SCRIPT_ANALYSIS = Symbol('UPDATE_SCRIPT_ANALYSIS');
export const UPDATE_SCRIPT_CURSOR = Symbol('UPDATE_SCRIPT_CURSOR');
export const CATALOG_DID_UPDATE = Symbol('CATALOG_DID_UPDATE');
export const COMPLETION_STARTED = Symbol('SCRIPT_COMPLETION_STARTED')
export const COMPLETION_CHANGED = Symbol('COMPLETION_CHANGED')
export const COMPLETION_STOPPED = Symbol('COMPLETION_STOPPED')
export const SCRIPT_LOADING_STARTED = Symbol('SCRIPT_LOADING_STARTED');
export const SCRIPT_LOADING_SUCCEEDED = Symbol('SCRIPT_LOADING_SUCCEEDED');
export const SCRIPT_LOADING_FAILED = Symbol('SCRIPT_LOADING_FAILED');
export const REGISTER_QUERY = Symbol('REGISTER_QUERY');

export type WorkbookStateAction =
    | VariantKind<typeof DESTROY, null>
    | VariantKind<typeof RESTORE_WORKBOOK, proto.sqlynx_workbook.pb.Workbook>
    | VariantKind<typeof UPDATE_SCRIPT, ScriptKey>
    | VariantKind<typeof UPDATE_SCRIPT_ANALYSIS, [ScriptKey, SQLynxScriptBuffers, sqlynx.proto.ScriptCursorT]>
    | VariantKind<typeof UPDATE_SCRIPT_CURSOR, [ScriptKey, sqlynx.proto.ScriptCursorT]>
    | VariantKind<typeof CATALOG_DID_UPDATE, null>
    | VariantKind<typeof COMPLETION_STARTED, [ScriptKey, sqlynx.proto.CompletionT]>
    | VariantKind<typeof COMPLETION_CHANGED, [ScriptKey, sqlynx.proto.CompletionT, number]>
    | VariantKind<typeof COMPLETION_STOPPED, ScriptKey>
    | VariantKind<typeof SCRIPT_LOADING_STARTED, ScriptKey>
    | VariantKind<typeof SCRIPT_LOADING_SUCCEEDED, [ScriptKey, string]>
    | VariantKind<typeof SCRIPT_LOADING_FAILED, [ScriptKey, any]>
    | VariantKind<typeof REGISTER_QUERY, [number, ScriptKey, number]>;

const SCHEMA_SCRIPT_CATALOG_RANK = 1e9;
const STATS_HISTORY_LIMIT = 20;

export function reduceWorkbookState(state: WorkbookState, action: WorkbookStateAction): WorkbookState {
    switch (action.type) {
        case DESTROY:
            return destroyState({ ...state });

        case RESTORE_WORKBOOK: {
            // Stop if there's no instance set
            if (!state.instance) {
                return state;
            }
            // Shallow copy the workbook root
            const next = {
                ...state,
            };
            // Delete all old scripts
            for (const k in next.scripts) {
                const script = next.scripts[k];
                // Unload the script from the catalog (if it's a schema script)
                if (script.script && script.metadata.scriptType === ScriptType.SCHEMA) {
                    next.connectionCatalog.dropScript(script.script);
                }
                // Delete the script data
                deleteScriptData(script);
            }
            next.scripts = {};

            // Load all scripts
            for (const s of action.value.scripts) {
                const script = next.instance!.createScript(next.connectionCatalog, s.scriptId);
                script!.replaceText(s.scriptText);

                const metadata: ScriptMetadata = {
                    scriptId: null,
                    schemaRef: null,
                    scriptType: s.scriptType == proto.sqlynx_workbook.pb.ScriptType.Schema ? ScriptType.SCHEMA : ScriptType.QUERY,
                    originType: ScriptOriginType.LOCAL,
                    httpURL: null,
                    annotations: null,
                    immutable: false,
                };

                const scriptData: ScriptData = {
                    scriptKey: s.scriptId,
                    script,
                    metadata,
                    loading: {
                        status: ScriptLoadingStatus.SUCCEEDED,
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
                    outdatedAnalysis: true,
                    statistics: Immutable.List(),
                    cursor: null,
                    completion: null,
                    selectedCompletionCandidate: null,
                }
                next.scripts[s.scriptId] = scriptData;
            };

            // First analyze all schema scripts
            for (const k in next.scripts) {
                const s = next.scripts[k];
                if (s.metadata.scriptType == ScriptType.SCHEMA) {
                    s.processed = parseAndAnalyzeScript(s.script!);
                    s.statistics = rotateStatistics(s.statistics, s.script!.getStatistics() ?? null);
                    s.outdatedAnalysis = false;
                    next.connectionCatalog.loadScript(s.script!, SCHEMA_SCRIPT_CATALOG_RANK);
                }
            }

            // All other scripts are marked via `outdatedAnalysis`
            return next;
        }

        case CATALOG_DID_UPDATE: {
            const scripts = { ...state.scripts };
            for (const scriptKey in scripts) {
                const prev = scripts[scriptKey];
                scripts[scriptKey] = {
                    ...prev,
                    outdatedAnalysis: true
                };
            }
            return {
                ...state,
                scripts
            };
        }

        case UPDATE_SCRIPT: {
            const scriptKey = action.value;
            const script = state.scripts[scriptKey];
            if (!script) {
                return state;
            }

            // Is the script outdated?
            if (script.outdatedAnalysis) {
                const copy = { ...script };
                copy.processed.destroy(copy.processed);
                copy.processed = parseAndAnalyzeScript(copy.script!);
                copy.statistics = rotateStatistics(copy.statistics, copy.script!.getStatistics() ?? null);
                copy.outdatedAnalysis = false;

                // Update the cursor?
                if (copy.script && copy.cursor != null) {
                    const ofs = copy.cursor.textOffset;
                    const cursorBuffer = copy.script.moveCursor(ofs);
                    copy.cursor = cursorBuffer.read().unpack();
                    cursorBuffer.delete();
                }

                // Create the next script
                const next = {
                    ...state,
                    scripts: {
                        ...state.scripts,
                        [copy.scriptKey]: copy
                    }
                };

                // Update the user focus
                if (next.userFocus != null && copy.cursor != null) {
                    next.userFocus = deriveFocusFromScriptCursor(scriptKey, copy, copy.cursor);
                }
                return next;
            }
            return state;
        }

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
            const next: WorkbookState = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...prevScript,
                        processed: buffers,
                        outdatedAnalysis: false,
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
            if (scriptData.metadata.scriptType == ScriptType.SCHEMA) {
                // Update the catalog since the schema might have changed
                next.connectionCatalog!.loadScript(scriptData.script!, SCHEMA_SCRIPT_CATALOG_RANK);
                // Mark all query scripts as outdated
                for (const key in next.scripts) {
                    const script = next.scripts[key];
                    if (script.metadata.scriptType == ScriptType.QUERY) {
                        next.scripts[key] = {
                            ...script,
                            outdatedAnalysis: true
                        };
                    }
                }
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
            const newState: WorkbookState = {
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
                // Destroy the old buffers
                prevScript.processed.destroy(prevScript.processed);

                // Analyze the new script
                const script = prevScript.script!;
                script.replaceText(content);
                const analysis = parseAndAnalyzeScript(script);

                // Update the script data
                const prev = next.scripts[scriptKey];
                next.scripts[scriptKey] = {
                    ...prev,
                    processed: analysis,
                    statistics: rotateStatistics(prev.statistics, script.getStatistics() ?? null),
                };

                // Did we load a schema script?
                if (prevScript.metadata.scriptType == ScriptType.SCHEMA) {
                    // Load the script into the catalog
                    next.connectionCatalog.loadScript(script, SCHEMA_SCRIPT_CATALOG_RANK);

                    // Mark all query scripts as outdated
                    for (const key in next.scripts) {
                        const script = next.scripts[key];
                        if (script.metadata.scriptType == ScriptType.QUERY) {
                            next.scripts[key] = {
                                ...script,
                                outdatedAnalysis: true
                            };
                        }
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

        case REGISTER_QUERY: {
            const [entryId, scriptKey, queryId] = action.value;
            if (entryId >= state.workbookEntries.length) {
                console.warn("orphan query references invalid workbook entry");
                return state;
            } else if (state.workbookEntries[entryId].scriptKey != scriptKey) {
                console.warn("orphan query references invalid workbook script");
                return state;
            } else {
                const entries = [...state.workbookEntries];
                entries[entryId] = { ...entries[entryId], queryId };
                return {
                    ...state,
                    workbookEntries: entries
                };
            }
        }

        case COMPLETION_STARTED: {
            const [targetKey, completion] = action.value;
            const scripts = { ...state.scripts };
            let userFocus: UserFocus | null = null;
            for (const k in state.scripts) {
                const data = scripts[k];
                if (data.scriptKey == targetKey) {
                    let scriptData = {
                        ...data,
                        completion: completion,
                        selectedCompletionCandidate: 0
                    };
                    userFocus = deriveFocusFromCompletionCandidates(targetKey, scriptData);
                    scripts[data.scriptKey] = scriptData;
                } else if (data.completion != null) {
                    scripts[data.scriptKey] = {
                        ...data,
                        completion: null,
                        selectedCompletionCandidate: null
                    };
                }
            }
            return {
                ...state,
                scripts: scripts,
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
            for (const k in state.scripts) {
                const data = scripts[k];
                // XXX scriptKey check is unnecessary
                if (data.scriptKey == action.value || data.completion != null) {
                    scripts[data.scriptKey] = {
                        ...data,
                        completion: null,
                        selectedCompletionCandidate: null
                    };
                }
            }
            const next: WorkbookState = { ...state, scripts: scripts, userFocus: null };
            let scriptData = next.scripts[action.value];
            if (scriptData != null && scriptData.cursor) {
                next.userFocus = deriveFocusFromScriptCursor(action.value, scriptData, scriptData.cursor);
            }
            return next;
        }
    }
}

function deleteScriptData(data: ScriptData) {
    data.processed.destroy(data.processed);
    data.script?.delete();
    for (const stats of data.statistics) {
        stats.delete();
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
