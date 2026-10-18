import * as React from 'react';
import type { Dispatch } from 'react';

import { TableColumnHeader } from '../app/notebook/compute/ui/query_result/data_table_cell.js';
import { DataTable } from '../app/notebook/compute/ui/query_result/data_table.js';
import { resolveVisibleRowIndices } from '../app/notebook/compute/ui/query_result/visible_rows.js';
import { formatRowCountDetail, TabHeader } from '../app/notebook/ui/tab_header.js';
import { SET_CROSS_FILTERS, type ComputationAction, type TableComputationState } from '../compute/computation_state.js';
import { CrossFilters } from '../compute/cross_filters.js';
import { ButtonSize, ButtonVariant, IconButton } from '../ui/foundations/button.js';
import { ChevronDownIcon, ChevronUpIcon, SymbolIcon } from '../ui/foundations/symbol_icon.js';
import * as styles from './atlas.module.css';

const MAX_TABLE_HEIGHT = 360;
const COLLAPSED_KEY = 'dashql.atlas.rows_collapsed';
const ClearFiltersIcon = SymbolIcon('filter_remove_24');

/// A bit per row of the analyzed table that matches its cross-filters, none if nothing is filtered. Row i is point i of
/// the cloud.
export function selectedRows(table: TableComputationState | null): Uint32Array | null {
    if (table?.filterTable == null) return null;
    const rows = table.dataTable.numRows;
    const selection = new Uint32Array(Math.ceil(rows / 32));
    for (const row of resolveVisibleRowIndices(table) ?? []) {
        if (row >= 0 && row < rows) selection[row >>> 5] |= 1 << (row & 31);
    }
    return selection;
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
/// a tab header and the table below it.
export const IndexRowsCard: React.FC<IndexRowsCardProps> = props => {
    const { table, dispatchComputation } = props;
    const total = table?.dataTable.numRows ?? null;
    const matching = table?.filterTable?.dataTable.numRows ?? null;
    const detail = matching == null ? formatRowCountDetail(total) : `${matching} of ${total} rows`;
    const hasCrossFilters = table != null && Object.keys(table.crossFilters.columnFilters).length > 0;
    const clearCrossFilters = React.useCallback(() => {
        if (table != null) dispatchComputation({ type: SET_CROSS_FILTERS, value: [table.tableId, new CrossFilters()] });
    }, [table, dispatchComputation]);
    const Chevron = props.collapsed ? ChevronDownIcon : ChevronUpIcon;
    return (
        <section className={styles.rows_panel} aria-label={props.title}>
            <TabHeader
                title={props.title}
                detail={detail}
                actions={(
                    <>
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
                        maxHeight={MAX_TABLE_HEIGHT}
                        compact
                    />
                ))}
        </section>
    );
};
