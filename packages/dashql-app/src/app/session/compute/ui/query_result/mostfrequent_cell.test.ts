import { describe, expect, it } from 'vitest';

import { MAX_FOCUSED_VALUE_LENGTH, truncateFocusedValue } from './mostfrequent_cell.js';

describe('truncateFocusedValue', () => {
    it('preserves values within the hover limit', () => {
        const value = 'a'.repeat(MAX_FOCUSED_VALUE_LENGTH);

        expect(truncateFocusedValue(value)).toBe(value);
    });

    it('bounds long hover values and marks them as truncated', () => {
        const value = 'a'.repeat(MAX_FOCUSED_VALUE_LENGTH + 1);
        const truncated = truncateFocusedValue(value);

        expect(truncated).toHaveLength(MAX_FOCUSED_VALUE_LENGTH);
        expect(truncated).toBe(`${'a'.repeat(MAX_FOCUSED_VALUE_LENGTH - 3)}...`);
    });
});
