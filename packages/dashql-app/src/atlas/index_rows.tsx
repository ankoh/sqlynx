import * as React from 'react';
import type { Dispatch } from 'react';

import { TableColumnHeader } from '../app/notebook/compute/ui/query_result/data_table_cell.js';
import { DataTable } from '../app/notebook/compute/ui/query_result/data_table.js';
import { getMatchingRowCount, TableSearchToolbar } from '../app/notebook/compute/ui/query_result/query_result_toolbar.js';
import { resolveSearchedRowIndices } from '../app/notebook/compute/ui/query_result/visible_rows.js';
import { formatRowCountDetail, TabHeader } from '../app/notebook/ui/tab_header.js';
import { SET_CROSS_FILTERS, type ComputationAction, type TableComputationState } from '../compute/computation_state.js';
import { CrossFilters } from '../compute/cross_filters.js';
import { ButtonSize, ButtonVariant, IconButton } from '../ui/foundations/button.js';
import { ChevronDownIcon, ChevronUpIcon, SymbolIcon } from '../ui/foundations/symbol_icon.js';
import * as styles from './atlas.module.css';

const MIN_TABLE_HEIGHT = 120;
const MAX_TABLE_HEIGHT = 800;
/// The share of the window the table starts with
const DEFAULT_TABLE_SHARE = 0.3;
/// The share of the window the table takes at most, the cloud stays visible above it
const MAX_TABLE_SHARE = 0.75;
const KEYBOARD_STEP = 40;
const COLLAPSED_KEY = 'dashql.atlas.rows_collapsed';
const ClearFiltersIcon = SymbolIcon('filter_remove_24');

/// A bit per row of the analyzed table that matches its cross-filters and its data search, none if nothing is filtered or
/// searched. Row i is point i of the cloud.
export function selectedRows(table: TableComputationState | null): Uint32Array | null {
    if (table == null || (table.filterTable == null && table.dataSearch.matchingRows == null)) return null;
    const rows = table.dataTable.numRows;
    const selection = new Uint32Array(Math.ceil(rows / 32));
    for (const row of resolveSearchedRowIndices(table) ?? []) {
        if (row >= 0 && row < rows) selection[row >>> 5] |= 1 << (row & 31);
    }
    return selection;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

/// The height of the table, which the handle on top of the card drags. At most a share of the window.
function useTableHeight(): [number, number, (height: number) => void] {
    const [windowHeight, setWindowHeight] = React.useState(() => window.innerHeight);
    React.useEffect(() => {
        const onResize = () => setWindowHeight(window.innerHeight);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const maxHeight = Math.max(MIN_TABLE_HEIGHT, Math.min(MAX_TABLE_HEIGHT, Math.round(windowHeight * MAX_TABLE_SHARE)));
    const [height, setHeight] = React.useState(() => Math.round(window.innerHeight * DEFAULT_TABLE_SHARE));
    const resize = React.useCallback((next: number) => setHeight(clamp(next, MIN_TABLE_HEIGHT, maxHeight)), [maxHeight]);
    return [clamp(height, MIN_TABLE_HEIGHT, maxHeight), maxHeight, resize];
}

/// Whether the rows card is collapsed, remembered per browser. Narrow screens start collapsed.
export function useRowsCollapsed(): [boolean, () => void] {
    const [collapsed, setCollapsed] = React.useState(() => {
        try {
            const stored = window.localStorage.getItem(COLLAPSED_KEY);
            if (stored != null) return stored === 'true';
        } catch {
            // Storage may be unavailable, e.g. in a private window
        }
        return window.matchMedia?.('(max-width: 720px)').matches ?? false;
    });
    const toggle = React.useCallback(() => setCollapsed(c => {
        try {
            window.localStorage.setItem(COLLAPSED_KEY, String(!c));
        } catch {
            // Not remembered then
        }
        return !c;
    }), []);
    return [collapsed, toggle];
}

interface IndexRowsCardProps {
    title: string;
    /// The analyzed rows of the shown index file, none while they are analyzed
    table: TableComputationState | null;
    dispatchComputation: Dispatch<ComputationAction>;
    collapsed: boolean;
    onToggle: () => void;
}

/// The rows of the index file that the cloud shows, with a histogram per column. Brushing a histogram or picking a
/// frequent value filters the rows and fades the other dots of the cloud. Looks like the result overlay of the shell:
/// a tab header and the table below it, standing on the bottom edge of the page.
export const IndexRowsCard: React.FC<IndexRowsCardProps> = props => {
    const { table, dispatchComputation } = props;
    const [tableHeight, maxTableHeight, setTableHeight] = useTableHeight();
    const [dragging, setDragging] = React.useState(false);
    const total = table?.dataTable.numRows ?? null;
    const matching = getMatchingRowCount(table) ?? table?.filterTable?.dataTable.numRows ?? null;
    const detail = matching == null ? formatRowCountDetail(total) : `${matching} of ${total} rows`;
    const hasCrossFilters = table != null && Object.keys(table.crossFilters.columnFilters).length > 0;
    const clearCrossFilters = React.useCallback(() => {
        if (table != null) dispatchComputation({ type: SET_CROSS_FILTERS, value: [table.tableId, new CrossFilters()] });
    }, [table, dispatchComputation]);
    // The card stands on the bottom edge, it hides downward and shows upward
    const Chevron = props.collapsed ? ChevronUpIcon : ChevronDownIcon;

    // Dragging the handle up grows the table
    const onHandlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pointerId = event.pointerId;
        const startY = event.clientY;
        const startHeight = tableHeight;
        setDragging(true);
        const onMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            moveEvent.preventDefault();
            setTableHeight(startHeight + startY - moveEvent.clientY);
        };
        const onEnd = (endEvent: PointerEvent) => {
            if (endEvent.pointerId !== pointerId) return;
            if (endEvent.type === 'pointercancel') setTableHeight(startHeight);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
            setDragging(false);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }, [tableHeight, setTableHeight]);
    const onHandleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        let next: number | null = null;
        switch (event.key) {
            case 'ArrowUp':
                next = tableHeight + KEYBOARD_STEP;
                break;
            case 'ArrowDown':
                next = tableHeight - KEYBOARD_STEP;
                break;
            case 'Home':
                next = MIN_TABLE_HEIGHT;
                break;
            case 'End':
                next = maxTableHeight;
                break;
        }
        if (next == null) return;
        event.preventDefault();
        setTableHeight(next);
    }, [tableHeight, maxTableHeight, setTableHeight]);

    return (
        <section className={`${styles.rows_panel} ${dragging ? styles.rows_dragging : ''}`} aria-label={props.title}>
            {!props.collapsed && (
                <div
                    className={styles.rows_handle}
                    role="separator"
                    tabIndex={0}
                    aria-label="Resize rows"
                    aria-orientation="horizontal"
                    aria-valuemin={MIN_TABLE_HEIGHT}
                    aria-valuemax={maxTableHeight}
                    aria-valuenow={tableHeight}
                    title="Drag to resize"
                    onPointerDown={onHandlePointerDown}
                    onKeyDown={onHandleKeyDown}
                >
                    <span className={styles.rows_handle_bar} aria-hidden="true" />
                </div>
            )}
            <TabHeader
                title={props.title}
                detail={detail}
                actions={(
                    <>
                        <TableSearchToolbar table={table} dispatch={dispatchComputation} />
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            aria-label="Clear all cross-filters"
                            onClick={clearCrossFilters}
                            disabled={!hasCrossFilters}
                        >
                            <ClearFiltersIcon size={16} />
                        </IconButton>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            aria-label={props.collapsed ? 'Show rows' : 'Hide rows'}
                            aria-expanded={!props.collapsed}
                            onClick={props.onToggle}
                        >
                            <Chevron size={16} />
                        </IconButton>
                    </>
                )}
            />
            {!props.collapsed && (table == null
                ? <div className={styles.rows_status}>Analyzing rows</div>
                : (
                    <DataTable
                        table={table}
                        dispatchComputation={dispatchComputation}
                        debugMode={false}
                        columnHeader={TableColumnHeader.WithColumnPlots}
                        fitHeight
                        maxHeight={tableHeight}
                        compact
                    />
                ))}
        </section>
    );
};
