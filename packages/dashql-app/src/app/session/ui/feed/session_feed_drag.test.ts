import { reorderFeedEntries } from './session_feed_drag.js';

describe('session feed drag ordering', () => {
    it('reorders by stable script identity rather than mutable file name', () => {
        const entries = [
            { scriptId: 1, fileName: '1_alpha.sql' },
            { scriptId: 2, fileName: '2_beta.sql' },
            { scriptId: 3, fileName: '3_gamma.sql' },
        ];

        expect(reorderFeedEntries(entries, 3, 1)).toEqual([
            entries[2],
            entries[0],
            entries[1],
        ]);
        expect(reorderFeedEntries(entries, '3_gamma.sql', 1)).toBeNull();
    });
});
