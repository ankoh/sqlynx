import { describe, expect, it, vi } from 'vitest';

import { FeedRowHeightCache } from './session_feed_layout.js';

describe('FeedRowHeightCache', () => {
    it('uses exact separator and script estimates before rows mount', () => {
        const heights = new FeedRowHeightCache([
            { scriptId: 1, estimatedHeight: 122 },
            { scriptId: 2, estimatedHeight: 202 },
        ]);

        expect([0, 1, 2, 3, 4].map(index => heights.getRowHeight(index))).toEqual([
            48, 122, 40, 202, 40,
        ]);
    });

    it('uses the compact first separator height on mobile', () => {
        const heights = new FeedRowHeightCache([
            { scriptId: 1, estimatedHeight: 122 },
        ], undefined, 40);

        expect([0, 1, 2].map(index => heights.getRowHeight(index))).toEqual([40, 122, 40]);
        expect(heights.getAverageRowHeight()).toBe((40 + 122 + 40) / 3);
    });

    it('retains measured script heights by identity while entries update', () => {
        const onChange = vi.fn();
        const heights = new FeedRowHeightCache([
            { scriptId: 1, estimatedHeight: 122 },
            { scriptId: 2, estimatedHeight: 202 },
        ], onChange);
        heights.setRowHeight(1, 137);
        heights.updateEntries([
            { scriptId: 2, estimatedHeight: 202 },
            { scriptId: 1, estimatedHeight: 162 },
        ]);

        expect(heights.getRowHeight(1)).toBe(202);
        expect(heights.getRowHeight(3)).toBe(137);
        expect(heights.getAverageRowHeight()).toBe((48 + 202 + 40 + 137 + 40) / 5);
        expect(onChange).toHaveBeenCalledWith(1, 122, 137);
    });

    it('adds the composer inset to the last separator only', () => {
        const heights = new FeedRowHeightCache([
            { scriptId: 1, estimatedHeight: 122 },
            { scriptId: 2, estimatedHeight: 202 },
        ], undefined, undefined, 90);

        expect([0, 1, 2, 3, 4].map(index => heights.getRowHeight(index))).toEqual([
            48, 122, 40, 202, 130,
        ]);
        expect(heights.getAverageRowHeight()).toBe((48 + 122 + 40 + 202 + 130) / 5);
    });
});
