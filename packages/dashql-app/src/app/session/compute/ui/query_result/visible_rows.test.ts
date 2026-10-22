import * as arrow from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { resolveSearchedRowIndices } from './visible_rows.js';

describe('resolveSearchedRowIndices', () => {
    it('intersects Data matches with cross-filtered rows', () => {
        const computation = {
            filterTable: { dataTable: arrow.tableFromArrays({ row_idx: new Int32Array([1, 3, 4]) }) },
            orderingTable: null,
            dataSearch: { matchingRows: new Map([[2, [0]], [3, [1]], [4, [0]]]) },
        } as any;
        expect(Array.from(resolveSearchedRowIndices(computation)!)).toEqual([2, 3]);
    });

    it('preserves the active ordering while intersecting matches', () => {
        const computation = {
            filterTable: null,
            orderingTable: { dataTable: arrow.tableFromArrays({ row_idx: new Int32Array([4, 2, 1]) }) },
            dataSearch: { matchingRows: new Map([[1, [0]], [4, [1]]]) },
        } as any;
        expect(Array.from(resolveSearchedRowIndices(computation)!)).toEqual([3, 0]);
    });

    it('uses a materialized Data-search table directly without cross-filters', () => {
        const computation = {
            filterTable: null,
            orderingTable: null,
            dataSearchTable: { dataTable: arrow.tableFromArrays({ row_idx: new Int32Array([2, 4]) }) },
            dataSearch: { matchingRows: new Map([[2, [0]], [4, [1]]]) },
        } as any;
        expect(Array.from(resolveSearchedRowIndices(computation)!)).toEqual([1, 3]);
    });
});
