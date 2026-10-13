import * as React from 'react';
import * as styles from './notebook_feed.module.css';

import type { EditorView } from '@codemirror/view';
import { useAppConfig } from '../../../config/app_config.js';

import { List } from 'react-window';
import {
    DndContext,
    DragEndEvent,
    KeyboardSensor,
    type Modifier,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';

import { ConnectionHealth, AttachedDatabaseState } from '../../connections/attached_database_state.js';
import { getSelectedScriptRef, getSelectedScriptRefs, getSortedScriptFileNames, NotebookScripts, SELECT_SCRIPT, CREATE_SCRIPT, DELETE_SCRIPT, RENAME_SCRIPT, REORDER_SCRIPTS, SET_SCRIPT_TEXT, ACCEPT_PENDING_DIFF, REJECT_PENDING_DIFF } from '../../scripts/notebook_scripts.js';
import { useQueryExecutor } from '../../connections/query_executor.js';
import { type ModifyNotebookScripts } from '../../scripts/notebook_scripts_registry.js';
import { type KeyEventHandler, useKeyEvents } from '../../../../utils/key_events.js';
import { TabKey as DetailsTabKey } from '../script_details.js';
import { runNotebookScript } from '../rerun_query.js';
import { useStorageReader } from '../../persistence/storage_provider.js';
import { VerticalScrollShadows } from '../../../../ui/foundations/vertical_scroll_shadows.js';
import { useLogger } from '../../../../platform/logger/logger_provider.js';
import { useNotebookFeedLayout } from './notebook_feed_layout.js';
import { ScriptFeedRow, type ScriptFeedRowProps } from './notebook_feed_row.js';
import { getKeywordCase } from '../script_format.js';
import { reorderFeedEntries } from './notebook_feed_drag.js';

export interface NotebookFeedProps {
    notebookScripts: NotebookScripts;
    modifyNotebookScripts: ModifyNotebookScripts;
    showDetails: (fileName?: string, initialTab?: DetailsTabKey) => void;
    conn: AttachedDatabaseState | null;
    /// Whether the feed is the visible, interactive layer. The feed stays mounted (just hidden) while
    /// the catalog/details overlay is open so it keeps its scroll position and measured row heights;
    /// while inactive its global key handlers must stand down so Escape/Enter belong to the overlay.
    active: boolean;
    scrollShadowContainer?: HTMLElement | null;
}

const OVERSCAN_ROW_COUNT = 16;
const FEED_TOP_PADDING = 16;
const COMPACT_FEED_TOP_PADDING = 8;
const FIRST_SEPARATOR_HEIGHT = 48;
const COMPACT_FIRST_SEPARATOR_HEIGHT = 40;
const FEED_ENTRY_CHROME_HEIGHT = 50;
const FEED_EDITOR_LINE_HEIGHT = 18;
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function estimateFeedEntryHeight(scriptText: string) {
    return FEED_ENTRY_CHROME_HEIGHT + Math.max(1, scriptText.split('\n').length) * FEED_EDITOR_LINE_HEIGHT;
}

function useCompactFeedLayout() {
    const [compact, setCompact] = React.useState(() => (
        typeof window !== 'undefined' && window.matchMedia('(max-width: 799px)').matches
    ));
    React.useEffect(() => {
        const media = window.matchMedia('(max-width: 799px)');
        const update = () => setCompact(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return compact;
}

export const NotebookFeed: React.FC<NotebookFeedProps> = (props) => {
    const config = useAppConfig();
    const logger = useLogger();
    const scriptDebugMode = config?.settings?.scriptDebugMode ?? false;
    const formattingDebugMode = config?.settings?.formattingDebugMode ?? false;
    const keywordCase = getKeywordCase(config?.settings);
    const compactLayout = useCompactFeedLayout();
    const scriptRefs = props.notebookScripts.scriptRefs;
    const canonicalEntries = React.useMemo(
        () => getSelectedScriptRefs(props.notebookScripts).map(entry => ({
            ...entry,
            estimatedHeight: estimateFeedEntryHeight(
                props.notebookScripts.scripts[entry.scriptId]?.scriptSession.getText() ?? '',
            ),
        })),
        [scriptRefs, props.notebookScripts.scripts],
    );
    const [displayEntries, setDisplayEntries] = React.useState(() => ({
        source: scriptRefs,
        entries: canonicalEntries,
    }));
    const entries = displayEntries.source === scriptRefs
        ? displayEntries.entries
        : canonicalEntries;
    React.useLayoutEffect(() => {
        setDisplayEntries({ source: scriptRefs, entries: canonicalEntries });
    }, [scriptRefs, canonicalEntries]);
    const storageReader = useStorageReader();

    const pendingCreatedScriptKeyRef = React.useRef<number | null>(null);
    const editorViewsRef = React.useRef(new Map<number, EditorView>());
    // Presence means collapsed. A query id marks an automatic no-result collapse; null marks a
    // manual collapse, which must not be reset when a later query starts.
    const [collapsedResults, setCollapsedResults] = React.useState<ReadonlyMap<number, number | null>>(() => new Map());

    const handleFocus = React.useCallback((fileName: string) => {
        props.modifyNotebookScripts({ type: SELECT_SCRIPT, value: fileName });
    }, [props.modifyNotebookScripts]);

    const handleShowStatus = React.useCallback((fileName: string) => {
        props.modifyNotebookScripts({ type: SELECT_SCRIPT, value: fileName });
        props.showDetails(fileName, DetailsTabKey.QueryStatusPanel);
    }, [props.modifyNotebookScripts, props.showDetails]);

    const handleShowTable = React.useCallback((fileName: string) => {
        props.modifyNotebookScripts({ type: SELECT_SCRIPT, value: fileName });
        props.showDetails(fileName, DetailsTabKey.QueryResultView);
    }, [props.modifyNotebookScripts, props.showDetails]);

    const handleShowVisualization = React.useCallback((fileName: string) => {
        props.modifyNotebookScripts({ type: SELECT_SCRIPT, value: fileName });
        props.showDetails(fileName, DetailsTabKey.Visualization);
    }, [props.modifyNotebookScripts, props.showDetails]);

    const handleShowDetails = React.useCallback((fileName: string) => {
        props.modifyNotebookScripts({ type: SELECT_SCRIPT, value: fileName });
        props.showDetails(fileName, DetailsTabKey.Editor);
    }, [props.modifyNotebookScripts, props.showDetails]);

    const isDisconnected = props.conn?.connectionHealth !== ConnectionHealth.ONLINE;
    const executeQuery = useQueryExecutor();

    // Refresh: drop the stale cache entry for a script's result, then re-execute — a plain cacheable
    // run then misses the cache and re-populates it. Resolves the script by feed file name.
    const handleRerunEntry = React.useCallback(async (fileName: string, cacheKey: string | null) => {
        if (isDisconnected) {
            return;
        }
        const notebookScripts = props.notebookScripts;
        const entry = notebookScripts.scriptRefs[fileName];
        const scriptData = entry != null ? notebookScripts.scripts[entry.scriptId] : undefined;
        if (scriptData == null) {
            return;
        }
        // Best-effort delete of the stale cache entry: a failed delete just means the run may hit the
        // old entry, which is harmless (the executor's write path overwrites it either way).
        if (cacheKey != null) {
            await storageReader.backend.deleteQueryResultCache(notebookScripts.notebookId, cacheKey).catch(() => { });
        }
        runNotebookScript(props.conn!.databaseId, notebookScripts, scriptData, executeQuery, props.modifyNotebookScripts, logger);
    }, [props.notebookScripts, props.modifyNotebookScripts, props.conn, isDisconnected, executeQuery, storageReader, logger]);

    const handleExecuteEntry = React.useCallback((fileName: string) => {
        if (isDisconnected) return;
        const notebookScripts = props.notebookScripts;
        const entry = notebookScripts.scriptRefs[fileName];
        const scriptData = entry != null ? notebookScripts.scripts[entry.scriptId] : undefined;
        if (scriptData == null) return;
        runNotebookScript(props.conn!.databaseId, notebookScripts, scriptData, executeQuery, props.modifyNotebookScripts, logger);
    }, [executeQuery, isDisconnected, props.conn, props.modifyNotebookScripts, props.notebookScripts, logger]);

    const handleDelete = React.useCallback((fileName: string) => {
        props.modifyNotebookScripts({ type: DELETE_SCRIPT, value: fileName });
    }, [props.modifyNotebookScripts]);

    const handleRename = React.useCallback((oldFileName: string, newFileName: string) => {
        props.modifyNotebookScripts({ type: RENAME_SCRIPT, value: { fileName: oldFileName, newFileName } });
    }, [props.modifyNotebookScripts]);

    // Move a script one position up/down within the notebook by swapping it with its neighbour in the
    // feed order and dispatching the new full order to REORDER_SCRIPTS.
    const moveScript = React.useCallback((fileName: string, delta: number) => {
        const order = getSortedScriptFileNames(props.notebookScripts.scriptRefs);
        const from = order.indexOf(fileName);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= order.length) return;
        [order[from], order[to]] = [order[to], order[from]];
        props.modifyNotebookScripts({
            type: REORDER_SCRIPTS,
            value: order,
        });
    }, [props.notebookScripts, props.modifyNotebookScripts]);
    const handleMoveUp = React.useCallback((fileName: string) => moveScript(fileName, -1), [moveScript]);
    const handleMoveDown = React.useCallback((fileName: string) => moveScript(fileName, 1), [moveScript]);
    const dndSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const handleDragEnd = React.useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (over == null || active.id === over.id) return;
        const reordered = reorderFeedEntries(entries, active.id, over.id);
        if (reordered == null) return;
        // Keep the dropped order visible while REORDER_SCRIPTS assigns durable filename prefixes.
        // Stable script ids let React and dnd-kit retain card identity without forcing a render while
        // dnd-kit still has the active drag transform applied.
        setDisplayEntries({ source: scriptRefs, entries: reordered });
        props.modifyNotebookScripts({
            type: REORDER_SCRIPTS,
            value: reordered.map(entry => entry.fileName),
        });
    }, [entries, props.modifyNotebookScripts, scriptRefs]);

    const handleFormat = React.useCallback((scriptKey: number, text: string) => {
        props.modifyNotebookScripts({
            type: SET_SCRIPT_TEXT,
            value: { scriptKey, text, withDiff: true },
        });
    }, [props.modifyNotebookScripts]);

    // Accept / reject a staged rewrite from the feed. Accept keeps the new text; reject restores the
    // prior text and re-analyzes.
    const handleAcceptDiff = React.useCallback((scriptKey: number) => {
        props.modifyNotebookScripts({ type: ACCEPT_PENDING_DIFF, value: scriptKey });
    }, [props.modifyNotebookScripts]);
    const handleRejectDiff = React.useCallback((scriptKey: number) => {
        props.modifyNotebookScripts({ type: REJECT_PENDING_DIFF, value: scriptKey });
    }, [props.modifyNotebookScripts]);
    const handleToggleResultExpanded = React.useCallback((scriptKey: number) => {
        setCollapsedResults(current => {
            const next = new Map(current);
            if (next.has(scriptKey)) next.delete(scriptKey);
            else next.set(scriptKey, null);
            return next;
        });
    }, []);
    const handleAutoCollapseResult = React.useCallback((scriptKey: number, queryId: number) => {
        setCollapsedResults(current => {
            if (current.has(scriptKey)) return current;
            const next = new Map(current);
            next.set(scriptKey, queryId);
            return next;
        });
    }, []);
    const handleResetAutoCollapsedResult = React.useCallback((scriptKey: number, queryId: number | null) => {
        setCollapsedResults(current => {
            const autoCollapsedQueryId = current.get(scriptKey);
            if (autoCollapsedQueryId == null || autoCollapsedQueryId === queryId) return current;
            const next = new Map(current);
            next.delete(scriptKey);
            return next;
        });
    }, []);

    // The feed stays mounted (just hidden) while the catalog/details overlay is open, so its global
    // key handlers would otherwise keep firing behind the overlay. Gate them all on the active flag.
    const feedActive = props.active;
    const keyHandlers = React.useMemo<KeyEventHandler[]>(() => [
        {
            // Plain Enter, while browsing the feed with nothing focused, accepts a staged
            // rewrite (matching the status bar's "Accept ⏎" hint). It intentionally does nothing for
            // ordinary scripts; Details is opened only through an explicit pointer action.
            key: 'Enter',
            ctrlKey: false,
            capture: true,
            callback: (event: KeyboardEvent) => {
                if (!feedActive) {
                    return;
                }
                const active = document.activeElement as HTMLElement | null;
                if (active && active !== document.body && active !== document.documentElement) {
                    return;
                }
                const focused = getSelectedScriptRef(props.notebookScripts);
                const focusedScript = focused != null ? props.notebookScripts.scripts[focused.scriptId] : null;
                if (focusedScript?.pendingDiff != null) {
                    event.preventDefault();
                    handleAcceptDiff(focusedScript.scriptKey);
                    return;
                }
            },
        },
        {
            // Escape, while browsing the feed with nothing focused, rejects a staged rewrite on the
            // focused entry (matching the status bar's "Reject ⎋" hint). Same focus guard as Enter so the
            // An inline editor, rename input, or open completion dropdown keeps Escape when focused.
            key: 'Escape',
            ctrlKey: false,
            capture: true,
            callback: (event: KeyboardEvent) => {
                if (!feedActive) {
                    return;
                }
                const active = document.activeElement as HTMLElement | null;
                if (active && active !== document.body && active !== document.documentElement) {
                    return;
                }
                const focused = getSelectedScriptRef(props.notebookScripts);
                const focusedScript = focused != null ? props.notebookScripts.scripts[focused.scriptId] : null;
                if (focusedScript?.pendingDiff != null) {
                    event.preventDefault();
                    handleRejectDiff(focusedScript.scriptKey);
                }
            },
        },
    ], [feedActive, props.notebookScripts, handleAcceptDiff, handleRejectDiff]);
    useKeyEvents(keyHandlers);

    const feedLayout = useNotebookFeedLayout(
        entries,
        compactLayout ? COMPACT_FIRST_SEPARATOR_HEIGHT : FIRST_SEPARATOR_HEIGHT,
    );

    const handleEditorView = React.useCallback((scriptKey: number, view: EditorView) => {
        editorViewsRef.current.set(scriptKey, view);
        if (pendingCreatedScriptKeyRef.current !== scriptKey) return;
        pendingCreatedScriptKeyRef.current = null;
        requestAnimationFrame(() => view.focus());
    }, []);

    const handleCreate = React.useCallback((index: number) => {
        const result = props.modifyNotebookScripts({ type: CREATE_SCRIPT, value: index });
        if (!result) return;
        void result.then(next => {
            if (next == null) return;
            const created = getSelectedScriptRef(next);
            if (created == null) return;
            const view = editorViewsRef.current.get(created.scriptId);
            if (view != null) {
                view.focus();
            } else {
                pendingCreatedScriptKeyRef.current = created.scriptId;
            }
        });
    }, [props.modifyNotebookScripts]);

    const canDelete = entries.length > 1;
    const rowProps = React.useMemo<ScriptFeedRowProps>(() => ({
        notebookId: props.notebookScripts.notebookId,
        connection: props.conn,
        connectorType: props.notebookScripts.connectorInfo.connectorType,
        entries,
        storageReader: storageReader,
        scripts: props.notebookScripts.scripts,
        scriptDebugMode,
        formattingDebugMode,
        keywordCase,
        focusedFileName: props.notebookScripts.scriptFocus.fileName,
        canDelete,
        active: props.active,
        onFocus: handleFocus,
        onDelete: handleDelete,
        onRename: handleRename,
        onMoveUp: handleMoveUp,
        onMoveDown: handleMoveDown,
        onExecute: handleExecuteEntry,
        onShowStatus: handleShowStatus,
        onShowTable: handleShowTable,
        onShowVisualization: handleShowVisualization,
        onShowDetails: handleShowDetails,
        onRerun: handleRerunEntry,
        onFormat: handleFormat,
        onAcceptDiff: handleAcceptDiff,
        onRejectDiff: handleRejectDiff,
        collapsedResults,
        onToggleResultExpanded: handleToggleResultExpanded,
        onAutoCollapseResult: handleAutoCollapseResult,
        onResetAutoCollapsedResult: handleResetAutoCollapsedResult,
        topPadding: compactLayout ? COMPACT_FEED_TOP_PADDING : FEED_TOP_PADDING,
        onCreate: handleCreate,
        onEditorView: handleEditorView,
        onRowHeightChange: feedLayout.rowHeights.setRowHeight,
    }), [entries, props.active, props.notebookScripts.scripts, props.notebookScripts.scriptFocus.fileName, props.notebookScripts.connectorInfo.connectorType, scriptDebugMode, formattingDebugMode, keywordCase, compactLayout, canDelete, handleFocus, handleDelete, handleRename, handleMoveUp, handleMoveDown, handleExecuteEntry, handleShowStatus, handleShowTable, handleShowVisualization, handleShowDetails, handleRerunEntry, handleFormat, handleAcceptDiff, handleRejectDiff, collapsedResults, handleToggleResultExpanded, handleAutoCollapseResult, handleResetAutoCollapsedResult, handleCreate, handleEditorView, feedLayout.rowHeights.setRowHeight]);
    const getScrollElement = React.useCallback(() => feedLayout.listRef.current?.element ?? null, [feedLayout.listRef]);

    return (
        <div
            className={styles.feed_body_container}
            style={{ '--feed-scrollbar-inset': `${feedLayout.listScrollbarInset}px` } as React.CSSProperties}
        >
            <div className={styles.feed_list_container} ref={feedLayout.listContainerRef}>
                <DndContext
                    sensors={dndSensors}
                    collisionDetection={closestCenter}
                    modifiers={[restrictToVerticalAxis]}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext items={entries.map(entry => entry.scriptId)} strategy={verticalListSortingStrategy}>
                        <List
                            key={props.notebookScripts.notebookId}
                            listRef={feedLayout.listRef}
                            style={{
                                width: feedLayout.listWidth,
                                height: feedLayout.listHeight,
                                overflowX: 'hidden',
                                scrollbarGutter: 'stable',
                                '--feed-scrollbar-inset': `${feedLayout.listScrollbarInset}px`,
                            } as React.CSSProperties}
                            rowCount={entries.length * 2 + 1}
                            overscanCount={OVERSCAN_ROW_COUNT}
                            rowHeight={feedLayout.rowHeights}
                            rowComponent={ScriptFeedRow}
                            rowProps={rowProps}
                        />
                    </SortableContext>
                </DndContext>
                {props.active && (
                    <VerticalScrollShadows
                        getScrollElement={getScrollElement}
                        portalContainer={props.scrollShadowContainer}
                        prominent
                        refreshKey={`${props.notebookScripts.notebookId}:${entries.length}:${feedLayout.rowHeightsVersion}`}
                    />
                )}
            </div>
        </div>
    );
};
