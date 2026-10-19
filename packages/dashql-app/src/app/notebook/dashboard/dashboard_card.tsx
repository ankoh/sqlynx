import * as React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import { QueryResultView } from '../compute/ui/query_result/query_result_view.js';
import { TableColumnHeader } from '../compute/ui/query_result/data_table_cell.js';
import { VisualizationDispatch } from '../compute/ui/visualization/visualization_dispatch.js';
import { useQueryState } from '../connections/query_executor.js';
import type { ScriptData } from '../scripts/notebook_scripts.js';
import { scriptDisplayName, type ResolvedVisualizeQuery } from '../scripts/script_types.js';
import { ScriptEditor } from '../ui/script_editor.js';
import { SegmentedControl, SegmentedControlSize } from '../../../ui/foundations/segmented_control.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import type { DashboardPlacement } from './dashboard_layout.js';
import * as styles from './dashboard.module.css';

const DragHandleIcon = SymbolIcon('drag_handle_16');

export interface DashboardCardDependencies {
    useQueryState: typeof useQueryState;
    QueryResultView: typeof QueryResultView;
    VisualizationDispatch: typeof VisualizationDispatch;
    ScriptEditor: typeof ScriptEditor;
}

const DEFAULT_DEPENDENCIES: DashboardCardDependencies = {
    useQueryState,
    QueryResultView,
    VisualizationDispatch,
    ScriptEditor,
};

interface Props {
    notebookId: string;
    script: ScriptData;
    placement: DashboardPlacement;
    columnStep: number;
    rowStep: number;
    onResize: (scriptId: number, width: number, height: number, commit: boolean) => void;
    onResizeCancel: () => void;
    shifted: boolean;
    dependencies?: DashboardCardDependencies;
}

/// Memoized, a resize of one card only renders the cards whose placement changed
export const DashboardCard = React.memo(function DashboardCard(props: Props): React.ReactElement {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const query = dependencies.useQueryState(props.notebookId, props.script.latestQueryId);
    const visualizeQuery = props.script.annotations.visualizeQuery as ResolvedVisualizeQuery;
    const [contentSelected, setContentSelected] = React.useState(false);
    const resizeStart = React.useRef<{ x: number; y: number; width: number; height: number; pointerId: number } | null>(null);
    const draggable = useDraggable({ id: props.script.scriptKey });
    const transform = draggable.transform == null ? undefined : CSS.Translate.toString(draggable.transform);

    const resizeFromPointer = React.useCallback((event: PointerEvent, commit: boolean) => {
        const start = resizeStart.current;
        if (start == null || event.pointerId !== start.pointerId) return;
        const width = start.width + Math.round((event.clientX - start.x) / Math.max(1, props.columnStep));
        const height = start.height + Math.round((event.clientY - start.y) / Math.max(1, props.rowStep));
        props.onResize(props.script.scriptKey, width, height, commit);
        if (commit) resizeStart.current = null;
    }, [props.columnStep, props.rowStep, props.onResize, props.script.scriptKey]);

    const startResize = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        resizeStart.current = {
            x: event.clientX,
            y: event.clientY,
            width: props.placement.width,
            height: props.placement.height,
            pointerId: event.pointerId,
        };
        const move = (next: PointerEvent) => resizeFromPointer(next, false);
        const finish = (next: PointerEvent) => {
            resizeFromPointer(next, true);
            cleanup();
        };
        const cancel = () => {
            resizeStart.current = null;
            props.onResizeCancel();
            cleanup();
        };
        const cleanup = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', finish);
            window.removeEventListener('pointercancel', cancel);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', cancel);
    }, [props.placement.width, props.placement.height, props.onResizeCancel, resizeFromPointer]);

    const resizeWithKeyboard = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
        let width = props.placement.width;
        let height = props.placement.height;
        if (event.key === 'ArrowLeft') width -= 1;
        else if (event.key === 'ArrowRight') width += 1;
        else if (event.key === 'ArrowUp') height -= 1;
        else if (event.key === 'ArrowDown') height += 1;
        else return;
        event.preventDefault();
        props.onResize(props.script.scriptKey, width, height, true);
    }, [props.placement, props.onResize, props.script.scriptKey]);

    return (
        <article
            ref={draggable.setNodeRef}
            className={`${styles.card} ${contentSelected ? styles.card_content : ''}`}
            data-dashboard-card={props.script.scriptKey}
            style={{
                gridColumn: `${props.placement.column + 1} / span ${props.placement.width}`,
                gridRow: `${props.placement.row + 1} / span ${props.placement.height}`,
                transform,
                zIndex: draggable.isDragging ? 2 : undefined,
                '--dashboard-card-rows': props.placement.height,
                '--dashboard-card-height': `${props.placement.height * 96}px`,
            } as React.CSSProperties}
        >
            <header className={styles.card_header}>
                <button
                    type="button"
                    className={styles.drag_handle}
                    aria-label={`Move ${scriptDisplayName(props.script.fileName)}`}
                    {...draggable.listeners}
                    {...draggable.attributes}
                >
                    <DragHandleIcon />
                </button>
                <h2 className={styles.card_title}>{scriptDisplayName(props.script.fileName)}</h2>
                {props.shifted && <span className={styles.shifted_badge} title="Moved to avoid overlapping another dashboard card">Shifted</span>}
                <SegmentedControl
                    aria-label={`Card view for ${scriptDisplayName(props.script.fileName)}`}
                    className={styles.card_segments}
                    size={SegmentedControlSize.Tiny}
                    onChange={index => setContentSelected(index === 1)}
                >
                    <SegmentedControl.Button selected={!contentSelected}>Output</SegmentedControl.Button>
                    <SegmentedControl.Button selected={contentSelected}>Content</SegmentedControl.Button>
                </SegmentedControl>
            </header>
            <div className={styles.card_body}>
                {contentSelected ? (
                    <dependencies.ScriptEditor
                        notebookId={props.notebookId}
                        scriptKey={props.script.scriptKey}
                        className={styles.card_editor}
                    />
                ) : visualizeQuery.renderer === 'table' ? (
                    <dependencies.QueryResultView
                        query={query}
                        debugMode={false}
                        columnHeader={TableColumnHeader.OnlyColumnName}
                        cellBackground="white"
                        fitHeight={false}
                        compact
                    />
                ) : (
                    <dependencies.VisualizationDispatch
                        query={query}
                        visualizeQuery={visualizeQuery}
                        interactive
                        wheelZoom
                        hideLegend={props.placement.width < 5}
                    />
                )}
            </div>
            <button
                type="button"
                className={styles.resize_handle}
                aria-label={`Resize ${scriptDisplayName(props.script.fileName)}. Current size ${props.placement.width} columns by ${props.placement.height} rows`}
                onPointerDown={startResize}
                onKeyDown={resizeWithKeyboard}
            />
        </article>
    );
});
