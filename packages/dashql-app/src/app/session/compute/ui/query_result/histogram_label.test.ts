import { describe, expect, it } from 'vitest';

import { formatHistogramFocusDescription } from './histogram_label.js';

describe('formatHistogramFocusDescription', () => {
    it('formats a count relative to the supplied row total', () => {
        expect(formatHistogramFocusDescription(3n, 12)).toBe('3 rows (25%)');
    });

    it('prefers the cross-filtered count and row total', () => {
        expect(formatHistogramFocusDescription(8n, 20, 3n, 12)).toBe('3 rows (25%)');
    });

    it('handles singular and empty filtered aggregates', () => {
        expect(formatHistogramFocusDescription(1n, 3)).toBe('1 row (33.33%)');
        expect(formatHistogramFocusDescription(4n, 10, 0n, 0)).toBe('0 rows (0%)');
    });
});
