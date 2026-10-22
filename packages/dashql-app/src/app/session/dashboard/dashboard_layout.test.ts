import { describe, expect, it } from 'vitest';

import {
    DASHBOARD_DEFAULT_HEIGHT,
    DASHBOARD_DEFAULT_WIDTH,
    dashboardPlacementsIntersect,
    moveDashboardItem,
    placeDashboardItems,
    resizeDashboardItem,
} from './dashboard_layout.js';

describe('dashboard layout', () => {
    it('places unhinted cards row-major with stable defaults', () => {
        expect(placeDashboardItems([{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual([
            { id: 1, row: 0, column: 0, width: DASHBOARD_DEFAULT_WIDTH, height: DASHBOARD_DEFAULT_HEIGHT },
            { id: 2, row: 0, column: 6, width: DASHBOARD_DEFAULT_WIDTH, height: DASHBOARD_DEFAULT_HEIGHT },
            { id: 3, row: 3, column: 0, width: DASHBOARD_DEFAULT_WIDTH, height: DASHBOARD_DEFAULT_HEIGHT },
        ]);
    });

    it('uses row and column as start hints and scans forward when occupied', () => {
        const placed = placeDashboardItems([
            { id: 1, row: 1, column: 3, width: 3, height: 2 },
            { id: 2, row: 1, column: 3, width: 3, height: 2 },
        ]);
        expect(placed[0]).toMatchObject({ row: 1, column: 3 });
        expect(placed[1]).toMatchObject({ row: 1, column: 6 });
        expect(dashboardPlacementsIntersect(placed[0], placed[1])).toBe(false);
    });

    it('gives a moved card ownership and deterministically displaces intersections', () => {
        const initial = placeDashboardItems([{ id: 1 }, { id: 2 }, { id: 3 }]);
        const moved = moveDashboardItem(initial, 3, 0, 0);
        expect(moved).toEqual([
            { id: 1, row: 0, column: 6, width: 6, height: 3 },
            { id: 2, row: 3, column: 0, width: 6, height: 3 },
            { id: 3, row: 0, column: 0, width: 6, height: 3 },
        ]);
    });

    it('gives a resized card ownership and clamps it to the twelve-column grid', () => {
        const initial = placeDashboardItems([{ id: 1 }, { id: 2 }]);
        const resized = resizeDashboardItem(initial, 1, 20, 4);
        expect(resized).toEqual([
            { id: 1, row: 0, column: 0, width: 12, height: 4 },
            { id: 2, row: 4, column: 0, width: 6, height: 3 },
        ]);
    });
});
