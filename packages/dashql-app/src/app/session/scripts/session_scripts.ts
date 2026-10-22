import * as core from '@ankoh/dashql-core';
import * as Immutable from 'immutable';

import { DashQLCompletionState, DashQLPendingDiff, DashQLProcessorUpdateOut } from './editor/dashql_processor.js';
import { deriveFocusFromCompletionCandidates, deriveFocusFromEditorUpdate, SemanticUserFocus } from './focus.js';
import { ConnectorInfo, ConnectorType } from '../connections/connector_info.js';
import { VariantKind } from '../../../utils/index.js';
import {
    DEBOUNCE_DURATION_SCRIPT_WRITE,
    DEBOUNCE_DURATION_SESSION_WRITE,
    DELETE_SCRIPT as STORAGE_DELETE_SCRIPT,
    groupSessionManifestWrites,
    groupSessionWrites,
    groupScriptDeletes,
    groupScriptRenames,
    groupScriptWrites,
    RENAME_SCRIPT as STORAGE_RENAME_SCRIPT,
    StorageWriter,
    WRITE_SESSION_PROPERTIES,
    WRITE_SCRIPT,
} from '../persistence/storage_writer.js';
import type { SessionScriptsInput } from './session_scripts_registry.js';
import type { SessionSettings } from './session_settings.js';
import { Logger, LoggerLike, LoggableException, stringifyError } from '../../../platform/logger/logger.js';
import { ScriptAnnotations, ScriptRef, SessionMetadata as SessionMetadataType, ResolvedVisualizeQuery, createEmptyAnnotations, createScriptRef, planScriptInsertion, normalizeScriptName, scriptOrderPrefixString, formatScriptOrderPrefix, scriptDisplayName, uniqueScriptBase } from './script_types.js';

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
    /// Attached database whose catalog backs script analysis.
    databaseId: string;
    /// The session metadata
    sessionMetadata: SessionMetadataType;
    /// The connector info
    connectorInfo: ConnectorInfo;
    /// The connection catalog
    connectionCatalog: core.DashQLCatalog;
    /// The scripts
    scripts: ScriptDataMap;
    /// Committed cells keyed by their ordered file name.
    scriptRefs: { [fileName: string]: ScriptRef };
    /// The session focus (selected cell by file name)
    scriptFocus: ScriptFocus;
    /// The semantic user focus info (if any)
    semanticUserFocus: SemanticUserFocus | null;
}

/// Storage-shaped session content used when an external filesystem change replaces the persisted
/// session. Keeping this type here prevents the native watcher from knowing about WASM lifetime
/// and catalog invariants.
export interface SessionScriptsStorageSnapshot {
    scripts: Array<{ name: string; sql: string }>;
}

export function sessionScriptsMatchStorageSnapshot(state: SessionScripts, snapshot: SessionScriptsStorageSnapshot): boolean {
    const diskScripts = new Map(snapshot.scripts.map(script => [script.name, script.sql]));
    if (Object.keys(state.scriptRefs).length !== diskScripts.size) {
        return false;
    }
    for (const [fileName, ref] of Object.entries(state.scriptRefs)) {
        if (diskScripts.get(fileName) !== state.scripts[ref.scriptId]?.scriptSession.getText()) {
            return false;
        }
    }
    return true;
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

export type SessionScriptsAction =
    | VariantKind<typeof SELECT_NEXT_SCRIPT, null>
    | VariantKind<typeof SELECT_PREV_SCRIPT, null>
    | VariantKind<typeof SELECT_SCRIPT, string>
    | VariantKind<typeof ANALYZE_OUTDATED_SCRIPT, ScriptKey>
    | VariantKind<typeof APPLY_PLANNER_ANALYSIS, Array<{ scriptKey: number; editorUpdate: core.buffers.editor.EditorUpdateT }>>
    | VariantKind<typeof UPDATE_FROM_PROCESSOR, DashQLProcessorUpdateOut>
    | VariantKind<typeof CATALOG_DID_UPDATE, null>
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
    ;

const STATS_HISTORY_LIMIT = 20;

export function createEmptyScriptData(instance: core.DashQL, catalog: core.DashQLCatalog, fileName: string = ''): [number, ScriptData] {
    const scriptSession = instance.createScriptSession(catalog);
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
    };
    return [scriptKey, scriptData];
}

enum FocusUpdate {
    Clear,
    UpdateFromCursor,
    UpdateFromCompletion,
};

/// Returns the naturally ordered cell file names.
///
/// File names may carry a numeric ordering prefix ("2_extract.sql"); sorting numerically (matching
/// the storage backends' natural sort on load) yields the intended feed order and keeps a script in
/// place when its prefix width grows (e.g. "9_x.sql" before "10_y.sql").
export function getSortedScriptFileNames(scriptRefs: { [fileName: string]: ScriptRef }): string[] {
    return Object.keys(scriptRefs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/// Returns the committed cells, sorted by file name.
export function getSelectedScriptRefs(state: SessionScripts): ScriptRef[] {
    return getSortedScriptFileNames(state.scriptRefs).map(name => state.scriptRefs[name]);
}

/// Returns the currently selected cell, or the first cell when focus is unset.
export function getSelectedScriptRef(state: SessionScripts): ScriptRef | undefined {
    const file = state.scriptFocus.fileName;
    if (file && state.scriptRefs[file]) return state.scriptRefs[file];
    const files = getSortedScriptFileNames(state.scriptRefs);
    return files.length > 0 ? state.scriptRefs[files[0]] : undefined;
}

/// Returns the index of the selected entry in the sorted entry list, or -1.
export function getSelectedScriptIndex(state: SessionScripts): number {
    const file = state.scriptFocus.fileName;
    if (!file) return -1;
    const files = getSortedScriptFileNames(state.scriptRefs);
    return files.indexOf(file);
}

/// Apply a script re-pad plan (from planScriptInsertion) to a page in place: rename the listed
/// scripts in the page-scripts map and the scripts map, follow the focused file, and persist each as
/// delete-old + write-new. Re-padding only changes a script's prefix width (and normalises a legacy
/// "-" separator), never its clean name.
/// Returns the updated maps and focus; the caller weaves them into the new state it is building.
function applyScriptRepad(
    repad: { oldFileName: string; newFileName: string }[],
    scriptRefs: { [fileName: string]: ScriptRef },
    scripts: ScriptDataMap,
    focusFileName: string,
    sessionId: string,
    storage: StorageWriter | null,
    reservedFileNames: ReadonlySet<string> = new Set(),
): { scriptRefs: { [fileName: string]: ScriptRef }; scripts: ScriptDataMap; focusFileName: string } {
    if (repad.length === 0) {
        return { scriptRefs, scripts, focusFileName };
    }
    const nextScriptRefs = { ...scriptRefs };
    const nextScripts = { ...scripts };
    let nextFocus = focusFileName;
    const movedEntries = repad.map(({ oldFileName, newFileName }) => ({
        oldFileName,
        newFileName,
        entry: scriptRefs[oldFileName],
    })).filter(move => move.entry != null);
    // Remove all source paths before installing targets. Indexed insertion shifts adjacent numeric
    // prefixes, so a target can otherwise overwrite an entry that a later move still needs to read.
    for (const { oldFileName } of movedEntries) {
        delete nextScriptRefs[oldFileName];
    }
    // A re-pad target path that is also some entry's source path must not be deleted: the write for
    // that path already carries the correct content, and the delete (a separate keyspace from the
    // write) would otherwise race it and could clobber the file on disk. This guards the mixed
    // width/separator legacy case where clean names are not unique within the page.
    const targetFiles = new Set([...movedEntries.map(r => r.newFileName), ...reservedFileNames]);
    for (const { oldFileName, newFileName, entry } of movedEntries) {
        nextScriptRefs[newFileName] = { ...entry, fileName: newFileName };
        const sd = nextScripts[entry.scriptId];
        if (sd) nextScripts[entry.scriptId] = { ...sd, fileName: newFileName };
        if (nextFocus === oldFileName) nextFocus = newFileName;
        // Suppress the delete (but never the write) when this entry's old path is reused as another
        // entry's new path — the write for it already carries the correct content.
        if (!targetFiles.has(oldFileName)) {
            storage?.write(
                groupScriptDeletes(sessionId, oldFileName),
                { type: STORAGE_DELETE_SCRIPT, value: [sessionId, oldFileName] },
                DEBOUNCE_DURATION_SCRIPT_WRITE
            );
        }
        const sql = nextScripts[entry.scriptId]?.scriptSession.getText() ?? '';
        storage?.write(
            groupScriptWrites(sessionId, newFileName),
            { type: WRITE_SCRIPT, value: [sessionId, newFileName, sql] },
            DEBOUNCE_DURATION_SCRIPT_WRITE
        );
    }
    return { scriptRefs: nextScriptRefs, scripts: nextScripts, focusFileName: nextFocus };
}

function writeSessionProperties(state: SessionScripts, storage: StorageWriter) {
    void storage.write(
        groupSessionManifestWrites(state.sessionId),
        { type: WRITE_SESSION_PROPERTIES, value: [state.sessionId, { name: state.name, settings: state.settings }] },
        DEBOUNCE_DURATION_SESSION_WRITE,
    );
}

export function reduceSessionScripts(state: SessionScripts, action: SessionScriptsAction, storageArg: StorageWriter, logger: Logger, _active: boolean): SessionScripts {
    // Session files are local state, independent of connection setup and health.
    const storage = storageArg;
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
            const files = getSortedScriptFileNames(state.scriptRefs);
            const cur = files.indexOf(state.scriptFocus.fileName);
            const nextIdx = Math.min(Math.max(cur, 0) + 1, files.length - 1);
            const fileName = files[nextIdx] ?? state.scriptFocus.fileName;
            return {
                ...clearSemanticUserFocus(state),
                scriptFocus: { ...state.scriptFocus, fileName },
            };
        }
        case SELECT_PREV_SCRIPT: {
            const files = getSortedScriptFileNames(state.scriptRefs);
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
                        state.connectorInfo.connectorType, logger),
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
                    state.connectorInfo.connectorType, logger);
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
                // Mark all other scripts as outdated.
                // Eventually, we could restrict to those that are depending?
                markOtherScriptsOutdatedInPlace(nextState.scripts, update.scriptKey);
            }
            // Persist only when the document text changed. Cursor/completion updates
            // still flow through this action but must not rewrite identical SQL.
            if (documentChanged) {
                const scriptKey = update.scriptKey;
                const scriptData = nextState.scripts[scriptKey];
                if (scriptData?.fileName) {
                    const sql = scriptData.scriptSession.getText();
                    storage?.write(
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
            const remainingFiles = getSortedScriptFileNames(state.scriptRefs).filter(name => name !== deletedFileName);
            const scriptRefs = { ...state.scriptRefs };
            delete scriptRefs[deletedFileName];

            // Adjust focus if needed
            let newFile = state.scriptFocus.fileName;
            if (newFile === deletedFileName) {
                const oldIdx = getSortedScriptFileNames(state.scriptRefs).indexOf(deletedFileName);
                newFile = remainingFiles[Math.max(0, oldIdx - 1)] ?? remainingFiles[0] ?? '';
            }

            const next = destroyDeadScripts({
                ...clearSemanticUserFocus(state),
                scriptRefs,
                scriptFocus: { ...state.scriptFocus, fileName: newFile },
            });
            storage?.write(
                groupScriptDeletes(next.sessionId, deletedEntry.fileName),
                { type: STORAGE_DELETE_SCRIPT, value: [next.sessionId, deletedEntry.fileName] },
                DEBOUNCE_DURATION_SCRIPT_WRITE
            );
            return next;
        }

        case CREATE_SCRIPT: {
            // Null appends; an index inserts at that feed boundary. Text seeds the new script, e.g. from the composer.
            const { index, text } = action.value;
            const plan = planScriptInsertion(state.scriptRefs, undefined, index ?? undefined);
            const fileName = plan.newFileName;
            const repadded = applyScriptRepad(
                plan.repad,
                state.scriptRefs,
                state.scripts,
                state.scriptFocus.fileName,
                state.sessionId,
                storage,
                new Set([fileName]),
            );

            // Create a new script
            const scriptSession = state.instance.createScriptSession(state.connectionCatalog);
            const scriptKey = scriptSession.getCatalogEntryId();
            // Create script data
            let scriptData: ScriptData = {
                scriptKey,
                scriptSession,
                analysisOutdated: true,
                statistics: Immutable.List(),
                annotations: createEmptyAnnotations(),
                completion: null,
                pendingDiff: null,
                latestQueryId: null,
                latestResultQueryId: null,
                fileName,
            };
            const scripts: ScriptDataMap = { ...repadded.scripts };
            if (text) {
                // Analyze right away so the script can be executed without waiting for an editor,
                // and mark the others outdated since the new script was loaded into the catalog.
                replaceScriptSessionText(scriptSession, text);
                scriptData = analyzeScriptData(scriptData, state.connectionCatalog, logger,
                    state.connectorInfo.connectorType);
                for (const key in scripts) {
                    scripts[key] = { ...scripts[key], analysisOutdated: true };
                }
            }
            scripts[scriptKey] = scriptData;

            const entry: ScriptRef = createScriptRef(scriptKey, fileName);

            const next: SessionScripts = {
                ...clearSemanticUserFocus(state),
                scripts,
                scriptRefs: { ...repadded.scriptRefs, [fileName]: entry },
                scriptFocus: { ...state.scriptFocus, fileName },
            };
            storage?.write(
                groupScriptWrites(next.sessionId, fileName),
                { type: WRITE_SCRIPT, value: [next.sessionId, fileName, text ?? ''] },
                DEBOUNCE_DURATION_SCRIPT_WRITE
            );
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
            // The rename input edits the display name. Drop any prefix / ".sql" the user included,
            // disambiguate it against the other scripts, then re-attach this script's existing
            // ordering prefix and the ".sql" extension. An empty base is ignored.
            const requestedBase = scriptDisplayName(requestedName.trim());
            if (!requestedBase) {
                return state;
            }
            const cleanBase = uniqueScriptBase(requestedBase, state.scriptRefs, oldFileName);
            const newFileName = `${scriptOrderPrefixString(oldFileName)}${cleanBase}.sql`;
            const renamed = oldFileName !== newFileName;
            const renamedEntry: ScriptRef = { ...entry, fileName: newFileName };
            const scriptRefs = { ...state.scriptRefs };
            if (renamed) delete scriptRefs[oldFileName];
            scriptRefs[newFileName] = renamedEntry;

            // Update the script data fileName and re-analyze immediately with the new path.
            const scriptId = entry.scriptId;
            const updatedScriptData = state.scripts[scriptId];
            const newScripts = { ...state.scripts };
            if (updatedScriptData) {
                const renamedScriptData: ScriptData = { ...updatedScriptData, fileName: newFileName };
                if (renamed) {
                    newScripts[scriptId] = analyzeScriptData(renamedScriptData, state.connectionCatalog, logger,
                        state.connectorInfo.connectorType);
                    for (const key in newScripts) {
                        if (+key === scriptId) continue;
                        const other = newScripts[key];
                        newScripts[key] = {
                            ...other,
                            analysisOutdated: true,
                        };
                    }
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
                scripts: newScripts,
                scriptFocus: { ...state.scriptFocus, fileName: focusFile },
            };
            if (renamed) {
                // Rename the file in place: its SQL is unchanged, so move it rather than delete-old +
                // rewrite-new. The new clean base is disambiguated unique within the page, so the
                // rename target never collides with another script's existing name.
                storage?.write(
                    groupScriptRenames(next.sessionId, oldFileName),
                    { type: STORAGE_RENAME_SCRIPT, value: [next.sessionId, oldFileName, newFileName] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
            } else {
                // No rename: just persist the current contents under the unchanged name.
                const sql = updatedScriptData ? updatedScriptData.scriptSession.getText() : '';
                storage?.write(
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
            const currentOrder = getSortedScriptFileNames(state.scriptRefs);
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

            // Assign a dense ordering prefix to each script in the new order, keeping its clean name.
            // A script already at its target name is left untouched (no rename, no disk churn).
            const total = order.length;
            const renames: { oldFile: string; newFile: string }[] = [];
            const newScriptRefs: { [fileName: string]: ScriptRef } = {};
            const newScripts: ScriptDataMap = { ...state.scripts };
            for (let i = 0; i < order.length; ++i) {
                const oldFile = order[i];
                const entry = state.scriptRefs[oldFile];
                const newFile = `${formatScriptOrderPrefix(i + 1, total)}${normalizeScriptName(oldFile)}`;
                if (newFile === oldFile) {
                    newScriptRefs[oldFile] = entry;
                    continue;
                }
                renames.push({ oldFile, newFile });
                const sd = newScripts[entry.scriptId];
                if (sd) newScripts[entry.scriptId] = { ...sd, fileName: newFile };
                newScriptRefs[newFile] = { ...entry, fileName: newFile };
            }

            if (renames.length === 0) {
                return state;
            }

            const renamedFocus = renames.find(r => r.oldFile === state.scriptFocus.fileName)?.newFile;
            const newFocusFile = renamedFocus ?? state.scriptFocus.fileName;

            const next: SessionScripts = {
                ...state,
                scriptRefs: newScriptRefs,
                scripts: newScripts,
                scriptFocus: { ...state.scriptFocus, fileName: newFocusFile },
            };

            // Persist each moved script as delete-old + write-new (no atomic file rename exists; this
            // mirrors RENAME_SCRIPT). Deletes and writes use distinct group keys. Clean file
            // names are NOT guaranteed unique within a page (legacy "01-script.sql"/"02-script.sql"
            // both clean to "script", and the re-pad normaliser can produce "1_script.sql"/
            // "2_script.sql"), so a permutation can map one script's new name onto another's old name
            // (e.g. swapping "1_script.sql" and "2_script.sql"). For any such reused path the write
            // already rewrites it with the moved script's content, so its delete must be suppressed —
            // otherwise the delete (on a separate keyspace from the write) races the write and can
            // clobber the file on disk.
            const targetFiles = new Set(renames.map(r => r.newFile));
            for (const { oldFile } of renames) {
                if (targetFiles.has(oldFile)) continue;
                storage?.write(
                    groupScriptDeletes(next.sessionId, oldFile),
                    { type: STORAGE_DELETE_SCRIPT, value: [next.sessionId, oldFile] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
            }
            for (const { newFile } of renames) {
                const entry = newScriptRefs[newFile];
                const sd = newScripts[entry.scriptId];
                const sql = sd ? sd.scriptSession.getText() : '';
                storage?.write(
                    groupScriptWrites(next.sessionId, newFile),
                    { type: WRITE_SCRIPT, value: [next.sessionId, newFile, sql] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
            }
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
            const nextScriptData = analyzeScriptData(scriptData, state.connectionCatalog, logger,
                state.connectorInfo.connectorType);
            nextScriptData.pendingDiff = pendingDiff;

            const nextState: SessionScripts = {
                ...clearSemanticUserFocus(state),
                scripts: {
                    ...state.scripts,
                    [scriptKey]: nextScriptData,
                },
            };
            // The text changed and was reloaded into the catalog; mark all other scripts
            // outdated so cross-script references re-resolve (mirrors UPDATE_FROM_PROCESSOR).
            for (const key in nextState.scripts) {
                if (+key === scriptKey) continue;
                const other = nextState.scripts[key];
                nextState.scripts[key] = {
                    ...other,
                    analysisOutdated: true,
                };
            }

            // Persist only the updated script (same tail as UPDATE_FROM_PROCESSOR)
            const sql = nextScriptData.scriptSession.getText();
            if (nextScriptData.fileName) {
                storage?.write(
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
            const nextScriptData = analyzeScriptData(scriptData, state.connectionCatalog, logger,
                state.connectorInfo.connectorType);
            nextScriptData.pendingDiff = null;

            const nextState: SessionScripts = {
                ...clearSemanticUserFocus(state),
                scripts: {
                    ...state.scripts,
                    [scriptKey]: nextScriptData,
                },
            };
            // The text changed and was reloaded into the catalog; mark all other scripts
            // outdated so cross-script references re-resolve (mirrors SET_SCRIPT_TEXT).
            for (const key in nextState.scripts) {
                if (+key === scriptKey) continue;
                const other = nextState.scripts[key];
                nextState.scripts[key] = {
                    ...other,
                    analysisOutdated: true,
                };
            }

            // Persist only the updated script (same tail as SET_SCRIPT_TEXT)
            const sql = nextScriptData.scriptSession.getText();
            if (nextScriptData.fileName) {
                storage?.write(
                    groupScriptWrites(nextState.sessionId, nextScriptData.fileName),
                    { type: WRITE_SCRIPT, value: [nextState.sessionId, nextScriptData.fileName, sql] },
                    DEBOUNCE_DURATION_SCRIPT_WRITE
                );
            }
            return nextState;
        }

    }
}

export function clearSemanticUserFocus<V extends SessionScriptsInput>(state: V): V {
    return { ...state, semanticUserFocus: null };
}

/// Mark all scripts except one as outdated in a scripts map that the caller already owns.
///
/// Scripts that are already outdated keep their identity.
/// This runs for every keystroke and every new ScriptData object re-renders its editor and card.
function markOtherScriptsOutdatedInPlace(scripts: ScriptDataMap, except: ScriptKey) {
    for (const key in scripts) {
        if (+key === except) continue;
        const script = scripts[key];
        if (script.analysisOutdated) continue;
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
/// Scripts that remain at the same page/file path retain their WASM identity, query history and UI
/// references. Added and removed paths allocate/free their WASM state here, where the catalog and
/// script-registry lifetime rules are already centralized.
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

    const scripts: ScriptDataMap = {};
    const scriptRefs: { [fileName: string]: ScriptRef } = {};
    let contentChanged = false;

    for (const stored of snapshot.scripts) {
            let scriptData = existingByPath.get(stored.name);
            if (scriptData) {
                existingByPath.delete(stored.name);
                if (scriptData.scriptSession.getText() !== stored.sql) {
                    scriptData.pendingDiff?.diffBuffer.destroy();
                    scriptData.completion?.buffer.destroy();
                    replaceScriptSessionText(scriptData.scriptSession, stored.sql);
                    scriptData = {
                        ...scriptData,
                        pendingDiff: null,
                        completion: null,
                        analysisOutdated: true,
                    };
                    contentChanged = true;
                }
            } else {
                const [scriptKey, created] = createEmptyScriptData(state.instance, state.connectionCatalog, stored.name);
                replaceScriptSessionText(created.scriptSession, stored.sql);
                scriptData = created;
                contentChanged = true;
            }
            scripts[scriptData.scriptKey] = scriptData;
            scriptRefs[stored.name] = createScriptRef(scriptData.scriptKey, stored.name);
    }

    // Files no longer present on disk own WASM objects that must be detached before destruction.
    for (const removed of existingByPath.values()) {
        try {
            removed.scriptSession.dropFromCatalog();
        } catch {
            // The script may not have completed analysis and therefore may not be in the catalog.
        }
        destroyScriptData(removed);
        contentChanged = true;
    }

    const files = getSortedScriptFileNames(scriptRefs);
    const previousFile = state.scriptFocus.fileName;
    const fileName = scriptRefs[previousFile] ? previousFile : (files[0] ?? '');

    let next: SessionScripts = {
        ...clearSemanticUserFocus(state),
        scripts,
        scriptRefs,
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
        tableRefs: [],
        tableDefs: tableDefsFlat,
        restrictedColumns: [],
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

export function compileQuery(scriptData: ScriptData, connectorType: ConnectorType, logger?: LoggerLike): string {
    return compileSessionQuery(scriptData, connectorType, logger).sql;
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

export function analyzeScriptData(scriptData: ScriptData, _catalog: core.DashQLCatalog, logger: Logger,
    connectorType: ConnectorType): ScriptData {
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
        connectorType,
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

export function analyzeOutdatedScript<V extends SessionScriptsInput>(state: V, scriptKey: number, logger: Logger): V {
    const scriptData = state.scripts[scriptKey];
    if (!scriptData || !scriptData.analysisOutdated) {
        return state;
    }
    // Create the next session scripts state
    const nextScriptData = analyzeScriptData(scriptData, state.connectionCatalog, logger,
        state.connectorInfo.connectorType);
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
