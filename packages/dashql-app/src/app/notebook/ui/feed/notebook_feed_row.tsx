import * as React from 'react';
import * as styles from './notebook_feed.module.css';
import * as dashql from '@ankoh/dashql-core';
import { useNotebookExecution } from '../../scripts/notebook_execution_provider.js';

import type { EditorView } from '@codemirror/view';
import type { Icon } from '../../../../ui/foundations/symbol_icon.js';
import { PaperAirplaneIcon, PlusIcon, SquareFillIcon } from '../../../../ui/foundations/symbol_icon.js';
import type { RowComponentProps } from 'react-window';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { ButtonGroup } from '../../../../ui/foundations/button_group.js';
import { IndicatorStatus } from '../../../../ui/foundations/status_indicator.js';
import { SymbolIcon } from '../../../../ui/foundations/symbol_icon.js';
import { ConnectionHealth, type AttachedDatabaseState } from '../../connections/attached_database_state.js';
import { ExecuteConnectionGuard } from '../notebook_connection_attention.js';
import type { ConnectorType } from '../../connections/connector_info.js';
import { QueryExecutionStatus, queryIsDone } from '../../connections/query_execution_state.js';
import { computeQueryCacheKeyForConnection, useCancelQuery, useQueryState } from '../../connections/query_executor.js';
import type { StorageReader } from '../../persistence/storage_provider.js';
import { compileNotebookQuery, getSelectedScriptRefs, type NotebookScripts, type ScriptData } from '../../scripts/notebook_scripts.js';
import { scriptDisplayName } from '../../scripts/script_types.js';
import { deriveEntryStatus, EntryStatusKind } from '../entry_status_model.js';
import { EntryStatusBar } from '../entry_status_bar.js';
import { CachedResultBean, QueryResultCacheLabel, QueryResultRerunButton } from '../query_result_cache_controls.js';
import { ScriptDiagnosticsButton } from '../script_diagnostics.js';
import { ScriptName } from '../script_name.js';
import { ScriptEditor } from '../script_editor.js';
import { ScriptStatisticsBar } from '../script_statistics_bar.js';
import { formatScriptEditor, formattingDialectForConnector, isScriptFormattable } from '../script_format.js';
import { FeedEntryFooter } from './feed_entry_footer.js';
import { ScriptActionMenu } from '../script_action_menu.js';

const DragHandleIcon: Icon = SymbolIcon('drag_handle_16');

export interface ScriptCardProps {
    notebookId: string;
    /// The connection fields of the card.
    /// The connection state itself changes with every query event of the notebook.
    databaseId: string | null;
    connectionHealth: ConnectionHealth | null;
    connectionDetails: AttachedDatabaseState['details'] | null;
    connectorType: ConnectorType;
    storageReader: StorageReader;
    isFocused: boolean;
    scriptData: ScriptData | undefined;
    scriptFileName: string;
    scriptDebugMode: boolean;
    formattingDebugMode: boolean;
    keywordCase: dashql.buffers.formatting.KeywordCase;
    canExecute: boolean;
    canDelete: boolean;
    active: boolean;
    canMoveUp: boolean;
    canMoveDown: boolean;
    onFocus: (fileName: string) => void;
    onDelete: (fileName: string) => void;
    onRename: (oldFileName: string, newFileName: string) => void;
    onMoveUp: (fileName: string) => void;
    onMoveDown: (fileName: string) => void;
    onExecute: (fileName: string) => void;
    onShowStatus: (fileName: string) => void;
    onShowTable: (fileName: string) => void;
    onShowVisualization: (fileName: string) => void;
    onShowDetails: (fileName: string) => void;
    onRerun: (fileName: string, cacheKey: string | null) => void;
    onFormat: (scriptKey: number, text: string) => void;
    onAcceptDiff: (scriptKey: number) => void;
    onRejectDiff: (scriptKey: number) => void;
    resultExpanded: boolean;
    onToggleResultExpanded: (scriptKey: number) => void;
    onAutoCollapseResult: (scriptKey: number, queryId: number) => void;
    onResetAutoCollapsedResult: (scriptKey: number, queryId: number | null) => void;
    onEditorView: (scriptKey: number, view: EditorView) => void;
    dependencies?: ScriptCardDependencies;
}

export interface ScriptCardDependencies {
    useQueryState: typeof useQueryState;
    useCancelQuery: typeof useCancelQuery;
    computeQueryCacheKeyForConnection: typeof computeQueryCacheKeyForConnection;
    ScriptEditor: typeof ScriptEditor;
    ScriptDiagnosticsButton: typeof ScriptDiagnosticsButton;
    ScriptStatisticsBar: typeof ScriptStatisticsBar;
    formatScriptEditor: typeof formatScriptEditor;
    isScriptFormattable: typeof isScriptFormattable;
    CachedResultBean: typeof CachedResultBean;
    QueryResultCacheLabel: typeof QueryResultCacheLabel;
    QueryResultRerunButton: typeof QueryResultRerunButton;
    EntryStatusBar: typeof EntryStatusBar;
    FeedEntryFooter: typeof FeedEntryFooter;
}

const DEFAULT_SCRIPT_CARD_DEPENDENCIES: ScriptCardDependencies = {
    useQueryState,
    useCancelQuery,
    computeQueryCacheKeyForConnection,
    ScriptEditor,
    ScriptDiagnosticsButton,
    ScriptStatisticsBar,
    formatScriptEditor,
    isScriptFormattable,
    CachedResultBean,
    QueryResultCacheLabel,
    QueryResultRerunButton,
    EntryStatusBar,
    FeedEntryFooter,
};

// Memoized since every row of the feed re-renders whenever any script changes
export const ScriptCard: React.FC<ScriptCardProps> = React.memo((props: ScriptCardProps) => {
    const notebookExecution = useNotebookExecution(props.notebookId);
    const dependencies = props.dependencies ?? DEFAULT_SCRIPT_CARD_DEPENDENCIES;
    const MoveUpIcon: Icon = SymbolIcon('chevron_up_16');
    const MoveDownIcon: Icon = SymbolIcon('chevron_down_16');
    const PencilIcon: Icon = SymbolIcon('pencil_16');
    const CheckIcon: Icon = SymbolIcon('check_16');
    const CrossIcon: Icon = SymbolIcon('x_16');
    const ExpandIcon: Icon = SymbolIcon('screen_full_16');

    const queryState = dependencies.useQueryState(props.notebookId, props.scriptData?.latestQueryId ?? null);
    const cancelQuery = dependencies.useCancelQuery();
    const queryActive = queryState != null && !queryIsDone(queryState.status);

    // A staged rewrite waiting to be accepted/rejected. The editable editor renders the
    // in-place diff and these actions provide the same explicit accept/reject alternatives.
    const hasPendingDiff = props.scriptData?.pendingDiff != null;

    // Is the script cached?
    // Compiling the query is a full pass over the script, only re-check when the text, the catalog,
    // the queries or their cache entries changed (and not on every cursor move).
    const [isCached, setIsCached] = React.useState<boolean | null>(null);
    React.useEffect(() => {
        const cancel = new AbortController();
        const wasCached = isCached;
        const connectionDetails = props.connectionDetails;
        const run = async () => {
            // Not script data? Clear cache indicator.
            if (props.scriptData == null || !connectionDetails) {
                if ((wasCached == null || wasCached) && !cancel.signal.aborted) {
                    setIsCached(null);
                }
                return;
            }
            // Outdated analysis? Keep the last known indicator until the script is re-analyzed.
            // Every keystroke outdates all scripts of the notebook, clearing it would make it flicker.
            if (props.scriptData.analysisOutdated) {
                return;
            }
            try {
                // Compile the query
                const compiled = compileNotebookQuery(props.scriptData, props.connectorType);
                if (!compiled.cacheable) {
                    setIsCached(false);
                    return;
                }
                // Compute the query cache key
                const cacheKey = await dependencies.computeQueryCacheKeyForConnection(connectionDetails, compiled.cacheSignature);
                // Cache key is null, then clear the cache if required
                if (cacheKey == null) {
                    if ((wasCached == null || wasCached) && !cancel.signal.aborted) {
                        setIsCached(false);
                    }
                    return;
                }
                // Check with storage if the query is cached
                const isCached = await props.storageReader.backend.hasCachedQueryResult(props.notebookId, cacheKey);
                if (!cancel.signal.aborted) {
                    setIsCached(isCached);
                }
            } catch { }
        };
        run();
        return () => cancel.abort();
    }, [
        props.scriptData?.scriptSession,
        props.scriptData?.analysisOutdated,
        props.scriptData?.editorUpdate?.textVersion,
        props.scriptData?.editorUpdate?.catalogRevision,
        props.scriptData?.latestQueryId,
        props.scriptData?.latestResultQueryId,
        queryState?.cacheKey,
        queryState?.cacheDeleted,
        props.connectionDetails,
        props.notebookId,
    ]);

    // The result header persists for active and terminal execution states. It can collapse the
    // result body without affecting its cancel, cache, and rerun actions.
    const entryStatus = deriveEntryStatus(queryState);
    const scriptKey = props.scriptData?.scriptKey ?? null;
    React.useEffect(() => {
        if (scriptKey == null) return;
        if (queryState?.status !== QueryExecutionStatus.SUCCEEDED || queryState.resultTable !== null) {
            props.onResetAutoCollapsedResult(scriptKey, queryState?.queryId ?? props.scriptData?.latestQueryId ?? null);
            return;
        }
        props.onAutoCollapseResult(scriptKey, queryState.queryId);
    }, [props.onAutoCollapseResult, props.onResetAutoCollapsedResult, props.scriptData?.latestQueryId, queryState, scriptKey]);
    const cancelEntryOperation = React.useCallback(() => {
        if (entryStatus?.kind === EntryStatusKind.Query && props.scriptData?.latestQueryId != null) {
            if (notebookExecution.busy) notebookExecution.stop();
            else if (props.databaseId != null) cancelQuery(props.databaseId, props.scriptData.latestQueryId);
        }
    }, [cancelQuery, entryStatus?.kind, props.databaseId, props.scriptData?.latestQueryId, notebookExecution.busy, notebookExecution.stop]);

    const acceptDiff = React.useCallback(() => {
        if (scriptKey != null) props.onAcceptDiff(scriptKey);
    }, [scriptKey, props.onAcceptDiff]);
    const rejectDiff = React.useCallback(() => {
        if (scriptKey != null) props.onRejectDiff(scriptKey);
    }, [scriptKey, props.onRejectDiff]);

    const [isEditing, setIsEditing] = React.useState(false);
    const [editorView, setEditorView] = React.useState<EditorView | null>(null);
    const formattingDialect = formattingDialectForConnector(props.connectorType);
    // Formattability only depends on the text, cursor moves bump the state revision but not the text version
    const isFormattable = React.useMemo(
        () => dependencies.isScriptFormattable(props.scriptData ?? null, formattingDialect),
        [props.scriptData?.scriptSession, props.scriptData?.editorUpdate?.textVersion, formattingDialect],
    );
    const handleEditorView = React.useCallback((view: EditorView) => {
        setEditorView(view);
        if (props.scriptData != null) props.onEditorView(props.scriptData.scriptKey, view);
    }, [props.onEditorView, props.scriptData?.scriptKey]);
    const handleFormat = React.useCallback((mode: dashql.buffers.formatting.FormattingMode) => {
        dependencies.formatScriptEditor(
            editorView,
            props.scriptData ?? null,
            mode,
            (text) => {
                if (props.scriptData != null) props.onFormat(props.scriptData.scriptKey, text);
            },
            props.formattingDebugMode,
            props.keywordCase,
            formattingDialect,
        );
    }, [editorView, props.formattingDebugMode, props.keywordCase, formattingDialect, props.onFormat, props.scriptData]);

    // The label and the rename input show the clean display name (no ordering prefix, no ".sql");
    // the raw scriptFileName remains the identity passed to handlers and to RENAME_SCRIPT.
    const displayName = scriptDisplayName(props.scriptFileName);
    const [draftFileName, setDraftFileName] = React.useState(displayName);
    const editInputRef = React.useRef<HTMLInputElement>(null);

    const startEditing = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setDraftFileName(displayName);
        setIsEditing(true);
    }, [displayName]);

    const saveEdit = React.useCallback(() => {
        const trimmed = draftFileName.trim();
        if (trimmed && trimmed !== displayName) {
            props.onRename(props.scriptFileName, trimmed);
        }
        setIsEditing(false);
    }, [draftFileName, displayName, props.scriptFileName, props.onRename]);

    const cancelEdit = React.useCallback(() => {
        setIsEditing(false);
    }, []);

    React.useEffect(() => {
        if (isEditing && editInputRef.current) {
            editInputRef.current.focus();
            editInputRef.current.select();
        }
    }, [isEditing]);

    const showStatus = React.useCallback(() => props.onShowStatus(props.scriptFileName), [props.onShowStatus, props.scriptFileName]);
    const showTable = React.useCallback(() => props.onShowTable(props.scriptFileName), [props.onShowTable, props.scriptFileName]);
    const showVisualization = React.useCallback(() => props.onShowVisualization(props.scriptFileName), [props.onShowVisualization, props.scriptFileName]);

    const resultContentId = props.scriptData != null ? `feed-result-${props.scriptData.scriptKey}` : undefined;
    const hasFooterContent = entryStatus.kind !== EntryStatusKind.Idle;
    return (
        <article
            className={styles.feed_entry_pair}
            data-electron-drag-region="false"
            onPointerEnter={() => props.onFocus(props.scriptFileName)}
            aria-label={`${displayName} script cell`}
        >
            <div className={styles.feed_entry_cell} data-result-card={hasFooterContent ? '' : undefined}>
                <div className={styles.feed_entry_action_bar}>
                    <ExecuteConnectionGuard notebookId={props.notebookId} blocked={!queryActive && props.connectionHealth !== ConnectionHealth.ONLINE}>
                    <IconButton
                        className={props.isFocused ? undefined : styles.feed_entry_execute_unfocused}
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label={queryActive ? `Stop ${displayName} query` : `Execute ${displayName} query`}
                        aria-current={props.isFocused ? 'true' : undefined}
                        disabled={!queryActive && (!props.canExecute || notebookExecution.busy || props.connectionHealth !== ConnectionHealth.ONLINE)}
                        onClick={() => {
                            if (queryActive && props.scriptData?.latestQueryId != null) {
                                if (notebookExecution.busy) notebookExecution.stop();
                                else if (props.databaseId != null) cancelQuery(props.databaseId, props.scriptData.latestQueryId);
                            } else {
                                props.onExecute(props.scriptFileName);
                            }
                        }}
                    >
                        {queryActive ? <SquareFillIcon size={14} /> : <PaperAirplaneIcon size={16} />}
                    </IconButton>
                    </ExecuteConnectionGuard>
                    <div className={styles.feed_entry_file_name}>
                        <ScriptName
                            file={displayName}
                            onFileClick={startEditing}
                            editing={isEditing ? {
                                value: draftFileName,
                                onChange: setDraftFileName,
                                onCommit: saveEdit,
                                onCancel: cancelEdit,
                                inputRef: editInputRef,
                            } : undefined}
                            fileNameTrailing={
                                <span className={styles.feed_entry_actions}>
                                    <PencilIcon size={12} />
                                </span>
                            }
                        />
                    </div>
                    {props.scriptDebugMode && props.scriptData != null && (
                        <div className={styles.feed_entry_stats_bar}>
                            <dependencies.ScriptStatisticsBar stats={props.scriptData.statistics} />
                        </div>
                    )}
                    {props.scriptData != null && (
                        <dependencies.ScriptDiagnosticsButton
                            scriptData={props.scriptData}
                            isFormattable={isFormattable}
                            connectorType={props.connectorType}
                        />
                    )}
                    <ScriptActionMenu
                        scriptName={displayName}
                        formatDisabled={!isFormattable || hasPendingDiff || editorView == null}
                        deleteDisabled={!props.canDelete}
                        onFormat={handleFormat}
                        onDelete={() => props.onDelete(props.scriptFileName)}
                    />
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        onClick={(event) => { event.stopPropagation(); props.onMoveUp(props.scriptFileName); }}
                        aria-label="Move script up"
                        disabled={!props.canMoveUp}
                    >
                        <MoveUpIcon size={16} />
                    </IconButton>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        onClick={(event) => { event.stopPropagation(); props.onMoveDown(props.scriptFileName); }}
                        aria-label="Move script down"
                        disabled={!props.canMoveDown}
                    >
                        <MoveDownIcon size={16} />
                    </IconButton>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        onClick={() => props.onShowDetails(props.scriptFileName)}
                        aria-label={`Expand ${displayName} script details`}
                    >
                        <ExpandIcon size={16} />
                    </IconButton>
                </div>
                <div className={styles.feed_body}>
                    <div className={styles.feed_editor_container}>
                        {props.scriptData == null || !props.active ? null : (
                            <dependencies.ScriptEditor
                                notebookId={props.notebookId}
                                scriptKey={props.scriptData.scriptKey}
                                className={styles.feed_script_editor}
                                autoHeight
                                onFocus={() => props.onFocus(props.scriptFileName)}
                                setView={handleEditorView}
                            />
                        )}
                        {hasPendingDiff && (
                            <div className={styles.feed_body_overlays}>
                                <div data-diff-actions>
                                    <ButtonGroup>
                                        <IconButton
                                            variant={ButtonVariant.Default}
                                            size={ButtonSize.Small}
                                            onClick={acceptDiff}
                                            aria-label="Accept rewrite"
                                        >
                                            <CheckIcon size={14} />
                                        </IconButton>
                                        <IconButton
                                            variant={ButtonVariant.Default}
                                            size={ButtonSize.Small}
                                            onClick={rejectDiff}
                                            aria-label="Reject rewrite"
                                        >
                                            <CrossIcon size={14} />
                                        </IconButton>
                                    </ButtonGroup>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                {hasFooterContent && (
                    <div className={styles.feed_entry_footer}>
                        <dependencies.EntryStatusBar
                            status={entryStatus}
                            onToggleExpanded={() => {
                                if (scriptKey != null) props.onToggleResultExpanded(scriptKey);
                            }}
                            expanded={props.resultExpanded}
                            controls={resultContentId}
                            onCancel={entryStatus.indicator === IndicatorStatus.Running ? cancelEntryOperation : undefined}
                            cancelLabel="Cancel query"
                            compact
                            actions={
                                <>
                                    {isCached && <dependencies.CachedResultBean />}
                                    <dependencies.QueryResultCacheLabel query={queryState} />
                                    <dependencies.QueryResultRerunButton
                                        query={queryState}
                                        onRerun={props.connectionHealth === ConnectionHealth.ONLINE && !notebookExecution.busy
                                            ? (cacheKey) => props.onRerun(props.scriptFileName, cacheKey) : undefined}
                                    />
                                </>
                            }
                        />
                        {queryState != null ? (
                            <div id={resultContentId} hidden={!props.resultExpanded}>
                                <dependencies.FeedEntryFooter
                                    notebookId={props.notebookId}
                                    queryState={queryState}
                                    visualizeQuery={props.scriptData?.annotations.visualizeQuery ?? null}
                                    onShowStatus={showStatus}
                                    onShowTable={showTable}
                                    onShowVisualization={showVisualization}
                                />
                            </div>
                        ) : null}
                    </div>
                )}
            </div>
        </article>
    );
});

export interface ScriptFeedRowProps {
    notebookId: string;
    databaseId: string | null;
    connectionHealth: ConnectionHealth | null;
    connectionDetails: AttachedDatabaseState['details'] | null;
    connectorType: ConnectorType;
    storageReader: StorageReader;
    entries: ReturnType<typeof getSelectedScriptRefs>;
    scripts: NotebookScripts['scripts'];
    scriptDebugMode: boolean;
    formattingDebugMode: boolean;
    keywordCase: dashql.buffers.formatting.KeywordCase;
    focusedFileName: string;
    canDelete: boolean;
    active: boolean;
    onFocus: (fileName: string) => void;
    onDelete: (fileName: string) => void;
    onRename: (oldFileName: string, newFileName: string) => void;
    onMoveUp: (fileName: string) => void;
    onMoveDown: (fileName: string) => void;
    onExecute: (fileName: string) => void;
    onShowStatus: (fileName: string) => void;
    onShowTable: (fileName: string) => void;
    onShowVisualization: (fileName: string) => void;
    onShowDetails: (fileName: string) => void;
    onRerun: (fileName: string, cacheKey: string | null) => void;
    onFormat: (scriptKey: number, text: string) => void;
    onAcceptDiff: (scriptKey: number) => void;
    onRejectDiff: (scriptKey: number) => void;
    collapsedResults: ReadonlyMap<number, number | null>;
    onToggleResultExpanded: (scriptKey: number) => void;
    onAutoCollapseResult: (scriptKey: number, queryId: number) => void;
    onResetAutoCollapsedResult: (scriptKey: number, queryId: number | null) => void;
    topPadding: number;
    onCreate: (index: number) => void;
    onEditorView: (scriptKey: number, view: EditorView) => void;
    onRowHeightChange: (index: number, height: number) => void;
    dependencies?: ScriptFeedRowDependencies;
}

export interface ScriptFeedRowDependencies {
    useSortable: typeof useSortable;
    translateTransform: typeof CSS.Translate.toString;
    scriptCard: ScriptCardDependencies;
}

const DEFAULT_SCRIPT_FEED_ROW_DEPENDENCIES: ScriptFeedRowDependencies = {
    useSortable,
    translateTransform: CSS.Translate.toString,
    scriptCard: DEFAULT_SCRIPT_CARD_DEPENDENCIES,
};

export function ScriptFeedRow(props: RowComponentProps<ScriptFeedRowProps>) {
    const dependencies = props.dependencies ?? DEFAULT_SCRIPT_FEED_ROW_DEPENDENCIES;
    const isSeparator = props.index % 2 === 0;
    const entryIndex = Math.floor(props.index / 2);
    const entry = !isSeparator ? props.entries[entryIndex] : undefined;
    const scriptData = entry != null ? props.scripts[entry.scriptId] : undefined;
    const scriptFileName = entry?.fileName ?? '01-script.sql';

    // Entries are in feed order, so the index drives the movement buttons
    const canMoveUp = !isSeparator && entryIndex > 0;
    const canMoveDown = !isSeparator && entryIndex < props.entries.length - 1;
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = dependencies.useSortable({
        id: entry?.scriptId ?? `separator-${entryIndex}`,
        disabled: { draggable: isSeparator, droppable: isSeparator },
        // The optimistic order is already the final dropped layout. Suppress dnd-kit's derived
        // post-drop FLIP transform, which otherwise briefly animates the card back toward its old row.
        animateLayoutChanges: () => false,
    });
    const rowRef = React.useRef<HTMLDivElement | null>(null);
    const setRowRef = React.useCallback((node: HTMLDivElement | null) => {
        rowRef.current = node;
        setNodeRef(node);
    }, [setNodeRef]);
    React.useLayoutEffect(() => {
        if (isSeparator) return;
        const row = rowRef.current;
        if (row == null) return;
        const syncHeight = () => {
            const height = Math.ceil(row.getBoundingClientRect().height);
            if (height > 0) props.onRowHeightChange(props.index, height);
        };
        syncHeight();
        const observer = new ResizeObserver(syncHeight);
        observer.observe(row);
        return () => observer.disconnect();
    }, [isSeparator, props.index, props.onRowHeightChange]);

    if (isSeparator) {
        return (
            <button
                type="button"
                className={styles.feed_cell_separator}
                aria-label={`Add script at position ${entryIndex + 1}`}
                onClick={() => props.onCreate(entryIndex)}
                style={{
                    ...props.style,
                    paddingTop: props.index === 0 ? props.topPadding : undefined,
                }}
            >
                <span className={styles.feed_cell_separator_line} aria-hidden="true" />
                <span className={styles.feed_cell_add} aria-hidden="true">
                    <PlusIcon size={16} />
                </span>
            </button>
        );
    }

    return (
        <div
            style={props.style}
        >
            <div
                ref={setRowRef}
                className={styles.feed_list_item}
                style={{
                    // dnd-kit may scale the active item toward a differently sized target row.
                    // Feed cards have variable heights, so scaling visibly squashes or stretches them.
                    transform: dependencies.translateTransform(transform),
                    transition,
                    zIndex: isDragging ? 1 : undefined,
                }}
            >
                <button
                    type="button"
                    className={styles.feed_entry_drag_handle}
                    aria-label={`Drag ${scriptDisplayName(scriptFileName)} script to reorder`}
                    {...attributes}
                    {...listeners}
                >
                    <DragHandleIcon size={16} />
                </button>
                <ScriptCard
                    key={entry?.scriptId}
                    notebookId={props.notebookId}
                    databaseId={props.databaseId}
                    connectionHealth={props.connectionHealth}
                    connectionDetails={props.connectionDetails}
                    connectorType={props.connectorType}
                    storageReader={props.storageReader}
                    isFocused={scriptFileName === props.focusedFileName}
                    scriptData={scriptData}
                    scriptFileName={scriptFileName}
                    scriptDebugMode={props.scriptDebugMode}
                    formattingDebugMode={props.formattingDebugMode}
                    keywordCase={props.keywordCase}
                    canExecute={scriptData != null && props.connectionHealth === ConnectionHealth.ONLINE}
                    canDelete={props.canDelete}
                    active={props.active}
                    canMoveUp={canMoveUp}
                    canMoveDown={canMoveDown}
                    onFocus={props.onFocus}
                    onDelete={props.onDelete}
                    onRename={props.onRename}
                    onMoveUp={props.onMoveUp}
                    onMoveDown={props.onMoveDown}
                    onExecute={props.onExecute}
                    onShowStatus={props.onShowStatus}
                    onShowTable={props.onShowTable}
                    onShowVisualization={props.onShowVisualization}
                    onShowDetails={props.onShowDetails}
                    onRerun={props.onRerun}
                    onFormat={props.onFormat}
                    onAcceptDiff={props.onAcceptDiff}
                    onRejectDiff={props.onRejectDiff}
                    resultExpanded={scriptData == null || !props.collapsedResults.has(scriptData.scriptKey)}
                    onToggleResultExpanded={props.onToggleResultExpanded}
                    onAutoCollapseResult={props.onAutoCollapseResult}
                    onResetAutoCollapsedResult={props.onResetAutoCollapsedResult}
                    onEditorView={props.onEditorView}
                    dependencies={dependencies.scriptCard}
                />
            </div>
        </div>
    );
}
