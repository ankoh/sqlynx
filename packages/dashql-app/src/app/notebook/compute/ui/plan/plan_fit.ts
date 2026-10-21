import type { PlanScene } from './plan_scene.js';

/** The padding between the viewport and the fitted plan */
export const PLAN_FIT_PADDING = 24;
/** The smallest scale of a fit, large plans overflow the viewport instead of shrinking further */
export const PLAN_FIT_MIN_SCALE = 0.5;

export interface PlanFitTransform {
    x: number;
    y: number;
    scale: number;
}

/** Find the operator at the top of the plan, i.e., the topmost operator that is not the input of another one */
function findPlanRoot(scene: Pick<PlanScene, 'operators' | 'edges'>): PlanScene['operators'][number] | null {
    const children = new Set(scene.edges.map(edge => edge.childOperator));
    let root: PlanScene['operators'][number] | null = null;
    for (const operator of scene.operators) {
        if (operator == null || children.has(operator.id)) continue;
        if (root == null || operator.rect.y < root.rect.y) root = operator;
    }
    return root;
}

/**
 * Compute the transform that shows a plan in a viewport.
 *
 * A plan that fits at the minimum scale is centered as a whole.
 * Larger plans keep the minimum scale so that operators stay readable. Their root is placed at the top center
 * of the viewport and the rest of the plan overflows to the bottom (and to the sides), reachable by panning.
 */
export function computePlanFitTransform(
    scene: Pick<PlanScene, 'width' | 'height' | 'operators' | 'edges'>,
    viewportWidth: number,
    viewportHeight: number,
): PlanFitTransform {
    const availableWidth = viewportWidth - PLAN_FIT_PADDING * 2;
    const availableHeight = viewportHeight - PLAN_FIT_PADDING * 2;
    const fitScale = Math.min(1, availableWidth / scene.width, availableHeight / scene.height);
    if (fitScale >= PLAN_FIT_MIN_SCALE) {
        return {
            x: (viewportWidth - scene.width * fitScale) / 2,
            y: (viewportHeight - scene.height * fitScale) / 2,
            scale: fitScale,
        };
    }

    const scale = PLAN_FIT_MIN_SCALE;
    const root = findPlanRoot(scene);
    // Center the scene horizontally if it fits, otherwise center the root
    const x = scene.width * scale <= availableWidth || root == null
        ? (viewportWidth - scene.width * scale) / 2
        : viewportWidth / 2 - root.rect.x * scale;
    // Scene coordinates are not guaranteed to start at the origin, align the top of the root with the padding
    const top = root == null ? 0 : root.rect.y - root.rect.height / 2;
    return { x, y: PLAN_FIT_PADDING - top * scale, scale };
}
