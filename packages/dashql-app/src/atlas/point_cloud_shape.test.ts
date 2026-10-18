import { describe, expect, it } from 'vitest';

import { cloudSpread, DATA_RADIUS, focusRadius, pointAlpha, pointSize, shapeCoords } from './point_cloud_shape.js';

describe('point cloud shape', () => {
    it('draws few points bigger than many', () => {
        expect(pointSize(3)).toBeGreaterThanOrEqual(10);
        expect(pointSize(100)).toBeGreaterThan(pointSize(1000));
        expect(pointSize(1_000_000)).toBeGreaterThanOrEqual(2);
        for (const n of [0, 1, 5, 50, 500, 5000]) {
            expect(pointSize(n)).toBeGreaterThan(0);
            expect(pointAlpha(n)).toBeGreaterThan(0);
            expect(pointAlpha(n)).toBeLessThanOrEqual(1);
        }
    });

    it('contracts small clouds', () => {
        expect(cloudSpread(1)).toBeCloseTo(0.6, 5);
        expect(cloudSpread(5)).toBeLessThan(cloudSpread(50));
        expect(cloudSpread(500)).toBe(1);
    });

    it('pulls points toward the middle and keeps outliers in reach', () => {
        expect(focusRadius(0)).toBe(0);
        expect(focusRadius(0.5)).toBeLessThan(0.5);
        expect(focusRadius(1)).toBeCloseTo(1, 5);
        expect(focusRadius(1.5)).toBeGreaterThan(1);
        expect(focusRadius(1000)).toBeLessThan(1.41);
        let last = -1;
        for (let r = 0; r <= 3; r += 0.05) {
            const v = focusRadius(r);
            expect(v).toBeGreaterThanOrEqual(last);
            last = v;
        }
    });

    it('shapes coordinates along their direction', () => {
        const coords = Float32Array.from([0, 0, 0, 1, 0, 0, 0, -0.5, 0]);
        const out = shapeCoords(coords);
        expect(Array.from(out.subarray(0, 3))).toEqual([0, 0, 0]);
        const spread = DATA_RADIUS * cloudSpread(3);
        expect(out[3]).toBeCloseTo(spread, 5);
        expect(out[4]).toBe(0);
        expect(out[7]).toBeLessThan(0);
        expect(Math.abs(out[7])).toBeLessThan(0.5 * spread);
        expect(shapeCoords(new Float32Array(0))).toHaveLength(0);
    });
});
