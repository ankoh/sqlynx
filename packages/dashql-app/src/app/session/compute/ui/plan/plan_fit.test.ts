import { computePlanFitTransform, PLAN_FIT_MIN_SCALE, PLAN_FIT_PADDING } from './plan_fit.js';
import type { PlanScene, PlanSceneOperator } from './plan_scene.js';

function operator(id: number, x: number, y: number): PlanSceneOperator {
    return {
        id,
        typeName: null,
        label: `operator ${id}`,
        displayLabel: `operator ${id}`,
        rect: { x, y, width: 80, height: 32 },
        ports: 0,
        statistics: {
            inputCardinalityEstimated: 0,
            inputCardinalityConsumed: 0n,
            outputCardinalityEstimated: 0,
            outputCardinalityProduced: 0n,
            hasOutputCardinalityProduced: false,
            memoryBytes: 0n,
        },
        properties: {},
    };
}

function scene(width: number, height: number): Pick<PlanScene, 'width' | 'height' | 'operators' | 'edges'> {
    return {
        width,
        height,
        // The root sits at the top, off-center, with a child below
        operators: [operator(0, width / 4, 20), operator(1, width / 2, 100)],
        edges: [{ id: 0n, childOperator: 1, parentOperator: 0, outputCardinalityEstimated: 0, outputCardinalityProduced: null, path: '' }],
    };
}

describe('computePlanFitTransform', () => {
    it('centers a plan that fits', () => {
        const fit = computePlanFitTransform(scene(400, 200), 800, 600);
        expect(fit).toEqual({ x: 200, y: 200, scale: 1 });
    });

    it('shrinks a plan down to the minimum scale to fit', () => {
        const fit = computePlanFitTransform(scene(1000, 400), 600, 600);
        expect(fit.scale).toBeCloseTo((600 - PLAN_FIT_PADDING * 2) / 1000);
        expect(fit.x).toBeCloseTo(PLAN_FIT_PADDING);
    });

    it('does not shrink below the minimum scale and places the root at the top center', () => {
        const fit = computePlanFitTransform(scene(4000, 6000), 800, 600);
        expect(fit.scale).toEqual(PLAN_FIT_MIN_SCALE);
        // The root is at x=1000, y=20 with height 32 -> top at y=4
        expect(fit.x + 1000 * fit.scale).toBeCloseTo(400);
        expect(fit.y + 4 * fit.scale).toBeCloseTo(PLAN_FIT_PADDING);
    });

    it('centers the scene if only the height overflows at the minimum scale', () => {
        const fit = computePlanFitTransform(scene(600, 6000), 800, 600);
        expect(fit.scale).toEqual(PLAN_FIT_MIN_SCALE);
        expect(fit.x).toBeCloseTo((800 - 600 * PLAN_FIT_MIN_SCALE) / 2);
        expect(fit.y + 4 * fit.scale).toBeCloseTo(PLAN_FIT_PADDING);
    });
});
