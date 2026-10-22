import { buildCrossEdgePath, buildFragmentPath, estimateRelativeDifference, hasOutputCardinalityProduced, truncatePlanLabel } from './plan_scene.js';

function pathContainsPoint(path: string, x: number, y: number): boolean {
    const contours = path.split('M ').filter(Boolean).map(contour => {
        const values = contour.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        const points: [number, number][] = [];
        for (let i = 0; i < values.length; i += 2) points.push([values[i], values[i + 1]]);
        return points;
    });
    let inside = false;
    for (const points of contours) {
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const [xi, yi] = points[i];
            const [xj, yj] = points[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
    }
    return inside;
}

describe('truncatePlanLabel', () => {
    it('preserves labels that fit', () => {
        expect(truncatePlanLabel('orders', 6)).toEqual('orders');
    });

    it('uses the same character budget for the ellipsis', () => {
        expect(truncatePlanLabel('customer_orders', 8)).toEqual('custome…');
    });

    it('counts unicode code points instead of UTF-16 units', () => {
        expect(truncatePlanLabel('a😀bc', 3)).toEqual('a😀…');
    });

    it('renders no text when the budget is zero', () => {
        expect(truncatePlanLabel('orders', 0)).toEqual('');
    });
});

describe('hasOutputCardinalityProduced', () => {
    it('detects analyzed output rows without conflating them with estimates', () => {
        expect(hasOutputCardinalityProduced({ cardinality: 1200 })).toEqual(false);
        expect(hasOutputCardinalityProduced({ statistics: { 'output-rows': 42 } })).toEqual(true);
        expect(hasOutputCardinalityProduced({ statistics: { outputRows: 21 } })).toEqual(true);
        expect(hasOutputCardinalityProduced({ outputRows: 18 })).toEqual(true);
    });

    it('detects an analyzed output of zero', () => {
        expect(hasOutputCardinalityProduced({ statistics: { 'output-rows': 0 } })).toEqual(true);
    });
});

describe('estimateRelativeDifference', () => {
    it('is neutral when estimated and actual rows match', () => {
        expect(estimateRelativeDifference(100, 100)).toEqual(0);
        expect(estimateRelativeDifference(0, 0)).toEqual(0);
    });

    it('expresses the error relative to the estimate', () => {
        expect(estimateRelativeDifference(1, 2)).toEqual(1);
        expect(estimateRelativeDifference(2, 1)).toEqual(-0.5);
        expect(estimateRelativeDifference(10, 100)).toEqual(9);
    });

    it('uses infinity when actual rows exceed a zero estimate', () => {
        expect(estimateRelativeDifference(100, 0)).toEqual(-1);
        expect(estimateRelativeDifference(0, 100)).toEqual(Number.POSITIVE_INFINITY);
    });
});

describe('buildCrossEdgePath', () => {
    it('connects the centered tree ports with external control points', () => {
        expect(buildCrossEdgePath(
            { x: 40, y: 160, width: 60, height: 32 },
            { x: 200, y: 160, width: 80, height: 32 },
        )).toEqual('M 40 144 C 40 120, 200 224, 200 176');
    });

    it('keeps vertical tension when the lead endpoints align', () => {
        expect(buildCrossEdgePath(
            { x: 40, y: 224, width: 60, height: 32 },
            { x: 200, y: 160, width: 80, height: 32 },
        )).toEqual('M 40 208 C 40 184, 200 224, 200 176');
    });
});

describe('buildFragmentPath', () => {
    const operators = [
        { rect: { x: 50, y: 40, width: 40, height: 20 } },
        { rect: { x: 100, y: 100, width: 60, height: 30 } },
        { rect: { x: 180, y: 60, width: 20, height: 20 } },
    ];

    it('draws a padded contour around one operator', () => {
        const path = buildFragmentPath([2], operators, [], 8);
        expect(path).toContain('Q');
        expect(pathContainsPoint(path, 180, 60)).toEqual(true);
        expect(pathContainsPoint(path, 160, 60)).toEqual(false);
    });

    it('connects fragment operators without filling their bounding box', () => {
        const path = buildFragmentPath(
            [0, 1],
            operators,
            [{ childOperator: 0, parentOperator: 1 }],
            10,
            10,
        );
        expect(pathContainsPoint(path, 50, 40)).toEqual(true);
        expect(pathContainsPoint(path, 100, 100)).toEqual(true);
        expect(pathContainsPoint(path, 75, 70)).toEqual(true);
        expect(pathContainsPoint(path, 130, 40)).toEqual(false);
    });

    it('uses the fragment padding around connecting edges', () => {
        const path = buildFragmentPath(
            [0, 1],
            operators,
            [{ childOperator: 0, parentOperator: 1 }],
            10,
        );
        expect(pathContainsPoint(path, 55, 76)).toEqual(true);
        expect(pathContainsPoint(path, 55, 80)).toEqual(false);
    });

    it('does not include an adjacent non-member in the contour', () => {
        const fragmentOperators = [
            { rect: { x: 100, y: 40, width: 60, height: 20 } },
            { rect: { x: 100, y: 100, width: 40, height: 20 } },
            { rect: { x: 40, y: 160, width: 40, height: 20 } },
            { rect: { x: 160, y: 160, width: 40, height: 20 } },
            { rect: { x: 35, y: 100, width: 40, height: 20 } },
        ];
        const path = buildFragmentPath(
            [0, 1, 2, 3],
            fragmentOperators,
            [
                { childOperator: 1, parentOperator: 0 },
                { childOperator: 2, parentOperator: 1 },
                { childOperator: 3, parentOperator: 1 },
            ],
            10,
            10,
        );
        expect(pathContainsPoint(path, 40, 160)).toEqual(true);
        expect(pathContainsPoint(path, 160, 160)).toEqual(true);
        expect(pathContainsPoint(path, 35, 100)).toEqual(false);
    });

    it('returns an empty path for empty membership', () => {
        expect(buildFragmentPath([], operators)).toEqual('');
    });

    it('keeps diagonally touching operators as separate contours', () => {
        const path = buildFragmentPath([
            0,
            1,
        ], [
            { rect: { x: 10, y: 10, width: 20, height: 20 } },
            { rect: { x: 30, y: 30, width: 20, height: 20 } },
        ], [], 0);
        expect(path.match(/M /g)).toHaveLength(2);
        expect(pathContainsPoint(path, 10, 10)).toEqual(true);
        expect(pathContainsPoint(path, 30, 30)).toEqual(true);
    });
});
