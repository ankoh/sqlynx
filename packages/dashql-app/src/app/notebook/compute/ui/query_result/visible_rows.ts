import * as arrow from 'apache-arrow';

import { TableComputationState } from '../../../../../compute/computation_state.js';

/// Visit the values of an integer column as numbers, like `Number(column.get(i))` (nulls become 0).
/// Integer chunks are read from their value buffers directly. A chunk's values are already narrowed
/// to the chunk's window, so value `i` of the chunk is `values[i]`, exactly what `Vector.get` reads.
export function forEachIntegerValue(column: arrow.Vector, visit: (value: number, index: number) => void): void {
    if (column.type.typeId !== arrow.Type.Int) {
        for (let i = 0; i < column.length; ++i) {
            visit(Number(column.get(i)), i);
        }
        return;
    }
    let index = 0;
    for (const chunk of column.data) {
        const values = chunk.values as ArrayLike<number | bigint>;
        if (chunk.nullCount === 0) {
            for (let i = 0; i < chunk.length; ++i) {
                visit(Number(values[i]), index++);
            }
        } else {
            for (let i = 0; i < chunk.length; ++i) {
                visit(chunk.getValid(i) ? Number(values[i]) : 0, index++);
            }
        }
    }
}

/// Resolve the active row-id indirection for a table computation.
///
/// When a cross-filter and/or ordering is active, the compute module produces a
/// single-column table of row numbers (1-based, from `row_number()`) identifying the
/// visible rows in display order. Ordering supersedes filtering when both are present
/// (the ordering task already runs over the filtered subset). Returns `null` when the
/// full, unfiltered table should be shown.
///
/// The returned array holds 0-based positional indices into the analyzed data table,
/// ready to gather columns/rows for a renderer.
export function resolveVisibleRowIndices(computation: TableComputationState | null): Int32Array | null {
    if (computation == null) {
        return null;
    }
    const indirection = computation.orderingTable?.dataTable
        ?? (computation.filterTable == null ? computation.dataSearchTable?.dataTable : computation.filterTable.dataTable)
        ?? null;
    if (indirection == null) {
        return null;
    }
    if (indirection.numCols !== 1) {
        return null;
    }
    const column = indirection.getChildAt(0) as arrow.Vector<arrow.Int> | null;
    if (column == null || column.type.typeId !== arrow.Type.Int) {
        return null;
    }
    const out = new Int32Array(column.length);
    forEachIntegerValue(column, (rowNumber, i) => {
        // Row numbers are 1-based; convert to a 0-based positional index.
        out[i] = Math.max(rowNumber, 1) - 1;
    });
    return out;
}

/// Intersect the current cross-filtered/ordered rows with the active Data search.
/// Search result keys are stable 1-based row numbers from the analyzed data frame.
export function resolveSearchedRowIndices(computation: TableComputationState | null): Int32Array | null {
    if (computation == null || computation.dataSearch.matchingRows == null) {
        return resolveVisibleRowIndices(computation);
    }
    const visible = computation.orderingTable?.dataSearchRequestId === computation.dataSearchTable?.requestId
        ? resolveVisibleRowIndices(computation)
        : resolveVisibleRowIndices(computation == null ? null : { ...computation, dataSearchTable: null });
    if (visible == null) {
        const rows = Array.from(computation.dataSearch.matchingRows.keys(), rowNumber => rowNumber - 1);
        return Int32Array.from(rows);
    }
    const rows: number[] = [];
    for (const row of visible) {
        if (computation.dataSearch.matchingRows.has(row + 1)) {
            rows.push(row);
        }
    }
    return Int32Array.from(rows);
}
