import { describe, expect, it } from 'vitest';

import { getColumnSortDirection, getNextColumnSortDirection } from './data_table_ordering.js';

describe('data table ordering', () => {
    it('sorts an unordered column ascending first', () => {
        expect(getColumnSortDirection('score', [])).toBeNull();
        expect(getNextColumnSortDirection('score', [])).toBe(true);
    });

    it('cycles the active column from ascending to descending to unsorted', () => {
        const ascending = [{ field: 'score', ascending: true }];
        const descending = [{ field: 'score', ascending: false }];

        expect(getNextColumnSortDirection('score', ascending)).toBe(false);
        expect(getNextColumnSortDirection('score', descending)).toBeNull();
    });

    it('treats an omitted direction as ascending', () => {
        const ordering = [{ field: 'score' }];

        expect(getColumnSortDirection('score', ordering)).toBe(true);
        expect(getNextColumnSortDirection('score', ordering)).toBe(false);
    });

    it('starts a different column in ascending order', () => {
        const ordering = [{ field: 'name', ascending: false }];

        expect(getColumnSortDirection('score', ordering)).toBeNull();
        expect(getNextColumnSortDirection('score', ordering)).toBe(true);
    });
});
