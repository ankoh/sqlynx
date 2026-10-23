import * as core from '@ankoh/dashql-core';
import * as Immutable from 'immutable';

import { DashQLCompletionState, DashQLPendingDiff, DashQLProcessorUpdateOut } from './editor/dashql_processor.js';
import { deriveFocusFromCompletionCandidates, deriveFocusFromEditorUpdate, SemanticUserFocus } from './focus.js';
import { ConnectorInfo, ConnectorType } from '../../connections/connector_info.js';
import { VariantKind } from '../../../utils/variant.js';
import {
    DEBOUNCE_DURATION_SCRIPT_WRITE,
    DEBOUNCE_DURATION_SESSION_WRITE,
    DELETE_SCRIPT as STORAGE_DELETE_SCRIPT,
    groupSessionManifestWrites,
    groupSessionScriptListWrites,
    groupScriptDeletes,
    groupScriptRenames,
    groupScriptWrites,
    RENAME_SCRIPT as STORAGE_RENAME_SCRIPT,
    StorageWriter,
    WRITE_SESSION_PROPERTIES,
    WRITE_SESSION_SCRIPTS,
    WRITE_SCRIPT,
    type SessionScriptList,
} from '../../storage/storage_writer.js';
import type { SessionSettings } from './session_settings.js';
import type { ConnectionParams, SessionConnection, SessionScript } from '../../storage/storage_backend.js';
import type { ConnectionState } from '../../connections/connection_state.js';
import { Logger, LoggerLike, LoggableException, stringifyError } from '../../../platform/logger/logger.js';
import { ScriptAnnotations, ScriptRef, SessionMetadata as SessionMetadataType, ResolvedVisualizeQuery, createEmptyAnnotations, createScriptRef, generateScriptFileName, scriptDisplayName, uniqueScriptBase } from './script_types.js';

const LOG_CTX = 'session_scripts';

/// A script key
export type ScriptKey = number;
/// A script data map
export type ScriptDataMap = { [scriptKey: number]: ScriptData };
/// A session user focus
export interface ScriptFocus {
    /// The file name of the selected cell (empty if none)
    fileName: string;
}

/// The runtime state of a session's scripts
export interface SessionScripts {
    /// Session scripts contain many references into the Wasm heap.
    /// Consumers therefore resolve the "right" module through here.
    instance: core.DashQL;
    /// The session identifier.
    sessionId: string;
    /// The user-supplied session name, independent from attached database identity.
    name: string | null;
    /// The session settings.
    settings: SessionSettings;
    /// The default connection of the session, the main database. New scripts use it.
    connectionId: string;
    /// The session metadata
    sessionMetadata: SessionMetadataType;
    /// The connector info of the default connection
    connectorInfo: ConnectorInfo;
    /// The catalog of the default connection
    connectionCatalog: core.DashQLCatalog;
    /// The scripts
    scripts: ScriptDataMap;
    /// Committed cells keyed by their file name.
    scriptRefs: { [fileName: string]: ScriptRef };
    /// The file names of the committed cells in feed order, the keys of `scriptRefs`
    scriptOrder: string[];
    /// The session focus (selected cell by file name)
    scriptFocus: ScriptFocus;
    /// The semantic user focus info (if any)
    semanticUserFocus: SemanticUserFocus | null;
}

/// The connection that a script is analyzed and executed with
export interface ScriptConnection {
    /// The connection id
    connectionId: string;
    /// The connector info of the connection
    connectorInfo: ConnectorInfo;
    /// The catalog of the connection, the script session lives in it
    catalog: core.DashQLCatalog;
    /// The params of the connection when the script took it. The session file needs them to hold a
    /// copy of a connection that it doesn't hold yet, a copy that it holds wins.
    params?: ConnectionParams;
}

/// The connection of a script that runs on a connection of the app
export function scriptConnectionOf(connection: ConnectionState): ScriptConnection {
    return { connectionId: connection.connectionId, connectorInfo: connection.connectorInfo, catalog: connection.catalog, params: connection.params };
}

/// The default connection of a session
export function defaultScriptConnection(state: SessionScripts): ScriptConnection {
    return { connectionId: state.connectionId, connectorInfo: state.connectorInfo, catalog: state.connectionCatalog };
}

/// The ids of the connections that a session uses: the default connection and the connections of
/// its scripts, in this order. Everything else that knows the connections of a session derives
/// them from here.
export function sessionConnectionIds(state: SessionScripts): string[] {
    const ids = new Set([state.connectionId]);
    for (const script of Object.values(state.scripts)) {
        ids.add(script.connection.connectionId);
    }
    return [...ids];
}

/// A script as storage holds it
export interface StoredSessionScript {
    /// The file name
    name: string;
    /// The text
    sql: string;
    /// The connection
    connection: ScriptConnection;
    /// The connection that the session file names for the script while the app doesn't know it
    unresolvedConnectionId?: string;
}

/// The id of the connection that the session file names for a script
export function persistedConnectionId(script: { connection: ScriptConnection; unresolvedConnectionId?: string }): string {
    return script.unresolvedConnectionId ?? script.connection.connectionId;
}

/// Storage-shaped session content used when an external filesystem change replaces the persisted
/// session. Keeping this type here prevents the native watcher from knowing about WASM lifetime
/// and catalog invariants.
export interface SessionScriptsStorageSnapshot {
    /// The scripts in feed order
    scripts: StoredSessionScript[];
}

export function sessionScriptsMatchStorageSnapshot(state: SessionScripts, snapshot: SessionScriptsStorageSnapshot): boolean {
    if (state.scriptOrder.length !== snapshot.scripts.length) {
        return false;
    }
    return snapshot.scripts.every((stored, i) => {
        const ref = state.scriptRefs[stored.name];
        const script = ref == null ? undefined : state.scripts[ref.scriptId];
        return state.scriptOrder[i] === stored.name
            && script?.connection.connectionId === stored.connection.connectionId
            && persistedConnectionId(script) === persistedConnectionId(stored)
            && script.scriptSession.getText() === stored.sql;
    });
}

/// A script data
export interface ScriptData {
    /// The script key
    scriptKey: number;
    /// The durable editor session that owns the native script
    scriptSession: core.DashQLScriptSession;
    /// The latest plain editor-session snapshot.
    editorUpdate?: core.buffers.editor.EditorUpdateT | null;
    /// Whether the editor session must be reanalyzed against its text or catalog.
    analysisOutdated: boolean;
    /// The derived annotations for the ui
    annotations: ScriptAnnotations;
    /// The statistics
    statistics: Immutable.List<core.buffers.editor.EditorProcessingStatisticsT>;
    /// The completion state.
    completion: DashQLCompletionState | null;
    /// A pending, staged formatting rewrite shown as an in-place diff.
    /// Set by SET_SCRIPT_TEXT; cleared once the user accepts/rejects it in the
    /// editor (which round-trips back through UPDATE_FROM_PROCESSOR).
    pendingDiff: DashQLPendingDiff | null;
    /// The latest query id
    latestQueryId: number | null;
    /// The retained result/computation id, independent of later commands or failures.
    latestResultQueryId?: number | null;
    /// The file name of this committed script
    fileName: string;
    /// The connection the script is analyzed and executed with
    connection: ScriptConnection;
    /// The connection that the session file names for the script while the app doesn't know it, e.g.
    /// after a hand edit. The script runs on the default connection meanwhile and the session file
    /// keeps the reference until another connection is picked.
    unresolvedConnectionId?: string;
}

export const SELECT_NEXT_SCRIPT = Symbol('SELECT_NEXT_SCRIPT');
export const SELECT_PREV_SCRIPT = Symbol('SELECT_PREV_SCRIPT');
export const SELECT_SCRIPT = Symbol('SELECT_SCRIPT');
export const ANALYZE_OUTDATED_SCRIPT = Symbol('ANALYZE_OUTDATED_SCRIPT');
export const APPLY_PLANNER_ANALYSIS = Symbol('APPLY_PLANNER_ANALYSIS');
export const UPDATE_FROM_PROCESSOR = Symbol('UPDATE_FROM_PROCESSOR');
export const CATALOG_DID_UPDATE = Symbol('CATALOG_DID_UPDATE');
export const REGISTER_QUERY = Symbol('REGISTER_QUERY');
export const REGISTER_SCRIPT_RESULT = Symbol('REGISTER_SCRIPT_RESULT');
export const SET_SCRIPT_EXECUTION_VISUALIZATION = Symbol('SET_SCRIPT_EXECUTION_VISUALIZATION');
export const CREATE_SCRIPT = Symbol('CREATE_SCRIPT');
export const DELETE_SCRIPT = Symbol('DELETE_SCRIPT');
export const RENAME_SCRIPT = Symbol('RENAME_SCRIPT');
export const REORDER_SCRIPTS = Symbol('REORDER_SCRIPTS');
export const SET_SCRIPT_TEXT = Symbol('SET_SCRIPT_TEXT');
export const ACCEPT_PENDING_DIFF = Symbol('ACCEPT_PENDING_DIFF');
export const REJECT_PENDING_DIFF = Symbol('REJECT_PENDING_DIFF');
export const RENAME_SESSION = Symbol('RENAME_SESSION');
export const UPDATE_SESSION_SETTINGS = Symbol('UPDATE_SESSION_SETTINGS');
export const SET_SCRIPT_CONNECTION = Symbol('SET_SCRIPT_CONNECTION');

export type SessionScriptsAction =
    | VariantKind<typeof SELECT_NEXT_SCRIPT, null>
    | VariantKind<typeof SELECT_PREV_SCRIPT, null>
    | VariantKind<typeof SELECT_SCRIPT, string>
    | VariantKind<typeof ANALYZE_OUTDATED_SCRIPT, ScriptKey>
    | VariantKind<typeof APPLY_PLANNER_ANALYSIS, Array<{ scriptKey: number; editorUpdate: core.buffers.editor.EditorUpdateT }>>
    | VariantKind<typeof UPDATE_FROM_PROCESSOR, DashQLProcessorUpdateOut>
    | VariantKind<typeof CATALOG_DID_UPDATE, string>
    | VariantKind<typeof REGISTER_QUERY, [ScriptKey, number]>
    | VariantKind<typeof REGISTER_SCRIPT_RESULT, [ScriptKey, number]>
    | VariantKind<typeof SET_SCRIPT_EXECUTION_VISUALIZATION, [ScriptKey, ResolvedVisualizeQuery | null]>
    | VariantKind<typeof CREATE_SCRIPT, { index: number | null, text?: string }>
    | VariantKind<typeof DELETE_SCRIPT, string>
    | VariantKind<typeof RENAME_SCRIPT, { fileName: string, newFileName: string }>
    | VariantKind<typeof REORDER_SCRIPTS, string[]>
    | VariantKind<typeof SET_SCRIPT_TEXT, { scriptKey: ScriptKey, text: string, withDiff?: boolean }>
    | VariantKind<typeof ACCEPT_PENDING_DIFF, ScriptKey>
    | VariantKind<typeof REJECT_PENDING_DIFF, ScriptKey>
    | VariantKind<typeof RENAME_SESSION, string | null>
    | VariantKind<typeof UPDATE_SESSION_SETTINGS, Partial<SessionSettings>>
    | VariantKind<typeof SET_SCRIPT_CONNECTION, { fileName: string, connection: ScriptConnection }>
    ;

const STATS_HISTORY_LIMIT = 20;

/// Create the data of an empty script on a connection.
/// A script that moves to another connection keeps its script key, the key is unused in the catalog of the connection.
export function createEmptyScriptData(instance: core.DashQL, connection: ScriptConnection, fileName: string = '', movedScriptKey?: ScriptKey): [number, ScriptData] {
    const scriptSession = movedScriptKey == null
        ? instance.createScriptSession(connection.catalog)
        : instance.createScriptSessionWithEntryId(connection.catalog, movedScriptKey);
    const scriptKey = scriptSession.getCatalogEntryId();
    const scriptData: ScriptData = {
        scriptKey,
        scriptSession,
        editorUpdate: null,
        analysisOutdated: true,
        statistics: Immutable.List(),
        annotations: createEmptyAnnotations(),
        completion: null,
        pendingDiff: null,
        latestQueryId: null,
        latestResultQueryId: null,
        fileName,
        connection,
    };
    return [scriptKey, scriptData];
}

enum FocusUpdate {
    Clear,
    UpdateFromCursor,
    UpdateFromCompletion,
};

/// Returns the committed cells in feed order.
export function getScriptRefs(state: SessionScripts): ScriptRef[] {
    return state.scriptOrder.map(name => state.scriptRefs[name]);
}

/// Returns the currently selected cell, or the first cell when focus is unset.
export function getSelectedScriptRef(state: SessionScripts): ScriptRef | undefined {
    const file = state.scriptFocus.fileName;
    if (file && state.scriptRefs[file]) return state.scriptRefs[file];
    const files = state.scriptOrder;
    return files.length > 0 ? state.scriptRefs[files[0]] : undefined;
}

/// The script list of the session file, the cells in feed order with their connections
export function sessionScriptList(state: SessionScripts): SessionScript[] {
    return state.scriptOrder.flatMap(name => {
        const script = state.scripts[state.scriptRefs[name]?.scriptId];
        return script == null ? [] : [{ name, connectionId: persistedConnectionId(script) }];
    });
}

/// The copies of the connections that the scripts of a session use, as far as the scripts know them
export function sessionConnectionCopies(state: SessionScripts): SessionConnection[] {
    const copies = new Map<string, SessionConnection>();
    for (const script of Object.values(state.scripts)) {
        const { connectionId, params } = script.connection;
        if (params != null && !copies.has(connectionId)) copies.set(connectionId, { connectionId, params });
    }
    return [...copies.values()];
}

/// The script list of a session as the session file stores it
export function sessionScriptListWrite(state: SessionScripts): SessionScriptList {
    return { scripts: sessionScriptList(state), connections: sessionConnectionCopies(state) };
}

/// Persist the order and the connections of the cells, the session file follows with its connections
function writeSessionScriptList(state: SessionScripts, storage: StorageWriter) {
    void storage.write(
        groupSessionScriptListWrites(state.sessionId),
        { type: WRITE_SESSION_SCRIPTS, value: [state.sessionId, sessionScriptListWrite(state)] },
        DEBOUNCE_DURATION_SESSION_WRITE,
    );
}

function writeSessionProperties(state: SessionScripts, storage: StorageWriter) {
    void storage.write(
        groupSessionManifestWrites(state.sessionId),
        { type: WRITE_SESSION_PROPERTIES, value: [state.sessionId, { name: state.name, settings: state.settings }] },
        DEBOUNCE_DURATION_SESSION_WRITE,
    );
}

export function reduceSessionScripts(state: SessionScripts, action: SessionScriptsAction, storage: StorageWriter, logger: Logger): SessionScripts {
    switch (action.type) {
        case RENAME_SESSION: {
            const trimmed = action.value?.trim() ?? '';
            const name = trimmed.length > 0 ? trimmed : null;
            if (name === state.name) return state;
            const next = { ...state, name };
            writeSessionProperties(next, storage);
            return next;
        }
        case UPDATE_SESSION_SETTINGS: {
            const settings = { ...state.settings, ...action.value };
            if (Object.entries(settings).every(([key, value]) => state.settings[key as keyof SessionSettings] === value)) return state;
            const next = { ...state, settings };
            writeSessionProperties(next, storage);
            return next;
        }
        case SELECT_NEXT_SCRIPT: {
            const files = state.scriptOrder;
            const cur = files.indexOf(state.scriptFocus.fileName);
            const nextIdx = Math.min(Math.max(cur, 0) + 1, files.length - 1);
            const fileName = files[nextIdx] ?? state.scriptFocus.fileName;
            return {
                ...clearSemanticUserFocus(state),
                scriptFocus: { ...state.scriptFocus, fileName },
            };
        }
        case SELECT_PREV_SCRIPT: {
            const files = state.scriptOrder;
            const cur = files.indexOf(state.scriptFocus.fileName);
            const prevIdx = Math.max((cur < 0 ? 0 : cur) - 1, 0);
            const fileName = files[prevIdx] ?? state.scriptFocus.fileName;
            return {
                ...clearSemanticUserFocus(state),
                scriptFocus: { ...state.scriptFocus, fileName },
            };
        }
        case SELECT_SCRIPT: {
            const fileName = action.value;
            if (!state.scriptRefs[fileName]) return state;
            // Hovering a card re-selects it constantly, keep the state (and the semantic focus) untouched.
            if (state.scriptFocus.fileName === fileName) return state;
            return {
                ...clearSemanticUserFocus(state),
                scriptFocus: { ...state.scriptFocus, fileName },
            };
        }
        case CATALOG_DID_UPDATE: {
            const scripts = { ...state.scripts };
            for (const scriptKey in scripts) {
                const prev = scripts[scriptKey];
                if (prev.connection.connectionId !== action.value) continue;
                scripts[scriptKey] = {
                    ...prev,
                    analysisOutdated: true,
                };
            }
            return {
                ...state,
                scripts
            };
        }

        case ANALYZE_OUTDATED_SCRIPT:
            return analyzeOutdatedScript(state, action.value, logger);

        case APPLY_PLANNER_ANALYSIS: {
            let scripts = state.scripts;
            const focusedScriptKey = getSelectedScriptRef(state)?.scriptId;
            let semanticUserFocus: SemanticUserFocus | null = null;
            for (const { scriptKey, editorUpdate } of action.value) {
                const prevScript = scripts[scriptKey];
                if (!prevScript ||
                    prevScript.scriptSession.getTextVersion() !== editorUpdate.textVersion ||
                    prevScript.scriptSession.getCatalogRevision() !== editorUpdate.catalogRevision ||
                    editorUpdate.status !== core.buffers.editor.EditorUpdateStatus.OK ||
                    !editorUpdate.analysisAvailable) {
                    continue;
                }
                // Cursor movement can supersede a planner snapshot without changing text or catalog.
                const nextUpdate = prevScript.scriptSession.getStateRevision() === editorUpdate.stateRevision
                    ? editorUpdate
                    : prevScript.scriptSession.analyze();
                const projectionChanged = prevScript.editorUpdate?.stateRevision !== nextUpdate.stateRevision;
                if (projectionChanged) {
                    prevScript.completion?.buffer.destroy();
                }
                if (scripts === state.scripts) scripts = { ...scripts };
                scripts[scriptKey] = {
                    ...prevScript,
                    editorUpdate: nextUpdate,
                    analysisOutdated: false,
                    annotations: deriveScriptAnnotations(nextUpdate, prevScript.scriptSession,
                        prevScript.connection.connectorInfo.connectorType, logger),
                    statistics: editorUpdate.analysisUpdated
                        ? rotateScriptStatistics(prevScript.statistics, editorUpdate.processingStatistics)
                        : prevScript.statistics,
                    completion: projectionChanged ? null : prevScript.completion,
                };
                if (scriptKey === focusedScriptKey) {
                    semanticUserFocus = scripts[scriptKey].completion != null
                        ? deriveFocusFromCompletionCandidates(scriptKey, scripts[scriptKey])
                        : deriveFocusFromEditorUpdate(scriptKey, nextUpdate);
                }
            }
            if (scripts === state.scripts) return state;
            // Analysis is already published by the planner. Publishing again invalidates its revision.
            return {
                ...state,
                scripts,
                semanticUserFocus,
            };
        }

        case UPDATE_FROM_PROCESSOR: {
            const update = action.value;
            const prevScript = state.scripts[update.scriptKey];
            const prevFocus = state.semanticUserFocus;
            const updateSession = update.scriptSession;
            // If the script key does not refer to a value we know, we cannot keep the new script alive.
            // Drop the update.
            if (!prevScript) {
                logger.warn("Dropping editor update for unknown script", {
                    sessionId: state.sessionId,
                    scriptKey: update.scriptKey.toString(),
                    textVersion: update.editorUpdate?.textVersion.toString(),
                    stateRevision: update.editorUpdate?.stateRevision.toString(),
                }, LOG_CTX);
                update.scriptBuffers?.destroy(update.scriptBuffers);
                update.scriptCompletion?.buffer.destroy();
                return clearSemanticUserFocus(state);
            }
            if (updateSession !== prevScript.scriptSession) {
                logger.warn("Dropping editor update from stale editor session", {
                    sessionId: state.sessionId,
                    scriptKey: update.scriptKey.toString(),
                    textVersion: update.editorUpdate?.textVersion.toString(),
                    stateRevision: update.editorUpdate?.stateRevision.toString(),
                }, LOG_CTX);
                update.scriptBuffers?.destroy(update.scriptBuffers);
                update.scriptCompletion?.buffer.destroy();
                return clearSemanticUserFocus(state);
            }
            const nextCursorContext = update.editorUpdate?.primaryCursorContext;
            const documentChanged = prevScript.editorUpdate?.textVersion !== update.editorUpdate?.textVersion;
            const analysisRefreshed = update.editorUpdate?.analysisUpdated === true;
            const projectionChanged = prevScript.editorUpdate?.stateRevision !== update.editorUpdate?.stateRevision;
            logger.debug("Applying editor processor update", {
                sessionId: state.sessionId,
                scriptKey: update.scriptKey.toString(),
                documentChanged: documentChanged.toString(),
                analysisRefreshed: analysisRefreshed.toString(),
                projectionChanged: projectionChanged.toString(),
                previousTextVersion: prevScript.editorUpdate?.textVersion.toString(),
                textVersion: update.editorUpdate?.textVersion.toString(),
                previousStateRevision: prevScript.editorUpdate?.stateRevision.toString(),
                stateRevision: update.editorUpdate?.stateRevision.toString(),
                cursorOffset: update.editorUpdate?.primaryCursorState?.textOffset?.toString(),
            }, LOG_CTX);
            let focusUpdate: FocusUpdate | null = null;
            if (projectionChanged) {
                focusUpdate = FocusUpdate.Clear;
            }
            // Did the completion change?
            if (update.scriptCompletion) {
                if (update.scriptCompletion.buffer !== prevScript.completion?.buffer) {
                    focusUpdate = FocusUpdate.UpdateFromCompletion;
                } else {
                    // Did the completion index change?
                    if (update.scriptCompletion.candidateId !== prevScript.completion?.candidateId) {
                        focusUpdate = FocusUpdate.UpdateFromCompletion;
                    }
                }
            }
            // Did the pending diff change? The editor clears it on accept/reject (and auto-accept);
            // free the superseded buffer, mirroring the completion-buffer discipline above.
            if (update.scriptPendingDiff !== prevScript.pendingDiff) {
                prevScript.pendingDiff?.diffBuffer.destroy();
            }

            if (prevScript.completion?.buffer !== update.scriptCompletion?.buffer) {
                prevScript.completion?.buffer.destroy();
            }
            if (projectionChanged) {
                focusUpdate = update.scriptCompletion != null
                    ? FocusUpdate.UpdateFromCompletion
                    : nextCursorContext != null
                        ? FocusUpdate.UpdateFromCursor
                        : FocusUpdate.Clear;
            }
            update.scriptBuffers?.destroy(update.scriptBuffers);
            const nextScript: ScriptData = {
                ...prevScript,
                analysisOutdated: false,
                completion: update.scriptCompletion,
                pendingDiff: update.scriptPendingDiff,
                editorUpdate: update.editorUpdate ?? prevScript.editorUpdate,
                statistics: update.editorUpdate?.analysisUpdated
                    ? rotateScriptStatistics(prevScript.statistics, update.editorUpdate.processingStatistics)
                    : prevScript.statistics,
            };
            if (documentChanged || analysisRefreshed) {
                nextScript.annotations = deriveScriptAnnotations(update.editorUpdate, updateSession,
                    prevScript.connection.connectorInfo.connectorType, logger);
                updateSession.loadIntoCatalog(nextScript.scriptKey);
            }
            // Update semantic user focus
            let semanticUserFocus: SemanticUserFocus | null = prevFocus;
            switch (focusUpdate) {
                case FocusUpdate.Clear:
                    semanticUserFocus = null;
                    break;
                case FocusUpdate.UpdateFromCursor:
                    semanticUserFocus = deriveFocusFromEditorUpdate(update.scriptKey, nextScript.editorUpdate);
                    break;
                case FocusUpdate.UpdateFromCompletion:
                    semanticUserFocus = deriveFocusFromCompletionCandidates(update.scriptKey, nextScript);
                    break;
            }
            let nextState: SessionScripts = {
                ...state,
                scripts: {
                    ...state.scripts,
                    [update.scriptKey]: nextScript
                },
                semanticUserFocus,
            };

            // Re-load the catalog and mark scripts outdated when the analysis actually changed.
            if (documentChanged || analysisRefreshed) {
                // Mark the other scripts of the catalog as outdated.
                // Eventually, we could restrict to those that are depending?
                markOtherScriptsOutdatedInPlace(nextState.scripts, nextScript);
            }
            // Persist only when the document text changed. Cursor/completion updates
            // still flow through this action but must not rewrite identical SQL.
            if (documentChanged) {
                const scriptKey = update.scriptKey;
                const scriptData = nextState.scripts[scriptKey];
                if (scriptData?.fileName) {
                    const sql = scriptData.scriptSession.getText();
                    storage.write(
                        groupScriptWrites(nextState.sessionId, scriptData.fileName),
                        { type: WRITE_SCRIPT, value: [nextState.sessionId, scriptData.fileName, sql] },
                        DEBOUNCE_DURATION_SCRIPT_WRITE
                    );
                }
            }
            return nextState;
        }

        case REGISTER_QUERY: {
            const [scriptKey, queryId] = action.value;
            const scriptData = state.scripts[scriptKey];
            if (!scriptData) {
                logger.warn("Orphan query references invalid script", {
                    scriptKey: scriptKey.toString(),
                    queryId: queryId.toString(),
                }, LOG_CTX);
                return state;
            } else {
                const next = { ...state, scripts: { ...state.scripts } };
                next.scripts[scriptKey] = {
                    ...scriptData,
                    latestQueryId: queryId,
                    latestResultQueryId: scriptData.latestResultQueryId === undefined
                        ? scriptData.latestQueryId : scriptData.latestResultQueryId,
                };
                return next;
            }
        }

        case SET_SCRIPT_EXECUTION_VISUALIZATION: {
            const [scriptKey, visualizeQuery] = action.value;
            const scriptData = state.scripts[scriptKey];
            if (!scriptData) return state;
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: {
                        ...scriptData,
                        annotations: { ...scriptData.annotations, visualizeQuery },
                    },
                },
            };
        }

        case REGISTER_SCRIPT_RESULT: {
            const [scriptKey, queryId] = action.value;
            const scriptData = state.scripts[scriptKey];
            // Query ids are monotonic; an older overlapping execution must not replace a newer result.
            if (!scriptData || (scriptData.latestResultQueryId != null && scriptData.latestResultQueryId >= queryId)) {
                return state;
            }
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: { ...scriptData, latestResultQueryId: queryId },
                },
            };
        }

        case DELETE_SCRIPT: {
            const deletedFileName = action.value;
            const deletedEntry = state.scriptRefs[deletedFileName];
            if (!deletedEntry) return state;
            const remainingFiles = state.scriptOrder.filter(name => name !== deletedFileName);
            const scriptRefs = { ...state.scriptRefs };
            delete scriptRefs[deletedFileName];

            // Adjust focus if needed
            let newFile = state.scriptFocus.fileName;
            if (newFile === deletedFileName) {
                const oldIdx = state.scriptOrder.indexOf(deletedFileName);
                newFile = remainingFiles[Math.max(0, oldIdx - 1)] ?? remainingFiles[0] ?? '';
            }

            const next = destroyDeadScripts({
                ...clearSemanticUserFocus(state),
                scriptRefs,
                scriptOrder: remainingFiles,
                scriptFocus: { ...state.scriptFocus, fileName: newFile },
            });
            storage.write(
                groupScriptDeletes(next.sessionId, deletedEntry.fileName),
                { type: STORAGE_DELETE_SCRIPT, value: [next.sessionId, deletedEntry.fileName] },
                DEBOUNCE_DURATION_SCRIPT_WRITE
            );
            writeSessionScriptList(next, storage);
            return next;
        }

        case CREATE_SCRIPT: {
            // Null appends; an index inserts at that feed boundary. Text seeds the new script, e.g. from the composer.
            const { index, text } = action.value;
            const fileName = generateScriptFileName(state.scriptRefs);

            // Create a new script on the default connection
            let [scriptKey, scriptData] = createEmptyScriptData(state.instance, defaultScriptConnection(state), fileName);
            const scripts: ScriptDataMap = { ...state.scripts };
            if (text) {
                // Analyze right away so the script can be executed without waiting for an editor,
                // and mark the others outdated since the new script was loaded into the catalog.
                replaceScriptSessionText(scriptData.scriptSession, text);
                scriptData = analyzeScriptData(scriptData, logger);
                markOtherScriptsOutdatedInPlace(scripts, scriptData);
            }
            scripts[scriptKey] = scriptData;

            const scriptOrder = [...state.scriptOrder];
            const insertAt = index == null ? scriptOrder.length : Math.max(0, Math.min(Math.trunc(index), scriptOrder.length));
            scriptOrder.splice(insertAt, 0, fileName);

            const next: SessionScripts = {
                ...clearSemanticUserFocus(state),
                scripts,
                scriptRefs: { ...state.scriptRefs, [fileName]: createScriptRef(scriptKey, fileName) },
                scriptOrder,
                scriptFocus: { ...state.scriptFocus, fileName },
            };
            storage.write(
                groupScriptWrites(next.sessionId, fileName),
                { type: WRITE_SCRIPT, value: [next.sessionId, fileName, text ?? ''] },
                DEBOUNCE_DURATION_SCRIPT_WRITE
            );
            writeSessionScriptList(next, storage);
            return next;
        }

        case RENAME_SCRIPT: {
            const { fileName: oldFileName, newFileName: requestedName } = action.value;
            const entry = state.scriptRefs[oldFileName];
            if (!entry) {
                logger.warn("RENAME_SCRIPT references invalid script", {
                    fileName: oldFileName,
                }, LOG_CTX);
                return state;
            }
            // The rename input edits the display name. Drop a ".sql" the user included, disambiguate
            // the name against the other scripts and attach the ".sql" extension. An empty name and a
            // name that is not a plain file name are ignored.
            const requestedBase = scriptDisplayName(requestedName.trim());
            if (!requestedBase || /[/\\\0]/.test(requestedBase)) {
                return state;
            }
            const cleanBase = uniqueScriptBase(requestedBase, state.scriptRefs, oldFileName);
            const newFileName = `${cleanBase}.sql`;
            const renamed = oldFileName !== newFileName;
            const renamedEntry: ScriptRef = { ...entry, fileName: newFileName };
            const scriptRefs = { ...state.scriptRefs };
            if (renamed) delete scriptRefs[oldFileName];
            scriptRefs[newFileName] = renamedEntry;
            const scriptOrder = state.scriptOrder.map(name => name === oldFileName ? newFileName : name);

            // Update the script data fileName and re-analyze immediately with the new path.
            const scriptId = entry.scriptId;
            const updatedScriptData = state.scripts[scriptId];
            const newScripts = { ...state.scripts };
            if (updatedScriptData) {
                const renamedScriptData: ScriptData = { ...updatedScriptData, fileName: newFileName };
                if (renamed) {
                    newScripts[scriptId] = analyzeScriptData(renamedScriptData, logger);
                    markOtherScriptsOutdatedInPlace(newScripts, renamedScriptData);
                } else {
                    newScripts[scriptId] = renamedScriptData;
                }
            }

            // Keep focus on this script across the rename
            const focusFile = state.scriptFocus.fileName === oldFileName
                ? newFileName
                : state.scriptFocus.fileName;

            const next = {
                ...(renamed ? clearSemanticUserFocus(state) : state),
                scriptRefs,
                scriptOrder,
                scripts: newScripts,
                scriptFocus: { ...state.scriptFocus, fileName: focusFile },
            };
            if (renamed) {
                // Rename the file in place: its SQL is unchanged, so move it rather than delete-old +
                // rewrite-new. The new clean base is disambiguated unique within the page, so the
                // rename target never collides with another script's existing name.
                storage.write(
                    groupScriptRenames(next.sessionId, oldFileName),
                    { type: STORAGE_RENAME_SCRIPT, value: [next.sessionId, oldFileName, newFileName] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
                writeSessionScriptList(next, storage);
            } else {
                // No rename: just persist the current contents under the unchanged name.
                const sql = updatedScriptData ? updatedScriptData.scriptSession.getText() : '';
                storage.write(
                    groupScriptWrites(next.sessionId, newFileName),
                    { type: WRITE_SCRIPT, value: [next.sessionId, newFileName, sql] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
            }
            return next;
        }

        case REORDER_SCRIPTS: {
            const requestedOrder = action.value;

            // Build the target order: the requested files (that still exist, de-duplicated), then any
            // files the caller omitted, appended in their current feed order so none are dropped.
            const seen = new Set<string>();
            const order: string[] = [];
            for (const file of requestedOrder) {
                if (state.scriptRefs[file] && !seen.has(file)) {
                    seen.add(file);
                    order.push(file);
                }
            }
            const currentOrder = state.scriptOrder;
            for (const file of currentOrder) {
                if (!seen.has(file)) {
                    seen.add(file);
                    order.push(file);
                }
            }

            // Same order as the current feed → change nothing (don't churn the disk).
            if (order.length === currentOrder.length && order.every((f, i) => f === currentOrder[i])) {
                return state;
            }
            // The order lives in the session file, the script files stay untouched
            const next: SessionScripts = { ...state, scriptOrder: order };
            writeSessionScriptList(next, storage);
            return next;
        }

        case SET_SCRIPT_CONNECTION: {
            const { fileName, connection } = action.value;
            const entry = state.scriptRefs[fileName];
            const prev = entry == null ? undefined : state.scripts[entry.scriptId];
            if (!prev) {
                logger.warn("SET_SCRIPT_CONNECTION references invalid script", { fileName }, LOG_CTX);
                return state;
            }
            if (prev.connection.connectionId === connection.connectionId) {
                if (prev.unresolvedConnectionId == null) return state;
                // Picking the connection the script runs on replaces the unresolved reference
                const next: SessionScripts = {
                    ...state,
                    scripts: { ...state.scripts, [prev.scriptKey]: { ...prev, unresolvedConnectionId: undefined } },
                };
                writeSessionScriptList(next, storage);
                return next;
            }
            // A script session belongs to one catalog, the script moves into a new script session under
            // its key. The new session is created first, a failure leaves the script untouched.
            let moved: [number, ScriptData];
            try {
                moved = createMovedScriptData(state.instance, prev, connection);
            } catch (e: any) {
                logger.warn("Failed to move script to another connection", { fileName, error: stringifyError(e) }, LOG_CTX);
                return state;
            }
            let [scriptKey, scriptData] = moved;
            dropScriptData(prev);
            try {
                scriptData = analyzeScriptData(scriptData, logger);
            } catch (e: any) {
                logger.warn("Failed to analyze script on its new connection", { fileName, error: stringifyError(e) }, LOG_CTX);
            }
            const scripts: ScriptDataMap = { ...state.scripts };
            // The scripts of both catalogs may have referenced the moved script
            markOtherScriptsOutdatedInPlace(scripts, prev);
            markOtherScriptsOutdatedInPlace(scripts, scriptData);
            scripts[scriptKey] = scriptData;
            const next: SessionScripts = {
                ...clearSemanticUserFocus(state),
                scripts,
            };
            writeSessionScriptList(next, storage);
            return next;
        }

        case SET_SCRIPT_TEXT: {
            const { scriptKey, text, withDiff } = action.value;
            const scriptData = state.scripts[scriptKey];
            if (!scriptData) {
                logger.warn("SET_SCRIPT_TEXT references invalid script", { scriptKey: scriptKey.toString() }, LOG_CTX);
                return state;
            }
            // Compute a staged diff against the prior text *before* we overwrite it (a genuine text
            // change is required — an unchanged rewrite produces no overlay). The prior script still
            // holds the old text here; diff it against a throwaway target seeded with the new text.
            const priorText = scriptData.scriptSession.getText();
            let pendingDiff: DashQLPendingDiff | null = null;
            if (withDiff && text !== priorText) {
                pendingDiff = computePendingDiff(state.instance, scriptData.scriptSession, text, priorText, logger);
            }
            // A staged diff on this script replaces any earlier one — free the superseded buffer.
            if (scriptData.pendingDiff != null) {
                scriptData.pendingDiff.diffBuffer.destroy();
            }
            // Rewrite the script text in-place
            replaceScriptSessionText(scriptData.scriptSession, text);
            // Re-analyze through the path-aware helper (destroys the stale buffers, refreshes
            // buffers + annotations incl. visualizeQuery, reloads the script into the catalog)
            const nextScriptData = analyzeScriptData(scriptData, logger);
            nextScriptData.pendingDiff = pendingDiff;

            const nextState: SessionScripts = {
                ...clearSemanticUserFocus(state),
                scripts: {
                    ...state.scripts,
                    [scriptKey]: nextScriptData,
                },
            };
            // The text changed and was reloaded into the catalog; mark the other scripts of the
            // catalog outdated so cross-script references re-resolve (mirrors UPDATE_FROM_PROCESSOR).
            markOtherScriptsOutdatedInPlace(nextState.scripts, nextScriptData);

            // Persist only the updated script (same tail as UPDATE_FROM_PROCESSOR)
            const sql = nextScriptData.scriptSession.getText();
            if (nextScriptData.fileName) {
                storage.write(
                    groupScriptWrites(nextState.sessionId, nextScriptData.fileName),
                    { type: WRITE_SCRIPT, value: [nextState.sessionId, nextScriptData.fileName, sql] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
            }
            return nextState;
        }

        case ACCEPT_PENDING_DIFF: {
            // Keep the current (new) text — SET_SCRIPT_TEXT already applied and persisted it — and
            // just drop the staged diff. Mirrors the editor's DashQLDiffAcceptEffect path, which
            // clears scriptPendingDiff without touching the rope.
            const scriptKey = action.value;
            const scriptData = state.scripts[scriptKey];
            if (!scriptData || scriptData.pendingDiff == null) {
                return state;
            }
            scriptData.pendingDiff.diffBuffer.destroy();
            return {
                ...state,
                scripts: {
                    ...state.scripts,
                    [scriptKey]: { ...scriptData, pendingDiff: null },
                },
            };
        }

        case REJECT_PENDING_DIFF: {
            // Restore the verbatim prior text and drop the staged diff. This reproduces the
            // editor's DashQLDiffRejectEffect path (restore priorText + clear) via the same tail as
            // SET_SCRIPT_TEXT, so a diff rejected from the feed and one rejected from the Details
            // editor leave identical session scripts state.
            const scriptKey = action.value;
            const scriptData = state.scripts[scriptKey];
            if (!scriptData || scriptData.pendingDiff == null) {
                return state;
            }
            const priorText = scriptData.pendingDiff.priorText;
            scriptData.pendingDiff.diffBuffer.destroy();
            // Rewrite the script text in-place and re-analyze through the path-aware helper.
            replaceScriptSessionText(scriptData.scriptSession, priorText);
            const nextScriptData = analyzeScriptData(scriptData, logger);
            nextScriptData.pendingDiff = null;

            const nextState: SessionScripts = {
                ...clearSemanticUserFocus(state),
                scripts: {
                    ...state.scripts,
                    [scriptKey]: nextScriptData,
                },
            };
            // The text changed and was reloaded into the catalog; mark the other scripts of the
            // catalog outdated so cross-script references re-resolve (mirrors SET_SCRIPT_TEXT).
            markOtherScriptsOutdatedInPlace(nextState.scripts, nextScriptData);

            // Persist only the updated script (same tail as SET_SCRIPT_TEXT)
            const sql = nextScriptData.scriptSession.getText();
            if (nextScriptData.fileName) {
                storage.write(
                    groupScriptWrites(nextState.sessionId, nextScriptData.fileName),
                    { type: WRITE_SCRIPT, value: [nextState.sessionId, nextScriptData.fileName, sql] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
            }
            return nextState;
        }

    }
}

export function clearSemanticUserFocus<V extends SessionScripts>(state: V): V {
    return { ...state, semanticUserFocus: null };
}

/// Mark the other scripts in the catalog of a script as outdated in a scripts map that the caller
/// already owns. Scripts in other catalogs can't reference the script.
///
/// Scripts that are already outdated keep their identity.
/// This runs for every keystroke and every new ScriptData object re-renders its editor and card.
function markOtherScriptsOutdatedInPlace(scripts: ScriptDataMap, changed: ScriptData) {
    for (const key in scripts) {
        if (+key === changed.scriptKey) continue;
        const script = scripts[key];
        if (script.analysisOutdated || script.connection.catalog !== changed.connection.catalog) continue;
        scripts[key] = {
            ...script,
            analysisOutdated: true,
        };
    }
}
function destroyScriptData(data: ScriptData) {
    data.scriptSession.destroy();
    data.completion?.buffer.destroy();
    data.pendingDiff?.diffBuffer.destroy();
}

/// Drop a script from its catalog and destroy it
function dropScriptData(data: ScriptData) {
    try {
        data.scriptSession.dropFromCatalog();
    } catch {
        // The script may not have completed analysis and therefore may not be in the catalog.
    }
    destroyScriptData(data);
}

/// Create the script data of a script that moves to another connection. The script keeps its key,
/// its text and its results, the caller drops the previous script data afterwards.
function createMovedScriptData(instance: core.DashQL, prev: ScriptData, connection: ScriptConnection): [number, ScriptData] {
    const [scriptKey, scriptData] = createEmptyScriptData(instance, connection, prev.fileName, prev.scriptKey);
    try {
        replaceScriptSessionText(scriptData.scriptSession, prev.scriptSession.getText());
    } catch (e) {
        destroyScriptData(scriptData);
        throw e;
    }
    return [scriptKey, { ...scriptData, latestQueryId: prev.latestQueryId, latestResultQueryId: prev.latestResultQueryId }];
}

export function destroySessionScripts(state: SessionScripts): SessionScripts {
    // Drop the session-owned scripts from the connection catalog.
    for (const scriptData of Object.values(state.scripts)) {
        scriptData.scriptSession.dropFromCatalog();
    }
    // Destroy all the script data
    for (const key in state.scripts) {
        const script = state.scripts[key];
        destroyScriptData(script);
    }
    return state;
}

/// Replace persisted session content without scheduling writes back to storage.
///
/// Scripts that remain at the same file path on the same connection retain their WASM identity,
/// query history and UI references. A script that moved to another connection gets a new script
/// session in the catalog of that connection. Added and removed paths allocate/free their WASM state
/// here, where the catalog and script-registry lifetime rules are already centralized.
///
/// Every new script session is created before anything of the current state is changed or freed, a
/// failure leaves the current state intact.
export function replaceSessionScriptsFromStorage(
    state: SessionScripts,
    snapshot: SessionScriptsStorageSnapshot,
    _logger: Logger,
    catalogChanged: boolean = false,
): SessionScripts {
    const existingByPath = new Map<string, ScriptData>();
    for (const script of Object.values(state.scripts)) {
        if (script.fileName) {
            existingByPath.set(script.fileName, script);
        }
    }

    // Phase 1: create the script sessions of added and moved scripts, nothing is freed yet
    const stored = snapshot.scripts.filter((entry, i) => snapshot.scripts.findIndex(other => other.name === entry.name) === i);
    const created = new Map<string, ScriptData>();
    try {
        for (const entry of stored) {
            const existing = existingByPath.get(entry.name);
            if (existing != null && existing.connection.connectionId === entry.connection.connectionId) continue;
            // A script that moved to another connection keeps its key and its results
            const [, scriptData] = existing != null
                ? createMovedScriptData(state.instance, existing, entry.connection)
                : createEmptyScriptData(state.instance, entry.connection, entry.name);
            created.set(entry.name, scriptData);
            replaceScriptSessionText(scriptData.scriptSession, entry.sql);
        }
    } catch (e) {
        for (const scriptData of created.values()) destroyScriptData(scriptData);
        throw e;
    }

    // Phase 2: update the scripts that stay and free the replaced and removed ones
    const scripts: ScriptDataMap = {};
    const scriptRefs: { [fileName: string]: ScriptRef } = {};
    const scriptOrder: string[] = [];
    let contentChanged = false;
    for (const entry of stored) {
        const existing = existingByPath.get(entry.name);
        existingByPath.delete(entry.name);
        let scriptData = created.get(entry.name);
        if (scriptData != null) {
            if (existing != null) dropScriptData(existing);
            contentChanged = true;
        } else {
            scriptData = existing!;
            if (scriptData.scriptSession.getText() !== entry.sql) {
                scriptData.pendingDiff?.diffBuffer.destroy();
                scriptData.completion?.buffer.destroy();
                replaceScriptSessionText(scriptData.scriptSession, entry.sql);
                scriptData = {
                    ...scriptData,
                    pendingDiff: null,
                    completion: null,
                    analysisOutdated: true,
                };
                contentChanged = true;
            }
        }
        if (scriptData.unresolvedConnectionId !== entry.unresolvedConnectionId) {
            scriptData = { ...scriptData, unresolvedConnectionId: entry.unresolvedConnectionId };
        }
        scripts[scriptData.scriptKey] = scriptData;
        scriptRefs[entry.name] = createScriptRef(scriptData.scriptKey, entry.name);
        scriptOrder.push(entry.name);
    }

    // Files no longer present on disk own WASM objects that must be detached before destruction.
    for (const removed of existingByPath.values()) {
        dropScriptData(removed);
        contentChanged = true;
    }

    const previousFile = state.scriptFocus.fileName;
    const fileName = scriptRefs[previousFile] ? previousFile : (scriptOrder[0] ?? '');

    let next: SessionScripts = {
        ...clearSemanticUserFocus(state),
        scripts,
        scriptRefs,
        scriptOrder,
        scriptFocus: {
            ...state.scriptFocus,
            fileName,
        },
    };

    if (contentChanged || catalogChanged) {
        // Cross-script references can be affected by any add/remove/content or catalog change.
        // Invalidate the session and let each script reanalyze at its next explicit use.
        for (const key in next.scripts) {
            next.scripts[key] = {
                ...next.scripts[key],
                analysisOutdated: true,
            };
        }
    }
    return next;
}

function destroyDeadScripts(state: SessionScripts): SessionScripts {
    // Determine script liveness from the committed cell collection.
    let deadScripts = new Map<number, ScriptData>();
    for (const key in state.scripts) {
        deadScripts.set(+key, state.scripts[key]);
    }
    for (const ref of Object.values(state.scriptRefs)) {
        deadScripts.delete(ref.scriptId);
    }
    // Nothing to cleanup?
    if (deadScripts.size == 0) {
        return state;
    }
    // Copy scripts
    const cleanedScripts: ScriptDataMap = { ...state.scripts };
    // Delete scripts
    for (const [k, v] of deadScripts) {
        v.scriptSession.dropFromCatalog();
        destroyScriptData(v);
        delete cleanedScripts[k];
    }
    return { ...state, scripts: cleanedScripts };
}

export function rotateScriptStatistics(
    log: Immutable.List<core.buffers.editor.EditorProcessingStatisticsT>,
    stats: core.buffers.editor.EditorProcessingStatisticsT | null,
) {
    if (stats == null) {
        return log;
    } else {
        return log.withMutations(m => {
            m.push(stats);
            if (m.size > STATS_HISTORY_LIMIT) {
                m.shift();
            }
        });
    }
}

function deriveScriptAnnotations(
    update: core.buffers.editor.EditorUpdateT | null | undefined,
    scriptSession: core.DashQLScriptSession,
    connectorType: ConnectorType,
    logger?: LoggerLike,
): ScriptAnnotations {
    if (!update?.analysisAvailable) {
        return createEmptyAnnotations();
    }
    const tableDefsFlat = update.scriptAnnotations?.tableDefinitions
        .map(table => typeof table.name === 'string' ? table.name : null)
        .filter((name): name is string => name != null)
        .sort() ?? [];

    const visualizeQuery = compileVisualizeQuery(scriptSession, connectorType, logger);

    return {
        tableDefs: tableDefsFlat,
        visualizeQuery,
    };
}

export interface CompiledSessionQuery {
    sql: string;
    cacheSignature: string;
    cacheable: boolean;
}

/// Compile a script into executable SQL and cache metadata.
///
/// Statement classification, executable SQL extraction, and VISUALIZE
/// source extraction all happen in dashql-core.
export function compileSessionQuery(
    scriptData: ScriptData,
    connectorType: ConnectorType,
    logger?: LoggerLike,
): CompiledSessionQuery {
    logger?.debug('Compiling script for query execution', {
        scriptKey: scriptData.scriptKey.toString(),
        fileName: scriptData.fileName,
        textVersion: scriptData.editorUpdate?.textVersion.toString(),
        stateRevision: scriptData.editorUpdate?.stateRevision.toString(),
        nativeTextVersion: scriptData.scriptSession.getTextVersion?.().toString(),
        analysisOutdated: scriptData.analysisOutdated.toString(),
        analysisAvailable: scriptData.editorUpdate?.analysisAvailable.toString(),
        textLength: scriptData.scriptSession.getText?.().length.toString(),
    }, LOG_CTX);
    const compiled = scriptData.scriptSession.compileQuery(executionFormattingConfig(connectorType));
    try {
        const reader = compiled.read();
        const sql = reader.sql() ?? '';
        if (reader.errorsLength() > 0 && sql.length > 0) {
            logger?.warn('Passing unparseable SQL through to the remote database', {
                scriptKey: scriptData.scriptKey.toString(),
                fileName: scriptData.fileName,
                diagnostic: reader.errors(0)?.message() ?? '',
            }, LOG_CTX);
        } else if (reader.errorsLength() > 0) {
            const error = reader.errors(0);
            throw new LoggableException(error?.message() ?? 'Could not compile query', {
                scriptKey: scriptData.scriptKey.toString(),
                fileName: scriptData.fileName,
                errorCode: error?.code().toString(),
            }, LOG_CTX);
        }
        if (sql.trim().length == 0) {
            throw new LoggableException('Compile query is empty', {
                scriptKey: scriptData.scriptKey.toString(),
                fileName: scriptData.fileName,
                script: scriptData.scriptSession.getText(),
            }, LOG_CTX);
        }
        logger?.debug('Compiled script for query execution', {
            scriptKey: scriptData.scriptKey.toString(),
            sqlLength: sql.length.toString(),
        }, LOG_CTX);
        return {
            sql,
            cacheSignature: reader.cacheSignature() ?? '',
            cacheable: reader.cacheable(),
        };
    } finally {
        compiled.destroy();
    }
}

export function createScriptExecution(scriptData: ScriptData, connectorType: ConnectorType): core.DashQLScriptExecution {
    return scriptData.scriptSession.startExecution(executionFormattingConfig(connectorType));
}

function executionFormattingConfig(connectorType: ConnectorType): core.buffers.formatting.FormattingConfigT {
    return new core.buffers.formatting.FormattingConfigT(
        connectorType === ConnectorType.TRINO
            ? core.buffers.formatting.FormattingDialect.TRINO
            : core.buffers.formatting.FormattingDialect.HYPER,
        core.buffers.formatting.FormattingMode.INLINE,
        120,
        2,
        false,
    );
}

function compileVisualizeQuery(scriptSession: core.DashQLScriptSession, connectorType: ConnectorType,
    logger?: LoggerLike): ResolvedVisualizeQuery | null {
    const compiled = scriptSession.compileQuery(executionFormattingConfig(connectorType));
    try {
        const reader = compiled.read();
        if (reader.errorsLength() > 0 ||
            reader.kind() !== core.buffers.execution.ScriptCompilationStatementKind.VISUALIZE) {
            return null;
        }
        const sql = reader.sql();
        const visualization = reader.visualization();
        if (!sql || !visualization) return null;
        logger?.debug('Compiled visualization for execution', { sql }, LOG_CTX);
        return resolveCompiledVisualization(sql, visualization.unpack());
    } finally {
        compiled.destroy();
    }
}

export function resolveCompiledVisualization(
    sql: string,
    visualization: core.buffers.execution.CompiledVisualizationT,
): ResolvedVisualizeQuery | null {
    const dashboardSpec = visualization.dashboard ?? null;
    switch (visualization.renderer) {
        case 'umap': {
            const umapSpec = visualization.umapSpec;
            return umapSpec && typeof umapSpec.vectorColumn === 'string' && umapSpec.vectorColumn.length > 0
                ? { renderer: 'umap', sql, umapSpec, dashboardSpec }
                : null;
        }
        case 'markdown': {
            const markdownSpec = visualization.markdownSpec;
            return markdownSpec?.document ? { renderer: 'markdown', sql, markdownSpec, dashboardSpec } : null;
        }
        case 'vegalite': {
            const raw = visualization.vegaliteSpec;
            if (!raw) return null;
            try {
                return { renderer: 'vegalite', sql, vegaLiteSpec: JSON.parse(String(raw)), dashboardSpec };
            } catch {
                return null;
            }
        }
        case 'table':
            return { renderer: 'table', sql, dashboardSpec };
        default:
            return null;
    }
}

/// Compute a staged, statement-level semantic diff from a script's prior text to a new text.
///
/// `sourceSession` still holds the old text and analysis. The new text is loaded into a throwaway
/// target script created in a fresh catalog so it
/// never touches the session's catalog. Returns null (and logs) on any failure, so a diff problem
/// never blocks applying the rewrite. The returned FlatBufferPtr is owned by the caller (stored on
/// ScriptData.pendingDiff, freed when the diff is superseded, accepted/rejected, or the script is
/// destroyed).
function computePendingDiff(
    instance: core.DashQL,
    sourceSession: core.DashQLScriptSession,
    newText: string,
    priorText: string,
    logger: Logger,
): DashQLPendingDiff | null {
    let targetCatalog: core.DashQLCatalog | null = null;
    let targetScript: core.DashQLScript | null = null;
    try {
        // Ensure the source session is parsed (the diff walks the parsed AST).
        const analysis = sourceSession.analyze();
        if (analysis.status !== core.buffers.editor.EditorUpdateStatus.OK || !analysis.analysisAvailable) {
            throw new Error('Failed to analyze source script for diff');
        }
        // Seed a throwaway target with the new text in its own catalog (kept out of the session's).
        targetCatalog = instance.createCatalog();
        targetScript = instance.createScript(targetCatalog);
        targetScript.insertTextAt(0, newText);
        targetScript.parse();
        const diffBuffer = sourceSession.computeDiff(targetScript);
        return { priorText, diffBuffer };
    } catch (e: any) {
        logger.warn("Failed to compute script diff", { error: stringifyError(e) }, LOG_CTX);
        return null;
    } finally {
        targetScript?.destroy();
        targetCatalog?.destroy();
    }
}

export function analyzeScriptData(scriptData: ScriptData, logger: Logger): ScriptData {
    const next: ScriptData = { ...scriptData };

    // Analyze the script
    // Capture the underlying failure so callers can log it with session/script context
    // instead of writing it directly to the console.
    const update = next.scriptSession.analyze();
    if (update.status !== core.buffers.editor.EditorUpdateStatus.OK || !update.analysisAvailable) {
        throw new Error(typeof update.statusMessage === 'string' && update.statusMessage.length > 0
            ? update.statusMessage
            : "Failed to analyze script");
    }
    next.analysisOutdated = false;
    next.editorUpdate = update;
    // Rotate the script statistics
    if (update.analysisUpdated) {
        next.statistics = rotateScriptStatistics(next.statistics, update.processingStatistics);
    }
    // Derive script annotations (incl. resolved VISUALIZE query)
    next.annotations = deriveScriptAnnotations(
        update,
        next.scriptSession,
        next.connection.connectorInfo.connectorType,
        logger,
    );

    next.scriptSession.loadIntoCatalog(next.scriptKey);
    return next;
}

export function replaceScriptSessionText(scriptSession: core.DashQLScriptSession, text: string): void {
    const update = scriptSession.replaceText(scriptSession.getTextVersion(), text);
    if (update.status !== core.buffers.editor.EditorUpdateStatus.OK) {
        const status = core.buffers.editor.EditorUpdateStatus[update.status] ?? update.status.toString();
        throw new Error(`Failed to replace editor session text: ${status}`);
    }
}

export function analyzeOutdatedScript<V extends SessionScripts>(state: V, scriptKey: number, logger: Logger): V {
    const scriptData = state.scripts[scriptKey];
    if (!scriptData || !scriptData.analysisOutdated) {
        return state;
    }
    // Create the next session scripts state
    const nextScriptData = analyzeScriptData(scriptData, logger);
    const next = {
        ...state,
        scripts: {
            ...state.scripts,
            [scriptKey]: nextScriptData
        }
    };

    // Only the selected script drives the semantic focus.
    // Scripts in the background are re-analyzed whenever another script changes and must not steal it.
    if (getSelectedScriptRef(state)?.scriptId === scriptKey) {
        next.semanticUserFocus = deriveFocusFromEditorUpdate(scriptKey, nextScriptData.editorUpdate);
    }
    return next;
}
