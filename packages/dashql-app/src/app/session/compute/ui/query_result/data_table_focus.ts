import * as React from 'react';

/// The focus of a single cell
export enum CellFocus {
    None = 0,
    /// Another cell in the same row is hovered
    Secondary = 1,
    /// The cell itself is hovered
    Primary = 2,
}

/// The hovered cell of a data table, kept outside of React state.
/// Cells subscribe by their data row so that moving the pointer only re-renders the previous and the next row.
export class DataTableFocusStore {
    protected focusedRow: number | null = null;
    protected focusedField: number | null = null;
    protected listenersByRow = new Map<number, Set<() => void>>();

    public setFocus(row: number | null, field: number | null) {
        if (row === this.focusedRow && field === this.focusedField) {
            return;
        }
        const prevRow = this.focusedRow;
        this.focusedRow = row;
        this.focusedField = field;
        if (prevRow != null) {
            this.notify(prevRow);
        }
        if (row != null && row !== prevRow) {
            this.notify(row);
        }
    }

    public getFocus(row: number, field: number): CellFocus {
        if (row !== this.focusedRow) {
            return CellFocus.None;
        }
        return field === this.focusedField ? CellFocus.Primary : CellFocus.Secondary;
    }

    public subscribe(row: number, listener: () => void): () => void {
        let listeners = this.listenersByRow.get(row);
        if (listeners == null) {
            listeners = new Set();
            this.listenersByRow.set(row, listeners);
        }
        listeners.add(listener);
        return () => {
            const current = this.listenersByRow.get(row);
            if (current == null) return;
            current.delete(listener);
            if (current.size == 0) {
                this.listenersByRow.delete(row);
            }
        };
    }

    protected notify(row: number) {
        const listeners = this.listenersByRow.get(row);
        if (listeners == null) return;
        for (const listener of [...listeners]) {
            listener();
        }
    }
}

/// Subscribe to the focus of a single cell
export function useCellFocus(store: DataTableFocusStore, row: number, field: number): CellFocus {
    const subscribe = React.useCallback((listener: () => void) => store.subscribe(row, listener), [store, row]);
    const getSnapshot = React.useCallback(() => store.getFocus(row, field), [store, row, field]);
    return React.useSyncExternalStore(subscribe, getSnapshot);
}
