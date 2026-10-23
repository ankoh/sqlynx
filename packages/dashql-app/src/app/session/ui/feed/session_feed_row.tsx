import * as React from 'react';
import * as styles from './session_feed.module.css';
import * as dashql from '@ankoh/dashql-core';
import { useSessionExecution } from '../../scripts/session_execution_provider.js';

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
import { ConnectionHealth, type ConnectionState } from '../../../connections/connection_state.js';
import { ExecuteConnectionGuard } from '../session_connection_attention.js';
import { ConnectorType } from '../../../connections/connector_info.js';
import { QueryExecutionStatus, queryIsDone } from '../../../../query/query_execution_state.js';
import { computeQueryCacheKeyForConnection, useCancelQuery, useQueryState } from '../../../connections/query_executor.js';
import type { StorageReader } from '../../../storage/storage_provider.js';
import { getScriptRefs, type SessionScripts, type ScriptData } from '../../scripts/session_scripts.js';
import { compileSessionQuery } from '../../scripts/script_compilation.js';
import { scriptDisplayName } from '../../scripts/script_types.js';
import { deriveEntryStatus, EntryStatusKind } from '../entry_status_model.js';
import { EntryStatusBar } from '../entry_status_bar.js';
import { CachedResultBean, QueryResultCacheLabel, QueryResultRerunButton } from '../query_result_cache_controls.js';
import { ScriptDiagnosticsButton } from '../script_diagnostics.js';
import { ScriptEditor } from '../script_editor.js';
import { ScriptStatisticsBar } from '../script_statistics_bar.js';
import { formatScriptEditor, formattingDialectForConnector, isScriptFormattable } from '../script_format.js';
import { FeedEntryFooter } from './feed_entry_footer.js';
import { GenerationError, GenerationStopButton, isGenerating, useGenerationPlaceholder } from '../../ai/ui/script_generation.js';
import type { ScriptGeneration } from '../../ai/use_sql_generations.js';
import { ScriptActionMenu, type ScriptStorage } from '../script_action_menu.js';
import { displayPath } from '../../../storage/session_locator.js';
import { STORAGE_SCRIPTS_FOLDER } from '../../../storage/storage_backend.js';
import { ScriptConnectionPicker, type ScriptConnectionView } from '../script_connection_picker.js';

const DragHandleIcon: Icon = SymbolIcon('drag_handle_16');

export interface ScriptCardProps {
    sessionId: string;
    /// The connection fields of the card, the connection the script runs on.
    /// The connection state itself changes with every query event of the session.
    connectionId: string | null;
    connectionHealth: ConnectionHealth | null;
    connectionDetails: ConnectionState['details'] | null;
    connectorType: ConnectorType;
    /// The connection the script runs on, null while it is not registered
    connection: ScriptConnectionView | null;
    /// Whether the session caches query results.
    cacheQueryResults: boolean;
    storageReader: StorageReader;
    isFocused: boolean;
    scriptData: ScriptData | undefined;
    scriptFileName: string;
    scriptDebugMode: boolean;
    formattingDebugMode: boolean;
    keywordCase: dashql.buffers.formatting.KeywordCase;
    canExecute: boolean;
    active: boolean;
    canMoveUp: boolean;
    canMoveDown: boolean;
    onFocus: (fileName: string) => void;
    onDelete: (fileName: string) => void;
    onRename: (oldFileName: string, newFileName: string) => void;
    /// Run the script on another connection
    onPickConnection: (fileName: string, connectionId: string) => void;
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
    /// The running or failed translation of the question of the script into SQL
    generation: ScriptGeneration | null;
    /// Stop the translation of the script
    onStopGeneration: (scriptKey: number) => void;
    /// Dismiss the error of a failed translation
    onDismissGeneration: (scriptKey: number) => void;
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
    const sessionExecution = useSessionExecution(props.sessionId);
    const dependencies = props.dependencies ?? DEFAULT_SCRIPT_CARD_DEPENDENCIES;
    const MoveUpIcon: Icon = SymbolIcon('chevron_up_16');
    const MoveDownIcon: Icon = SymbolIcon('chevron_down_16');
    const CheckIcon: Icon = SymbolIcon('check_16');
    const CrossIcon: Icon = SymbolIcon('x_16');
    const ExpandIcon: Icon = SymbolIcon('screen_full_16');
    const TrashIcon: Icon = SymbolIcon('trash_16');

    const queryState = dependencies.useQueryState(props.sessionId, props.scriptData?.latestQueryId ?? null);
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
            // Every keystroke outdates all scripts of the session, clearing it would make it flicker.
            if (props.scriptData.analysisOutdated) {
                return;
            }
            try {
                // Compile the query
                const compiled = compileSessionQuery(props.scriptData, props.connectorType);
                if (!props.cacheQueryResults || !compiled.cacheable) {
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
                const isCached = await props.storageReader.backend.hasCachedQueryResult(props.sessionId, cacheKey);
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
        props.cacheQueryResults,
        props.sessionId,
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
            if (sessionExecution.busy) sessionExecution.stop();
            else if (props.connectionId != null) cancelQuery(props.connectionId, props.scriptData.latestQueryId);
        }
    }, [cancelQuery, entryStatus?.kind, props.connectionId, props.scriptData?.latestQueryId, sessionExecution.busy, sessionExecution.stop]);

    const acceptDiff = React.useCallback(() => {
        if (scriptKey != null) props.onAcceptDiff(scriptKey);
    }, [scriptKey, props.onAcceptDiff]);
    const rejectDiff = React.useCallback(() => {
        if (scriptKey != null) props.onRejectDiff(scriptKey);
    }, [scriptKey, props.onRejectDiff]);

    const [editorView, setEditorView] = React.useState<EditorView | null>(null);
    // A question is being translated into the SQL of the script
    const generating = isGenerating(props.generation);
    useGenerationPlaceholder(editorView, generating);
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

    // Labels use the display name (the file name without ".sql"); the raw scriptFileName remains the
    // identity passed to handlers and to RENAME_SCRIPT.
    const displayName = scriptDisplayName(props.scriptFileName);
    const storage = React.useMemo<ScriptStorage>(() => ({
        fileName: props.scriptFileName,
        resolvePath: () => `${displayPath(props.sessionId, props.storageReader.getSessionLocation(props.sessionId))}/${STORAGE_SCRIPTS_FOLDER}/${props.scriptFileName}`,
        onRename: name => props.onRename(props.scriptFileName, name),
    }), [props.scriptFileName, props.sessionId, props.storageReader, props.onRename]);

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
                    {generating ? (
                        <GenerationStopButton scriptKey={scriptKey} displayName={displayName} onStop={props.onStopGeneration} />
                    ) : (
                    <ExecuteConnectionGuard sessionId={props.sessionId} blocked={!queryActive && props.connectionHealth !== ConnectionHealth.ONLINE}>
                    <IconButton
                        className={props.isFocused ? styles.feed_entry_execute_focused : styles.feed_entry_execute_unfocused}
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label={queryActive ? `Stop ${displayName} query` : `Execute ${displayName} query`}
                        aria-current={props.isFocused ? 'true' : undefined}
                        disabled={!queryActive && (!props.canExecute || sessionExecution.busy || props.connectionHealth !== ConnectionHealth.ONLINE)}
                        onClick={() => {
                            if (queryActive && props.scriptData?.latestQueryId != null) {
                                if (sessionExecution.busy) sessionExecution.stop();
                                else if (props.connectionId != null) cancelQuery(props.connectionId, props.scriptData.latestQueryId);
                            } else {
                                props.onExecute(props.scriptFileName);
                            }
                        }}
                    >
                        {queryActive ? <SquareFillIcon size={14} /> : <PaperAirplaneIcon size={16} />}
                    </IconButton>
                    </ExecuteConnectionGuard>
                    )}
                    <span className={styles.feed_entry_action_separator} aria-hidden="true" />
                    <div className={styles.feed_entry_file_name}>
                        <ScriptConnectionPicker
                            sessionId={props.sessionId}
                            scriptName={displayName}
                            connection={props.connection}
                            disabled={props.scriptData == null || queryActive || generating || sessionExecution.busy}
                            onPick={connectionId => props.onPickConnection(props.scriptFileName, connectionId)}
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
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        onClick={(event) => { event.stopPropagation(); props.onDelete(props.scriptFileName); }}
                        aria-label={`Delete ${displayName} script`}
                    >
                        <TrashIcon size={16} />
                    </IconButton>
                    <ScriptActionMenu
                        scriptName={displayName}
                        formatDisabled={!isFormattable || hasPendingDiff || editorView == null}
                        onFormat={handleFormat}
                        onDelete={() => props.onDelete(props.scriptFileName)}
                        storage={storage}
                    />
                    <span className={styles.feed_entry_action_separator} aria-hidden="true" />
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
                                sessionId={props.sessionId}
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
                    <GenerationError scriptKey={scriptKey} generation={props.generation} onDismiss={props.onDismissGeneration} />
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
                                        onRerun={props.connectionHealth === ConnectionHealth.ONLINE && !sessionExecution.busy
                                            ? (cacheKey) => props.onRerun(props.scriptFileName, cacheKey) : undefined}
                                    />
                                </>
                            }
                        />
                        {queryState != null ? (
                            <div id={resultContentId} hidden={!props.resultExpanded}>
                                <dependencies.FeedEntryFooter
                                    sessionId={props.sessionId}
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
    sessionId: string;
    /// The connections that the scripts run on
    connections: ReadonlyMap<string, ScriptConnectionView>;
    cacheQueryResults: boolean;
    storageReader: StorageReader;
    entries: ReturnType<typeof getScriptRefs>;
    scripts: SessionScripts['scripts'];
    scriptDebugMode: boolean;
    formattingDebugMode: boolean;
    keywordCase: dashql.buffers.formatting.KeywordCase;
    focusedFileName: string;
    active: boolean;
    onFocus: (fileName: string) => void;
    onDelete: (fileName: string) => void;
    onRename: (oldFileName: string, newFileName: string) => void;
    onPickConnection: (fileName: string, connectionId: string) => void;
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
    /// The running or failed translations of questions into SQL by script key
    generations: ReadonlyMap<number, ScriptGeneration>;
    onStopGeneration: (scriptKey: number) => void;
    onDismissGeneration: (scriptKey: number) => void;
    onToggleResultExpanded: (scriptKey: number) => void;
    onAutoCollapseResult: (scriptKey: number, queryId: number) => void;
    onResetAutoCollapsedResult: (scriptKey: number, queryId: number | null) => void;
    topPadding: number;
    /// The space below the last script that the docked composer floats over
    bottomPadding: number;
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
    const scriptFileName = entry?.fileName ?? 'script.sql';
    // Every script runs on its own connection
    const connection = scriptData != null ? props.connections.get(scriptData.connection.connectionId) ?? null : null;

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
                    paddingBottom: props.index === props.entries.length * 2 ? 8 + props.bottomPadding : undefined,
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
                    sessionId={props.sessionId}
                    connectionId={scriptData?.connection.connectionId ?? null}
                    connectionHealth={connection?.connectionHealth ?? null}
                    connectionDetails={connection?.details ?? null}
                    connectorType={scriptData?.connection.connectorInfo.connectorType ?? ConnectorType.HYPER}
                    connection={connection}
                    cacheQueryResults={props.cacheQueryResults}
                    storageReader={props.storageReader}
                    isFocused={scriptFileName === props.focusedFileName}
                    scriptData={scriptData}
                    scriptFileName={scriptFileName}
                    scriptDebugMode={props.scriptDebugMode}
                    formattingDebugMode={props.formattingDebugMode}
                    keywordCase={props.keywordCase}
                    canExecute={scriptData != null && connection?.connectionHealth === ConnectionHealth.ONLINE}
                    active={props.active}
                    canMoveUp={canMoveUp}
                    canMoveDown={canMoveDown}
                    onFocus={props.onFocus}
                    onDelete={props.onDelete}
                    onRename={props.onRename}
                    onPickConnection={props.onPickConnection}
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
                    generation={scriptData != null ? props.generations.get(scriptData.scriptKey) ?? null : null}
                    onStopGeneration={props.onStopGeneration}
                    onDismissGeneration={props.onDismissGeneration}
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
