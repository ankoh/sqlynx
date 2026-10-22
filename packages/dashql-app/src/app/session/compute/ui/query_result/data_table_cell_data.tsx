import * as arrow from 'apache-arrow';
import * as React from 'react';
import * as styles from './data_table.module.css';

import type { CellComponentProps } from 'react-window';

import { ArrowTableFormatter, isArrowListType } from '../../../../../compute/arrow_formatter.js';
import { ColumnGroup } from '../../../../../compute/computation_types.js';
import { DataTableLayout } from './data_table_layout.js';
import { peekFormat } from './format_peek.js';
import { CellFocus, DataTableFocusStore, useCellFocus } from './data_table_focus.js';

/// ---------------------------------------------------------------------------
/// Data Cell
/// ---------------------------------------------------------------------------

/// Cells are at most a few hundred pixels wide but text values can be megabytes large.
/// Render only a prefix, laying out the full text is what makes large cells slow.
const MAX_CELL_TEXT_LENGTH = 256;

function truncateCellText(text: string): string {
    return text.length > MAX_CELL_TEXT_LENGTH ? `${text.slice(0, MAX_CELL_TEXT_LENGTH)}…` : text;
}

export interface DataCellData {
    columnGroups: ColumnGroup[];
    visibleRowIndices: Int32Array | null;
    focus: DataTableFocusStore;
    gridLayout: DataTableLayout;
    hideRowHeader: boolean;
    table: arrow.Table;
    tableFormatter: ArrowTableFormatter;
    rightmostVisibleColumn: number;
    matchingRows: ReadonlyMap<number, number[]> | null;
    searchColumnIndexByGroup: ReadonlyMap<number, number>;
    onMouseEnter: (event: React.PointerEvent<HTMLDivElement>) => void;
    onMouseLeave: (event: React.PointerEvent<HTMLDivElement>) => void;
    onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export function DataCell(props: CellComponentProps<DataCellData>): React.ReactElement | null {
    const inLayout = props.columnIndex < props.gridLayout.arrowFieldByColumnIndex.length;
    const isHiddenRowHeader = props.columnIndex === 0 && props.hideRowHeader;
    const fieldId = inLayout ? props.gridLayout.arrowFieldByColumnIndex[props.columnIndex] : -1;

    // Translate the row index through the visible row ids, if an indirection table is active
    const dataRow = props.visibleRowIndices != null
        ? props.visibleRowIndices[props.rowIndex]
        : props.rowIndex;

    // Subscribe to the hovered cell, only the previous and the next focused row re-render
    const focus = useCellFocus(props.focus, (inLayout && !isHiddenRowHeader) ? dataRow : -1, fieldId);

    // Format the value and peek into text values only when the value changes
    const formatted = (inLayout && !isHiddenRowHeader && props.tableFormatter)
        ? props.tableFormatter.getValue(dataRow, fieldId)
        : null;
    const peekText = inLayout && props.columnIndex !== 0 && props.gridLayout.isTextColumn[props.columnIndex] === 1;
    const peekedFormat = React.useMemo(() => peekText ? peekFormat(formatted) : null, [peekText, formatted]);

    if (!inLayout) {
        return <div style={props.style} />;
    }
    if (isHiddenRowHeader) {
        return null;
    }

    // Abort if no formatter is available
    if (!props.tableFormatter) {
        return (
            <div
                className={styles.data_cell}
                style={props.style}
                data-table-col={fieldId}
                data-table-row={dataRow}
                data-visible-row={props.rowIndex}
                onMouseEnter={props.onMouseEnter}
                onMouseLeave={props.onMouseLeave}
            />
        );
    }
    const isRowFocused = focus !== CellFocus.None;

    if (props.columnIndex == 0) {
        // Row number column - inline class computation to avoid object allocation
        const className = isRowFocused
            ? `${styles.row_header_cell} ${styles.data_cell_focused_secondary}`
            : styles.row_header_cell;
        return (
            <div className={className} style={props.style}>
                {formatted ?? ""}
            </div>
        );
    } else {
        // Compute class name inline to avoid object allocation in classNames()
        const isMetadata = props.gridLayout.isSystemColumn[props.columnIndex] === 1;
        const isNull = formatted == null;
        const displayText = isNull ? null : truncateCellText(formatted);
        const isRightmost = props.columnIndex === props.rightmostVisibleColumn;
        const searchColumnIndex = props.searchColumnIndexByGroup.get(
            props.gridLayout.columnGroupByColumnIndex[props.columnIndex],
        );
        const isSearchMatch = searchColumnIndex != null
            && !isMetadata
            && props.matchingRows?.get(dataRow + 1)?.includes(searchColumnIndex) === true;

        // Build class string directly - avoids object creation and iteration
        let className: string;
        if (isNull) {
            className = `${styles.data_cell} ${styles.data_cell_null}`;
        } else {
            className = styles.data_cell;
        }
        if (isRowFocused) {
            className += focus === CellFocus.Primary
                ? ` ${styles.data_cell_focused_primary}`
                : ` ${styles.data_cell_focused_secondary}`;
        }
        if (isMetadata) {
            className += ` ${styles.data_cell_metadata}`;
        }
        if (isRightmost) {
            className += ` ${styles.data_cell_rightmost}`;
        }
        if (isSearchMatch) {
            className += ` ${styles.data_cell_search_match}`;
        }

        const field = props.table.schema.fields[fieldId];
        const canOpenDetail = field.type.typeId === arrow.Type.Utf8
            || field.type.typeId === arrow.Type.LargeUtf8
            || isArrowListType(field.type)
            || field.type.typeId === arrow.Type.Struct;
        const hint = !isNull && isArrowListType(field.type)
            ? 'array'
            : (!isNull && field.type.typeId === arrow.Type.Struct
                ? 'struct'
                : peekedFormat);

        return (
            <div
                className={className}
                style={props.style}
                role="gridcell"
                aria-label={isSearchMatch
                    ? `${isNull ? 'NULL' : displayText}${hint == null ? '' : `, ${hint}`}, search match`
                    : undefined}
                tabIndex={canOpenDetail ? 0 : -1}
                data-table-col={fieldId}
                data-table-row={dataRow}
                data-visible-row={props.rowIndex}
                onMouseEnter={props.onMouseEnter}
                onMouseLeave={props.onMouseLeave}
                onClick={props.onClick}
                onKeyDown={event => {
                    if (canOpenDetail && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        event.currentTarget.click();
                    }
                }}
            >
                {hint != null ? (
                    <>
                        <span className={styles.data_cell_text}>{displayText}</span>
                        <span className={styles.format_bean}>{hint}</span>
                    </>
                ) : (
                    isNull ? "NULL" : displayText
                )}
            </div>
        );
    }
}
