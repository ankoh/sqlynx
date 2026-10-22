import * as arrow from 'apache-arrow';

import { TableComputationState } from "../../../../../compute/computation_state.js";
import { ArrowTableFormatter } from "../../../../../compute/arrow_formatter.js";
import { ColumnGroup, LIST_COLUMN, ORDINAL_COLUMN, ROWNUMBER_COLUMN, SKIPPED_COLUMN, STRING_COLUMN } from "../../../../../compute/computation_types.js";

export interface DataTableLayout {
    columnCount: number;
    arrowFieldByColumnIndex: Uint32Array;
    columnXOffsets: Float64Array;
    columnAggregateByColumnIndex: Int32Array;
    columnGroupByColumnIndex: Uint32Array;
    isSystemColumn: Uint8Array;
    isTextColumn: Uint8Array;
    headerRowCount: number;
}

const MAX_VALUE_COLUMN_WIDTH = 300;
const MIN_COLUMN_WIDTH = 120;
const COLUMN_HEADER_ACTION_WIDTH = 24;
const ROW_HEADER_WIDTH = 48;
const FORMATTER_PIXEL_SCALING = 10;

function computeColumnCount(columnGroups: ColumnGroup[], showMetaColumns: boolean, visibleColumnGroups?: ReadonlySet<number> | null): number {
    let columnCount = 0;
    for (let groupIndex = 0; groupIndex < columnGroups.length; ++groupIndex) {
        const columnGroup = columnGroups[groupIndex];
        if (columnGroup.type !== ROWNUMBER_COLUMN && visibleColumnGroups != null && !visibleColumnGroups.has(groupIndex)) {
            continue;
        }
        switch (columnGroup.type) {
            case ROWNUMBER_COLUMN:
                ++columnCount;
                break;
            case SKIPPED_COLUMN:
                break;
            case STRING_COLUMN:
                ++columnCount;
                if (showMetaColumns && columnGroup.value.valueIdFieldName != null) {
                    ++columnCount;
                }
                break;
            case LIST_COLUMN:
                ++columnCount;
                if (showMetaColumns && columnGroup.value.valueIdFieldName != null) {
                    ++columnCount;
                }
                // The UMAP projection x/y coordinates are computed meta columns of the
                // embedding column's group, shown only in debug mode.
                if (showMetaColumns && columnGroup.value.umapProjection != null) {
                    columnCount += 2;
                }
                break;
            case ORDINAL_COLUMN:
                ++columnCount;
                if (showMetaColumns && columnGroup.value.binFieldName != null) {
                    ++columnCount;
                }
                break;
        }
    }
    return columnCount;
}

export function computeTableLayout(formatter: ArrowTableFormatter, state: TableComputationState, showSystemColumns: boolean, headerRowCount: number, containerWidth: number = 0, visibleColumnGroups?: ReadonlySet<number> | null): DataTableLayout {
    // Allocate column offsets
    let columnCount = computeColumnCount(state.columnGroups, showSystemColumns, visibleColumnGroups);
    const columnFields = new Uint32Array(columnCount);
    const columnOffsets = new Float64Array(columnCount + 1);
    const columnAggregateIndex = new Int32Array(columnCount);
    const columnGroupByColumnIndex = new Uint32Array(columnCount);
    const isSystemColumn = new Uint8Array(columnCount);
    const isTextColumn = new Uint8Array(columnCount);
    const tableSchema = state.dataTable.schema;

    // Index table fields by name
    const fieldIndexByName = new Map<string, number>();
    for (let i = 0; i < tableSchema.fields.length; ++i) {
        fieldIndexByName.set(tableSchema.fields[i].name, i);
    }

    for (let i = 0; i < columnCount; ++i) {
        columnAggregateIndex[i] = -1;
    }

    // Allocate column offsets
    let nextDisplayColumn = 0;
    let nextDisplayOffset = 0;
    for (let groupIndex = 0; groupIndex < state.columnGroups.length; ++groupIndex) {
        const columnGroup = state.columnGroups[groupIndex];
        if (columnGroup.type !== ROWNUMBER_COLUMN && visibleColumnGroups != null && !visibleColumnGroups.has(groupIndex)) {
            continue;
        }
        switch (columnGroup.type) {
            case ROWNUMBER_COLUMN: {
                const outputIndex = nextDisplayColumn++;
                columnFields[outputIndex] = fieldIndexByName.get(columnGroup.value.rowNumberFieldName)!;
                columnOffsets[outputIndex] = nextDisplayOffset;
                columnGroupByColumnIndex[outputIndex] = groupIndex;
                nextDisplayOffset += ROW_HEADER_WIDTH;
                break;
            }
            case SKIPPED_COLUMN:
                break;
            case ORDINAL_COLUMN:
                const outputIndex = nextDisplayColumn++;
                const valueColumnFormatter = formatter.columns[fieldIndexByName.get(columnGroup.value.inputFieldName)!];
                let valueColumnWidth = Math.max(
                    COLUMN_HEADER_ACTION_WIDTH + Math.max(
                        valueColumnFormatter.getLayoutInfo().valueAvgWidth,
                        valueColumnFormatter.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                    MIN_COLUMN_WIDTH
                );
                valueColumnWidth = Math.min(valueColumnWidth, MAX_VALUE_COLUMN_WIDTH);
                columnFields[outputIndex] = fieldIndexByName.get(columnGroup.value.inputFieldName)!;
                columnOffsets[outputIndex] = nextDisplayOffset;
                columnAggregateIndex[outputIndex] = groupIndex;
                columnGroupByColumnIndex[outputIndex] = groupIndex;
                nextDisplayOffset += valueColumnWidth;
                if (showSystemColumns && columnGroup.value.binFieldName != null) {
                    const idOutputIndex = nextDisplayColumn++;
                    const idFieldIndex = fieldIndexByName.get(columnGroup.value.binFieldName)!;
                    const idColumn = formatter.columns[idFieldIndex];
                    const idColumnWidth = Math.max(
                        COLUMN_HEADER_ACTION_WIDTH + Math.max(
                            idColumn.getLayoutInfo().valueAvgWidth,
                            idColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                        MIN_COLUMN_WIDTH
                    );
                    columnFields[idOutputIndex] = idFieldIndex;
                    columnOffsets[idOutputIndex] = nextDisplayOffset;
                    columnGroupByColumnIndex[idOutputIndex] = groupIndex;
                    isSystemColumn[idOutputIndex] = 1;
                    nextDisplayOffset += idColumnWidth;
                }
                break;
            case STRING_COLUMN:
            case LIST_COLUMN: {
                const outputIndex = nextDisplayColumn++;
                const valueColumnFormatter = formatter.columns[fieldIndexByName.get(columnGroup.value.inputFieldName)!];
                let valueColumnWidth = Math.max(
                    COLUMN_HEADER_ACTION_WIDTH + Math.max(
                        valueColumnFormatter.getLayoutInfo().valueAvgWidth,
                        valueColumnFormatter.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                    MIN_COLUMN_WIDTH
                );
                valueColumnWidth = Math.min(valueColumnWidth, MAX_VALUE_COLUMN_WIDTH);
                columnFields[outputIndex] = fieldIndexByName.get(columnGroup.value.inputFieldName)!;
                columnOffsets[outputIndex] = nextDisplayOffset;
                columnAggregateIndex[outputIndex] = groupIndex;
                columnGroupByColumnIndex[outputIndex] = groupIndex;
                nextDisplayOffset += valueColumnWidth;
                if (showSystemColumns && columnGroup.value.valueIdFieldName != null) {
                    const idOutputIndex = nextDisplayColumn++;
                    const idFieldIndex = fieldIndexByName.get(columnGroup.value.valueIdFieldName)!;
                    const idColumn = formatter.columns[idFieldIndex];
                    const idColumnWidth = Math.max(
                        COLUMN_HEADER_ACTION_WIDTH + Math.max(
                            idColumn.getLayoutInfo().valueAvgWidth,
                            idColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                        MIN_COLUMN_WIDTH
                    );
                    columnFields[idOutputIndex] = idFieldIndex;
                    columnOffsets[idOutputIndex] = nextDisplayOffset;
                    columnGroupByColumnIndex[idOutputIndex] = groupIndex;
                    isSystemColumn[idOutputIndex] = 1;
                    nextDisplayOffset += idColumnWidth;
                }
                // The UMAP projection x/y coordinates are meta columns of the embedding
                // (list) column's group, shown right after the id column in debug mode.
                if (showSystemColumns && columnGroup.type === LIST_COLUMN && columnGroup.value.umapProjection != null) {
                    for (const coordFieldName of [columnGroup.value.umapProjection.xFieldName, columnGroup.value.umapProjection.yFieldName]) {
                        const coordOutputIndex = nextDisplayColumn++;
                        const coordFieldIndex = fieldIndexByName.get(coordFieldName)!;
                        const coordColumn = formatter.columns[coordFieldIndex];
                        const coordColumnWidth = Math.max(
                            COLUMN_HEADER_ACTION_WIDTH + Math.max(
                                coordColumn.getLayoutInfo().valueAvgWidth,
                                coordColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                            MIN_COLUMN_WIDTH
                        );
                        columnFields[coordOutputIndex] = coordFieldIndex;
                        columnOffsets[coordOutputIndex] = nextDisplayOffset;
                        columnGroupByColumnIndex[coordOutputIndex] = groupIndex;
                        isSystemColumn[coordOutputIndex] = 1;
                        nextDisplayOffset += coordColumnWidth;
                    }
                }
                break;
            }
        }
    }
    columnOffsets[nextDisplayColumn] = nextDisplayOffset;

    // Mark text columns for format peek hints
    for (let i = 0; i < nextDisplayColumn; ++i) {
        const typeId = tableSchema.fields[columnFields[i]].type.typeId;
        if (typeId === arrow.Type.Utf8 || typeId === arrow.Type.LargeUtf8) {
            isTextColumn[i] = 1;
        }
    }

    // If columns don't fill the container, distribute extra space across data columns (not row-number columns)
    if (containerWidth > 0 && nextDisplayOffset < containerWidth) {
        let dataColumnCount = 0;
        for (let i = 0; i < nextDisplayColumn; ++i) {
            if (state.columnGroups[columnGroupByColumnIndex[i]].type !== ROWNUMBER_COLUMN) {
                dataColumnCount++;
            }
        }
        if (dataColumnCount > 0) {
            const extraPerColumn = (containerWidth - nextDisplayOffset) / dataColumnCount;
            let accumulatedExtra = 0;
            for (let i = 0; i < nextDisplayColumn; ++i) {
                if (state.columnGroups[columnGroupByColumnIndex[i]].type !== ROWNUMBER_COLUMN) {
                    accumulatedExtra += extraPerColumn;
                }
                columnOffsets[i + 1] += accumulatedExtra;
            }
        }
    }

    return {
        columnCount,
        arrowFieldByColumnIndex: columnFields,
        columnXOffsets: columnOffsets,
        columnAggregateByColumnIndex: columnAggregateIndex,
        columnGroupByColumnIndex: columnGroupByColumnIndex,
        isSystemColumn: isSystemColumn,
        isTextColumn: isTextColumn,
        headerRowCount
    };
}

export function skipTableLayoutUpdate(old: DataTableLayout, next: DataTableLayout) {
    if (old.columnXOffsets.length != next.columnXOffsets.length) {
        return false;
    }
    for (let i = 0; i < old.columnXOffsets.length; ++i) {
        const delta = next.columnXOffsets[i] - old.columnXOffsets[i];
        if (Math.abs(delta) > 0.01) {
            return false;
        }
    }
    return true;
}
