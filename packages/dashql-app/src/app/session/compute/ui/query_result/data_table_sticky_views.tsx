import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as styles from './data_table.module.css';

import type { DataCellData, HeaderNameCellProps, HeaderPlotsCellProps } from './data_table_cell.js';
import { DataCell, HeaderNameCell, HeaderPlotsCell, TableColumnHeader } from './data_table_cell.js';
import type { DataTablePortalContainers } from './data_table_portals.js';
import { ChevronDownIcon, ChevronUpIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { arePropsEqualWithStyle } from './memo_props.js';

/// Row header cells of the sticky column only re-render when their own props change
const StickyRowHeaderCell = React.memo(DataCell, arePropsEqualWithStyle);
const STICKY_ROW_HEADER_ARIA = { 'aria-colindex': 1, role: 'gridcell' } as const;

interface StickyHeadersProps {
    container: DataTablePortalContainers['header'] | null;
    totalWidth: number;
    headerHeight: number;
    firstColumnWidth: number;
    leftSpacerWidth: number;
    rightSpacerWidth: number;
    firstRenderedColumn: number;
    renderedColumnCount: number;
    getColumnWidth: (columnIndex: number) => number;
    columnHeader: TableColumnHeader;
    plotsHeight: number;
    plotsCollapsed: boolean;
    onTogglePlots: () => void;
    nameCellProps: Omit<HeaderNameCellProps, 'columnIndex' | 'style' | 'sortAscending'> & {
        getSortDirection: (fieldId: number) => boolean | null;
    };
    plotCellProps: Omit<HeaderPlotsCellProps, 'columnIndex' | 'style'>;
}

export const DataTableStickyHeaders = React.memo((props: StickyHeadersProps) => {
    if (props.container == null) return null;
    const renderNameCell = (columnIndex: number, sticky: boolean) => (
        <HeaderNameCell
            key={`header-0-${columnIndex}`}
            columnIndex={columnIndex}
            style={{
                width: props.getColumnWidth(columnIndex),
                height: 32,
                ...(!sticky ? { flexShrink: 0 } : {}),
            }}
            table={props.nameCellProps.table}
            gridLayout={props.nameCellProps.gridLayout}
            dataFrame={props.nameCellProps.dataFrame}
            rightmostVisibleColumn={props.nameCellProps.rightmostVisibleColumn}
            sortAscending={props.nameCellProps.getSortDirection(props.nameCellProps.gridLayout.arrowFieldByColumnIndex[columnIndex])}
            onOrderByColumn={props.nameCellProps.onOrderByColumn}
            onShowTable={props.nameCellProps.onShowTable}
        />
    );
    const renderPlotCell = (columnIndex: number, sticky: boolean) => (
        <HeaderPlotsCell
            key={`header-1-${columnIndex}`}
            {...props.plotCellProps}
            columnIndex={columnIndex}
            style={{
                width: props.getColumnWidth(columnIndex),
                height: props.plotsHeight,
                ...(!sticky ? { flexShrink: 0 } : {}),
            }}
        />
    );
    const PlotsChevron = props.plotsCollapsed ? ChevronDownIcon : ChevronUpIcon;

    return ReactDOM.createPortal(
        <div
            className={styles.sticky_header_container}
            style={{ position: 'sticky', top: 0, zIndex: 10, width: props.totalWidth, height: props.headerHeight }}
        >
            <div className={styles.sticky_header_row} style={{ display: 'flex', height: 32 }}>
                <div style={{ position: 'sticky', left: 0, zIndex: 11, flexShrink: 0 }}>{renderNameCell(0, true)}</div>
                {props.leftSpacerWidth > 0 && <div style={{ width: props.leftSpacerWidth, flexShrink: 0 }} />}
                {Array.from({ length: props.renderedColumnCount }, (_, index) => renderNameCell(props.firstRenderedColumn + index, false))}
                {props.rightSpacerWidth > 0 && <div style={{ width: props.rightSpacerWidth, flexShrink: 0 }} />}
            </div>
            {props.columnHeader === TableColumnHeader.WithColumnPlots && (
                <div className={styles.sticky_header_row} style={{ display: 'flex', height: props.plotsHeight }}>
                    <div style={{ position: 'sticky', left: 0, zIndex: 11, flexShrink: 0 }}>
                        <button
                            type="button"
                            className={styles.plots_toggle}
                            style={{ width: props.firstColumnWidth, height: props.plotsHeight }}
                            aria-label={props.plotsCollapsed ? 'Show column plots' : 'Hide column plots'}
                            aria-expanded={!props.plotsCollapsed}
                            title={props.plotsCollapsed ? 'Show column plots' : 'Hide column plots'}
                            onClick={props.onTogglePlots}
                        >
                            <PlotsChevron size={props.plotsCollapsed ? 12 : 16} />
                        </button>
                    </div>
                    {props.plotsCollapsed ? (
                        // The plots are not rendered at all, which also holds off their filtered aggregations
                        <div className={styles.plots_collapsed_cell} style={{ width: props.totalWidth - props.firstColumnWidth }} />
                    ) : (
                        <>
                            {props.leftSpacerWidth > 0 && <div style={{ width: props.leftSpacerWidth, flexShrink: 0 }} />}
                            {Array.from({ length: props.renderedColumnCount }, (_, index) => renderPlotCell(props.firstRenderedColumn + index, false))}
                            {props.rightSpacerWidth > 0 && <div style={{ width: props.rightSpacerWidth, flexShrink: 0 }} />}
                        </>
                    )}
                </div>
            )}
        </div>,
        props.container,
    );
});

interface StickyColumnProps {
    container: DataTablePortalContainers['data'] | null;
    firstColumnWidth: number;
    totalDataHeight: number;
    startRow: number;
    stopRow: number;
    gridData: DataCellData;
}

export const DataTableStickyColumn = React.memo((props: StickyColumnProps) => {
    if (props.container == null) return null;
    const visibleCount = Math.max(0, props.stopRow - props.startRow + 1);
    return ReactDOM.createPortal(
        <div
            className={styles.sticky_column_container}
            style={{
                position: 'sticky',
                left: 0,
                width: props.firstColumnWidth,
                height: props.totalDataHeight,
                marginTop: -props.totalDataHeight,
                zIndex: 5,
                pointerEvents: 'none',
            }}
        >
            {Array.from({ length: visibleCount }, (_, index) => {
                const rowIndex = props.startRow + index;
                return (
                    <div
                        key={`col0-${rowIndex}`}
                        style={{
                            position: 'absolute',
                            top: rowIndex * 26,
                            left: 0,
                            width: props.firstColumnWidth,
                            height: 26,
                            pointerEvents: 'auto',
                        }}
                    >
                        <StickyRowHeaderCell
                            ariaAttributes={STICKY_ROW_HEADER_ARIA}
                            rowIndex={rowIndex}
                            columnIndex={0}
                            style={{ width: props.firstColumnWidth, height: 26 }}
                            {...props.gridData}
                            hideRowHeader={false}
                        />
                    </div>
                );
            })}
        </div>,
        props.container,
    );
});
