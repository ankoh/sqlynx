import * as arrow from 'apache-arrow';
import * as React from 'react';
import * as styles from './data_table.module.css';
import symbols from '@ankoh/dashql-svg-symbols';

import { classNames } from '../../../../../utils/classnames.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../../../ui/foundations/button.js';
import { DataFrame } from '../../../../../compute/data_frame.js';
import { DataTableLayout } from './data_table_layout.js';
import { AtlasExportOverlay } from './atlas_export_overlay.js';

/// ---------------------------------------------------------------------------
/// Header Name Cell
/// ---------------------------------------------------------------------------

export interface HeaderNameCellProps {
    columnIndex: number;
    style: React.CSSProperties;
    table: arrow.Table;
    gridLayout: DataTableLayout;
    dataFrame: DataFrame | null;
    rightmostVisibleColumn: number;
    sortAscending: boolean | null;
    onOrderByColumn: (col: number) => void;
    onShowTable?: () => void;
}

export function HeaderNameCell(props: HeaderNameCellProps): React.ReactElement {
    if (props.columnIndex >= props.gridLayout.arrowFieldByColumnIndex.length) {
        return <div style={props.style} />;
    }
    const fieldId = props.gridLayout.arrowFieldByColumnIndex[props.columnIndex];
    const fieldName = props.table.schema.fields[fieldId].name;
    const isSorted = props.sortAscending != null;
    const sortState = props.sortAscending == null ? 'unsorted' : (props.sortAscending ? 'ascending' : 'descending');
    const sortLabel = `Sort ${fieldName}; currently ${sortState}`;
    const sortIcon = props.sortAscending === false ? 'sort_desc_16' : 'sort_asc_16';
    const sortButtonVariant = isSorted ? ButtonVariant.Default : ButtonVariant.Invisible;

    if (props.columnIndex == 0) {
        // Corner cell (top-left)
        return (
            <div className={classNames(styles.header_corner_cell, { [styles.header_cell_clickable]: props.onShowTable != null })} style={props.style} onClick={props.onShowTable}>
                <span className={styles.header_cell_actions}>
                    <IconButton
                        variant={sortButtonVariant}
                        size={ButtonSize.Small}
                        aria-label={sortLabel}
                        onClick={(e) => { e.stopPropagation(); props.onOrderByColumn(fieldId); }}
                        disabled={props.dataFrame == null}
                    >
                        <svg width="16px" height="16px">
                            <use xlinkHref={`${symbols}#${sortIcon}`} />
                        </svg>
                    </IconButton>
                </span>
            </div>
        );
    } else {
        // Regular header cell
        const isRightmost = props.columnIndex === props.rightmostVisibleColumn;
        // A column of SQL texts can be exported as an atlas, a folder with a script per row
        const canExportAtlas = props.gridLayout.isTextColumn[props.columnIndex] == 1 &&
            props.gridLayout.isSystemColumn[props.columnIndex] != 1;
        return (
            <div
                className={classNames(styles.header_cell, {
                    [styles.header_metadata_cell]: props.gridLayout.isSystemColumn[props.columnIndex] == 1,
                    [styles.header_cell_rightmost]: isRightmost,
                    [styles.header_cell_clickable]: props.onShowTable != null,
                })}
                style={props.style}
                onClick={props.onShowTable}
            >
                <span className={styles.header_cell_name}>
                    {fieldName}
                </span>
                <span className={styles.header_cell_actions}>
                    {canExportAtlas && (
                        <AtlasExportOverlay
                            table={props.table}
                            sqlField={fieldId}
                            visibleFields={visibleFields(props.gridLayout)}
                        />
                    )}
                    <IconButton
                        variant={sortButtonVariant}
                        size={ButtonSize.Small}
                        aria-label={sortLabel}
                        onClick={(e) => { e.stopPropagation(); props.onOrderByColumn(fieldId); }}
                        disabled={props.dataFrame == null}
                    >
                        <svg width="16px" height="16px">
                            <use xlinkHref={`${symbols}#${sortIcon}`} />
                        </svg>
                    </IconButton>
                </span>
            </div>
        );
    }
}

/// The fields of the columns that the table shows, without the row numbers and system columns
function visibleFields(layout: DataTableLayout): number[] {
    const fields: number[] = [];
    for (let i = 1; i < layout.columnCount && i < layout.arrowFieldByColumnIndex.length; ++i) {
        if (layout.isSystemColumn[i] == 1) continue;
        const field = layout.arrowFieldByColumnIndex[i];
        if (!fields.includes(field)) fields.push(field);
    }
    return fields;
}
