import * as React from 'react';
import * as styles from './script_details.module.css';
import * as dashql from '@ankoh/dashql-core';
import { EditorView } from '@codemirror/view';
import { DashQLCompletionAbortEffect, DashQLCompletionStatus, DashQLProcessorPlugin } from '../scripts/editor/dashql_processor.js';

import type { Icon } from '../../../ui/foundations/symbol_icon.js';

import { KeyEventHandler, useKeyEvents } from '../../../utils/key_events.js';
import { ConnectionHealth, AttachedDatabaseState } from '../connections/attached_database_state.js';
import { useCancelQuery, useQueryState, useQueryExecutor } from '../connections/query_executor.js';
import { QueryExecutionStatus } from '../connections/query_execution_state.js';
import { ScriptDetailsTab } from './script_output_details.js';
import { QueryResultCacheLabel, QueryResultRerunButton } from './query_result_cache_controls.js';
import {
    ACCEPT_PENDING_DIFF,
    DELETE_SCRIPT,
    getSelectedScriptRef,
    NotebookScripts,
    REJECT_PENDING_DIFF,
    RENAME_SCRIPT,
    SELECT_SCRIPT,
    SET_SCRIPT_TEXT,
} from '../scripts/notebook_scripts.js';
import { runNotebookScript } from './rerun_query.js';
import { useNotebookExecution } from '../scripts/notebook_execution_provider.js';
import { useStorageReader } from '../persistence/storage_provider.js';
import { scriptDisplayName } from '../scripts/script_types.js';
import type { ModifyNotebookScripts } from '../scripts/notebook_scripts_registry.js';
import { useAppConfig } from '../../config/app_config.js';
import { acceptPendingDiff, rejectPendingDiff } from '../scripts/editor/dashql_diff_hint.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { ScriptDiagnosticsButton } from './script_diagnostics.js';
import { formatScriptEditor, formattingDialectForConnector, getKeywordCase, isScriptFormattable } from './script_format.js';
import { ScriptActionMenu } from './script_action_menu.js';
import { ScriptDetailsEditorPane, ScriptDetailsOutputPane } from './script_details_panes.js';
import { VerticalSplit } from '../../../ui/foundations/vertical_split.js';
import { NotebookConnectionAttentionContext } from './notebook_connection_attention.js';

export { ScriptDetailsTab as TabKey };

export interface ScriptDetailsProps {
    notebookScripts: NotebookScripts;
    modifyNotebookScripts: ModifyNotebookScripts;
    connection: AttachedDatabaseState | null;
    hideDetails: () => void;
    scriptId?: number;
    initialTab?: ScriptDetailsTab;
    navigateToScript?: (scriptKey: number) => void;
    dependencies?: ScriptDetailsDependencies;
}

export interface ScriptDetailsDependencies {
    useAppConfig: typeof useAppConfig;
    useLogger: typeof useLogger;
    useKeyEvents: typeof useKeyEvents;
    useQueryState: typeof useQueryState;
    useCancelQuery: typeof useCancelQuery;
    useQueryExecutor: typeof useQueryExecutor;
    useStorageReader: typeof useStorageReader;
    formatScriptEditor: typeof formatScriptEditor;
    isScriptFormattable: typeof isScriptFormattable;
    runNotebookScript: typeof runNotebookScript;
    ScriptDetailsEditorPane: typeof ScriptDetailsEditorPane;
    ScriptDetailsOutputPane: typeof ScriptDetailsOutputPane;
    VerticalSplit: typeof VerticalSplit;
}

const DEFAULT_DEPENDENCIES: ScriptDetailsDependencies = {
    useAppConfig,
    useLogger,
    useKeyEvents,
    useQueryState,
    useCancelQuery,
    useQueryExecutor,
    useStorageReader,
    formatScriptEditor,
    isScriptFormattable,
    runNotebookScript,
    ScriptDetailsEditorPane,
    ScriptDetailsOutputPane,
    VerticalSplit,
};

export const ScriptDetails: React.FC<ScriptDetailsProps> = (props) => {
    const notebookExecution = useNotebookExecution(props.notebookScripts.notebookId);
    const connectionAttention = React.useContext(NotebookConnectionAttentionContext);
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const config = dependencies.useAppConfig();
    const logger = dependencies.useLogger();
    const [editorView, setEditorView] = React.useState<EditorView | null>(null);

    const notebookEntry = props.scriptId != null
        ? Object.values(props.notebookScripts.scriptRefs).find(entry => entry.scriptId === props.scriptId)
        : getSelectedScriptRef(props.notebookScripts);
    const scriptData = notebookEntry != null ? props.notebookScripts.scripts[notebookEntry.scriptId] : null;
    const hasExecution = scriptData?.latestQueryId != null;
    const [resultExpanded, setResultExpanded] = React.useState(hasExecution);

    // Get folder name and script file name (display-only: strip the on-disk ordering prefix). The
    // raw scriptFileName stays the rename identity; the label and draft use the clean display name
    // (no prefix, no ".sql").
    const scriptFileName = notebookEntry?.fileName ?? '01-script.sql';
    const scriptDisplay = scriptDisplayName(scriptFileName);

    const PencilIcon: Icon = SymbolIcon('pencil_16');
    const CheckIcon: Icon = SymbolIcon('check_16');
    const FormatXIcon: Icon = SymbolIcon('x_16');
    const [isEditingName, setIsEditingName] = React.useState(false);
    const [draftFileName, setDraftFileName] = React.useState(scriptDisplay);
    const editInputRef = React.useRef<HTMLInputElement>(null);

    const startEditingName = React.useCallback((event?: React.MouseEvent) => {
        event?.stopPropagation();
        setDraftFileName(scriptDisplay);
        setIsEditingName(true);
    }, [scriptDisplay]);

    const saveNameEdit = React.useCallback(() => {
        const trimmed = draftFileName.trim();
        if (trimmed && trimmed !== scriptDisplay) {
            props.modifyNotebookScripts({ type: RENAME_SCRIPT, value: { fileName: scriptFileName, newFileName: trimmed } });
        }
        setIsEditingName(false);
    }, [draftFileName, scriptDisplay, scriptFileName, props.modifyNotebookScripts]);

    const cancelNameEdit = React.useCallback(() => {
        setIsEditingName(false);
    }, []);

    React.useEffect(() => {
        if (isEditingName && editInputRef.current) {
            editInputRef.current.focus();
            editInputRef.current.select();
        }
    }, [isEditingName]);

    React.useEffect(() => {
        setIsEditingName(false);
        setResultExpanded(hasExecution);
    }, [notebookEntry?.scriptId, hasExecution]);

    const formattingDebugMode = config?.settings?.formattingDebugMode ?? false;
    const keywordCase = getKeywordCase(config?.settings);
    const formattingDialect = formattingDialectForConnector(props.notebookScripts.connectorInfo?.connectorType);
    const isFormattable = React.useMemo(
        () => dependencies.isScriptFormattable(scriptData, formattingDialect),
        [scriptData?.scriptSession, scriptData?.editorUpdate?.textVersion, formattingDialect],
    );
    const handleFormat = React.useCallback((mode: dashql.buffers.formatting.FormattingMode) => {
        dependencies.formatScriptEditor(editorView, scriptData, mode, (text) => {
            if (scriptData == null) return;
            props.modifyNotebookScripts({
                type: SET_SCRIPT_TEXT,
                value: { scriptKey: scriptData.scriptKey, text, withDiff: true },
            });
        }, formattingDebugMode, keywordCase, formattingDialect);
    }, [editorView, formattingDebugMode, keywordCase, formattingDialect, props.modifyNotebookScripts, scriptData]);
    const handleDelete = React.useCallback(() => {
        props.modifyNotebookScripts({ type: DELETE_SCRIPT, value: scriptFileName });
        props.hideDetails();
    }, [props.modifyNotebookScripts, props.hideDetails, scriptFileName]);

    // A staged rewrite is shown as an in-place diff on the editable editor here (the diff
    // decorations + ⏎/⎋ keymap come from the editor's DashQL extensions). Surface visible controls
    // too, mirroring the feed's status bar. Both drive the editor-effect accept/reject path, which
    // round-trips through UPDATE_FROM_PROCESSOR to clear the pending diff.
    const hasPendingDiff = scriptData?.pendingDiff != null;
    const handleAcceptDiff = React.useCallback(() => {
        if (editorView != null) {
            acceptPendingDiff(editorView);
        } else if (scriptData != null) {
            props.modifyNotebookScripts({ type: ACCEPT_PENDING_DIFF, value: scriptData.scriptKey });
        }
    }, [editorView, props.modifyNotebookScripts, scriptData]);
    const handleRejectDiff = React.useCallback(() => {
        if (editorView != null) {
            rejectPendingDiff(editorView);
        } else if (scriptData != null) {
            props.modifyNotebookScripts({ type: REJECT_PENDING_DIFF, value: scriptData.scriptKey });
        }
    }, [editorView, props.modifyNotebookScripts, scriptData]);
    const navigateToScript = React.useCallback((scriptKey: number) => {
        if (props.navigateToScript) {
            props.navigateToScript(scriptKey);
            return;
        }
        const target = props.notebookScripts.scripts[scriptKey];
        if (!target?.fileName) return;
        props.modifyNotebookScripts({
            type: SELECT_SCRIPT,
            value: target.fileName,
        });
    }, [props.navigateToScript, props.notebookScripts.scripts, props.modifyNotebookScripts]);

    const activeQueryId = scriptData?.latestQueryId ?? null;
    const activeQueryState = dependencies.useQueryState(props.notebookScripts?.notebookId ?? null, activeQueryId);
    const autoCollapsedQueryIdRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        const queryId = activeQueryState?.queryId ?? activeQueryId;
        if (activeQueryState?.status === QueryExecutionStatus.SUCCEEDED
            && activeQueryState.resultTable === null) {
            if (autoCollapsedQueryIdRef.current === queryId) return;
            autoCollapsedQueryIdRef.current = queryId;
            setResultExpanded(false);
            return;
        }
        if (autoCollapsedQueryIdRef.current != null && autoCollapsedQueryIdRef.current !== queryId) {
            autoCollapsedQueryIdRef.current = null;
            setResultExpanded(true);
        }
    }, [activeQueryId, activeQueryState]);
    const handleToggleResultExpanded = React.useCallback(() => {
        setResultExpanded(expanded => !expanded);
    }, []);
    const cancelQuery = dependencies.useCancelQuery();

    // Refresh: drop the stale cache entry for this result, then re-execute — a plain cacheable run
    // then misses the cache and re-populates it. Surfaced on the Data/Chart tab headers when the
    // current result was served from cache.
    const executeQuery = dependencies.useQueryExecutor();
    const storageReader = dependencies.useStorageReader();
    const handleExecute = React.useCallback(() => {
        if (props.connection?.connectionHealth !== ConnectionHealth.ONLINE) {
            connectionAttention?.request(props.notebookScripts.notebookId);
            return;
        }
        if (scriptData == null || notebookExecution.busy) return;
        dependencies.runNotebookScript(props.connection.databaseId, props.notebookScripts, scriptData, executeQuery, props.modifyNotebookScripts, logger);
    }, [props.connection, props.notebookScripts, props.modifyNotebookScripts, scriptData, executeQuery, logger, notebookExecution.busy, connectionAttention]);
    const handleRerun = React.useCallback(async (cacheKey: string | null) => {
        if (scriptData == null || props.connection?.connectionHealth !== ConnectionHealth.ONLINE || notebookExecution.busy) {
            return;
        }
        // Best-effort delete of the stale cache entry first; the re-execution then misses and
        // re-populates the cache (the executor's write path overwrites it either way).
        if (cacheKey != null) {
            await storageReader.backend.deleteQueryResultCache(props.notebookScripts.notebookId, cacheKey).catch(() => { });
        }
        if (props.connection != null) {
            dependencies.runNotebookScript(props.connection.databaseId, props.notebookScripts, scriptData, executeQuery, props.modifyNotebookScripts, logger);
        }
    }, [props.connection, props.notebookScripts, props.modifyNotebookScripts, scriptData, executeQuery, storageReader, logger, notebookExecution.busy]);

    const visualizeQuery = scriptData?.annotations.visualizeQuery ?? null;

    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                // Execute the pinned Details script directly rather than letting the global command
                // resolve the hidden feed's mutable selection.
                key: 'e',
                ctrlKey: true,
                capture: true,
                callback: (event) => {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    handleExecute();
                },
            },
            {
                key: 'Escape',
                ctrlKey: false,
                callback: (event) => {
                    if (isEditingName) {
                        cancelNameEdit();
                        event.stopImmediatePropagation();
                        return;
                    }
                    if (editorView) {
                        const processor = editorView.state.field(DashQLProcessorPlugin, false);
                        if (processor?.scriptCompletion?.status === DashQLCompletionStatus.AVAILABLE) {
                            editorView.dispatch({ effects: DashQLCompletionAbortEffect.of(null) });
                            event.stopImmediatePropagation();
                            return;
                        }
                    }
                    props.hideDetails();
                    event.stopImmediatePropagation();
                },
            },
        ],
        [props.hideDetails, isEditingName, cancelNameEdit, editorView, handleExecute],
    );
    dependencies.useKeyEvents(keyHandlers);

    React.useEffect(() => {
        if (editorView == null || (props.initialTab != null && props.initialTab !== ScriptDetailsTab.Editor)) {
            return;
        }
        const handle = requestAnimationFrame(() => {
            editorView.focus();
        });
        return () => cancelAnimationFrame(handle);
    }, [editorView, props.initialTab]);


    if (notebookEntry == null || scriptData == null) {
        return <div className={styles.entry_body_container} />;
    }

    const ScreenNormalIcon: Icon = SymbolIcon('screen_normal_16');
    const tableDebugMode = config?.settings?.tableDebugMode ?? false;
    const scriptDebugMode = config?.settings?.scriptDebugMode ?? false;
    return (
        <div className={styles.entry_body_container}>
            <div
                key={notebookEntry?.scriptId}
                className={styles.entry_single}
            >
                <dependencies.VerticalSplit
                    className={styles.entry_split}
                    defaultRatio={0.4}
                    minFirstSize={160}
                    minSecondSize={120}
                    secondCollapsed={!resultExpanded}
                    collapsedSecondSize={40}
                    separatorLabel="Resize script editor and result"
                    first={(
                        <dependencies.ScriptDetailsEditorPane
                            notebookId={props.notebookScripts.notebookId}
                            scriptData={scriptData}
                            scriptDisplay={scriptDisplay}
                            scriptDebugMode={scriptDebugMode}
                            executeDisabled={notebookExecution.busy || props.connection?.connectionHealth !== ConnectionHealth.ONLINE}
                            connectionBlocked={props.connection?.connectionHealth !== ConnectionHealth.ONLINE}
                            isEditingName={isEditingName}
                            draftFileName={draftFileName}
                            editInputRef={editInputRef}
                            isFormattable={isFormattable}
                            connectorType={props.notebookScripts.connectorInfo?.connectorType}
                            hasPendingDiff={hasPendingDiff}
                            PencilIcon={PencilIcon}
                            CheckIcon={CheckIcon}
                            CancelIcon={FormatXIcon}
                            CollapseIcon={ScreenNormalIcon}
                            formatMenu={(
                                <ScriptActionMenu
                                    scriptName={scriptDisplay}
                                    formatDisabled={!isFormattable || hasPendingDiff || editorView == null}
                                    onFormat={handleFormat}
                                    onDelete={handleDelete}
                                />
                            )}
                            onExecute={handleExecute}
                            onHide={props.hideDetails}
                            onStartEditingName={startEditingName}
                            onDraftFileNameChange={setDraftFileName}
                            onSaveName={saveNameEdit}
                            onCancelName={cancelNameEdit}
                            onEditorView={setEditorView}
                            onNavigateToScript={navigateToScript}
                            onAcceptDiff={handleAcceptDiff}
                            onRejectDiff={handleRejectDiff}
                        />
                    )}
                    second={(
                        <dependencies.ScriptDetailsOutputPane
                            query={activeQueryState}
                            visualizeQuery={visualizeQuery}
                            initialTab={props.initialTab}
                            tableDebugMode={tableDebugMode}
                            expanded={resultExpanded}
                            onToggleExpanded={handleToggleResultExpanded}
                            contentId={`script-result-${scriptData.scriptKey}`}
                            onCancelQuery={activeQueryId != null
                                ? () => notebookExecution.busy ? notebookExecution.stop() : props.connection && cancelQuery(props.connection.databaseId, activeQueryId)
                                : undefined}
                            statusActions={(
                                <>
                                    <QueryResultCacheLabel query={activeQueryState} />
                                    <QueryResultRerunButton query={activeQueryState} onRerun={props.connection?.connectionHealth === ConnectionHealth.ONLINE && !notebookExecution.busy ? handleRerun : undefined} />
                                </>
                            )}
                        />
                    )}
                />
            </div>
        </div>
    );
};
