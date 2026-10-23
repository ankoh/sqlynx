import * as React from 'react';
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core';

import type { SessionScripts } from '../scripts/session_scripts.js';
import type { ModifySessionScripts } from '../scripts/session_scripts_registry.js';
import { DashboardCard } from './dashboard_card.js';
import {
    DASHBOARD_COLUMN_COUNT,
    DASHBOARD_ROW_HEIGHT,
    moveDashboardItem,
    placeDashboardItems,
    resizeDashboardItem,
    type DashboardPlacement,
} from './dashboard_layout.js';
import { persistDashboardPlacement } from './dashboard_source.js';
import * as styles from './dashboard.module.css';

const GRID_GAP = 12;

function samePlacement(a: DashboardPlacement | undefined, b: DashboardPlacement): boolean {
    return a != null && a.id === b.id && a.row === b.row && a.column === b.column && a.width === b.width && a.height === b.height;
}

/// Keep the placements that did not change, the memoized cards only render again when their own placement changes.
/// Returns the previous layout if nothing changed.
function sharePlacements(next: DashboardPlacement[], previous: DashboardPlacement[]): DashboardPlacement[] {
    const previousById = new Map(previous.map(item => [item.id, item]));
    let changed = next.length !== previous.length;
    const shared = next.map((item, index) => {
        const before = previousById.get(item.id);
        if (!samePlacement(before, item)) {
            changed = true;
            return item;
        }
        if (previous[index] !== before) changed = true;
        return before!;
    });
    return changed ? shared : previous;
}

interface Props {
    sessionScripts: SessionScripts;
    modifySessionScripts: ModifySessionScripts;
}

function readLayout(sessionScripts: SessionScripts): DashboardPlacement[] {
    return placeDashboardItems(sessionScripts.scriptOrder
        .map(fileName => sessionScripts.scripts[sessionScripts.scriptRefs[fileName].scriptId])
        .filter(script => script?.annotations.visualizeQuery != null)
        .map(script => ({
            id: script.scriptKey,
            ...script.annotations.visualizeQuery!.dashboardSpec,
        })));
}

export function Dashboard(props: Props): React.ReactElement {
    const gridRef = React.useRef<HTMLDivElement | null>(null);
    const resizeBaselineRef = React.useRef<DashboardPlacement[] | null>(null);
    const [layout, setLayout] = React.useState(() => readLayout(props.sessionScripts));
    const [gridWidth, setGridWidth] = React.useState(0);
    const [announcement, setAnnouncement] = React.useState('');
    const scripts = props.sessionScripts.scriptOrder
        .map(fileName => props.sessionScripts.scripts[props.sessionScripts.scriptRefs[fileName].scriptId])
        .filter(script => script?.annotations.visualizeQuery != null);
    const layoutSourceKey = scripts.map(script => {
        const spec = script.annotations.visualizeQuery!.dashboardSpec;
        return `${script.scriptKey}:${spec?.row ?? ''}:${spec?.column ?? ''}:${spec?.width ?? ''}:${spec?.height ?? ''}`;
    }).join('|');

    React.useEffect(() => setLayout(readLayout(props.sessionScripts)), [layoutSourceKey]);
    React.useEffect(() => {
        const grid = gridRef.current;
        if (grid == null) return;
        const observer = new ResizeObserver(entries => setGridWidth(entries[0]?.contentRect.width ?? grid.clientWidth));
        observer.observe(grid);
        setGridWidth(grid.clientWidth);
        return () => observer.disconnect();
    }, []);

    const columnStep = gridWidth > 0 ? (gridWidth - GRID_GAP * (DASHBOARD_COLUMN_COUNT - 1)) / DASHBOARD_COLUMN_COUNT + GRID_GAP : 1;
    const rowStep = DASHBOARD_ROW_HEIGHT + GRID_GAP;
    const keyboardCoordinates = React.useCallback<KeyboardCoordinateGetter>((event, { currentCoordinates }) => {
        switch (event.code) {
            case 'ArrowLeft': return { ...currentCoordinates, x: currentCoordinates.x - columnStep };
            case 'ArrowRight': return { ...currentCoordinates, x: currentCoordinates.x + columnStep };
            case 'ArrowUp': return { ...currentCoordinates, y: currentCoordinates.y - rowStep };
            case 'ArrowDown': return { ...currentCoordinates, y: currentCoordinates.y + rowStep };
            default: return undefined;
        }
    }, [columnStep, rowStep]);
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
    );

    const persistLayout = React.useCallback((next: DashboardPlacement[], previous: DashboardPlacement[]) => {
        const previousById = new Map(previous.map(item => [item.id, item]));
        for (const placement of next) {
            const before = previousById.get(placement.id);
            if (before?.row === placement.row && before.column === placement.column
                && before.width === placement.width && before.height === placement.height) continue;
            const script = props.sessionScripts.scripts[placement.id];
            if (script != null) persistDashboardPlacement(script, placement, props.modifySessionScripts);
        }
    }, [props.sessionScripts.scripts, props.modifySessionScripts]);

    const handleDragEnd = React.useCallback((event: DragEndEvent) => {
        const ownerId = Number(event.active.id);
        const current = layout.find(item => item.id === ownerId);
        if (current == null) return;
        const next = moveDashboardItem(
            layout,
            ownerId,
            current.row + Math.round(event.delta.y / rowStep),
            current.column + Math.round(event.delta.x / columnStep),
        );
        setLayout(next);
        persistLayout(next, layout);
        const placed = next.find(item => item.id === ownerId);
        const script = props.sessionScripts.scripts[ownerId];
        if (placed && script) {
            setAnnouncement(`${script.fileName} moved to row ${placed.row + 1}, column ${placed.column + 1}`);
        }
    }, [layout, columnStep, rowStep, persistLayout, props.sessionScripts.scripts]);

    // The resize handler reads the layout through a ref, so that the cards keep their callback while the layout changes
    const layoutRef = React.useRef(layout);
    layoutRef.current = layout;
    const handleResize = React.useCallback((ownerId: number, width: number, height: number, commit: boolean) => {
        const current = layoutRef.current;
        const baseline = resizeBaselineRef.current ?? current;
        if (!commit && resizeBaselineRef.current == null) resizeBaselineRef.current = current;
        const next = sharePlacements(resizeDashboardItem(current, ownerId, width, height), current);
        // Pointer moves within the snapped size do not change the layout
        if (!commit && next === current) return;
        setLayout(next);
        if (commit) {
            persistLayout(next, baseline);
            resizeBaselineRef.current = null;
        }
    }, [persistLayout]);

    const handleResizeCancel = React.useCallback(() => {
        if (resizeBaselineRef.current != null) setLayout(resizeBaselineRef.current);
        resizeBaselineRef.current = null;
    }, []);

    const placementById = new Map(layout.map(item => [item.id, item]));
    const scriptOrder = new Map(scripts.map((script, index) => [script.scriptKey, index]));
    const visualScripts = [...scripts].sort((left, right) => {
        const a = placementById.get(left.scriptKey);
        const b = placementById.get(right.scriptKey);
        if (a == null || b == null) return (scriptOrder.get(left.scriptKey) ?? 0) - (scriptOrder.get(right.scriptKey) ?? 0);
        return a.row - b.row || a.column - b.column
            || (scriptOrder.get(left.scriptKey) ?? 0) - (scriptOrder.get(right.scriptKey) ?? 0);
    });
    const rows = layout.reduce((max, item) => Math.max(max, item.row + item.height), 0);
    return (
        <section className={styles.page} aria-label="Dashboard">
            <div className={styles.sr_only} role="status" aria-live="polite">{announcement}</div>
            {scripts.length === 0 ? (
                <div className={styles.empty_state}>
                    <strong>No visualizations yet</strong>
                    <span>Resolved VISUALIZE scripts appear here automatically.</span>
                </div>
            ) : (
                <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                    <div
                        ref={gridRef}
                        className={styles.grid}
                        style={{ minHeight: rows * DASHBOARD_ROW_HEIGHT + Math.max(0, rows - 1) * GRID_GAP }}
                    >
                        {visualScripts.map(script => {
                            const placement = placementById.get(script.scriptKey);
                            const preferred = script.annotations.visualizeQuery!.dashboardSpec;
                            const shifted = (preferred?.row != null && preferred.row !== placement?.row)
                                || (preferred?.column != null && preferred.column !== placement?.column);
                            return placement == null ? null : (
                                <DashboardCard
                                    key={script.scriptKey}
                                    sessionId={props.sessionScripts.sessionId}
                                    script={script}
                                    placement={placement}
                                    columnStep={columnStep}
                                    rowStep={rowStep}
                                    onResize={handleResize}
                                    onResizeCancel={handleResizeCancel}
                                    shifted={shifted}
                                />
                            );
                        })}
                    </div>
                </DndContext>
            )}
        </section>
    );
}
