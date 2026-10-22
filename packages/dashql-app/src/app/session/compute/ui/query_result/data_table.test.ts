import { describe, expect, it } from 'vitest';

import { computeGridHeight } from './data_table.js';

describe('computeGridHeight', () => {
    it('keeps a fitted grid at its base result height when cross-filtering rows', () => {
        const initialHeight = computeGridHeight(8, 8, 108, 0, true, 568);
        const heightAfterCrossFiltering = computeGridHeight(8, 1, 108, 0, true, 568);
        const heightAfterCrossFilteringToZero = computeGridHeight(8, 0, 108, 0, true, 568);

        expect(initialHeight).toBe(316);
        expect(heightAfterCrossFiltering).toBe(initialHeight);
        expect(heightAfterCrossFilteringToZero).toBe(initialHeight);
    });

    it('caps large results at the configured maximum height', () => {
        expect(computeGridHeight(100, 100, 108, 15, true, 568)).toBe(568);
    });
});
