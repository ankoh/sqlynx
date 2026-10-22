// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Point, ViewportState } from "./utils.js";

export type RenderMode = "points" | "density";

export interface EmbeddingRendererProps {
    mode: RenderMode;
    colorScheme: "light" | "dark";

    /** When true, the background is left transparent instead of being filled with the
     *  color-scheme's opaque white/black, so the canvas composites over whatever is behind it. */
    transparent: boolean;

    x: Float32Array<ArrayBuffer>;
    y: Float32Array<ArrayBuffer>;
    category: Uint8Array<ArrayBuffer> | null;

    /** Per-point selection bitmask (bit `i` set ⇒ point `i` is selected), length
     *  `ceil(count / 32)`. When null, no selection is active and every point renders
     *  at full opacity. When present, unselected points are dimmed by `selectionDimFactor`. */
    selection: Uint32Array<ArrayBuffer> | null;
    /** Opacity multiplier applied to unselected points when a selection is active (0..1). */
    selectionDimFactor: number;

    categoryCount: number;
    categoryColors: string[] | null;

    viewportX: number;
    viewportY: number;
    viewportScale: number;

    pointSize: number;
    pointAlpha: number;
    pointsAlpha: number;

    densityScaler: number;
    densityBandwidth: number;
    densityQuantizationStep: number;
    densityAlpha: number;
    contoursAlpha: number;

    gamma: number;
    width: number;
    height: number;

    /** Approximate maximum points to render. null/Infinity = no limit. Default: 4,000,000 */
    downsampleMaxPoints: number | null;
    /** Density weight for downsampling (0-10). Default: 5 */
    downsampleDensityWeight: number;
}

export interface DensityMap {
    data: Float32Array;
    width: number;
    height: number;
    coordinateAtPixel: (x: number, y: number) => Point;
}

export interface EmbeddingRenderer {
    readonly props: EmbeddingRendererProps;

    /** Set renderer props. Returns true if a render is needed. */
    setProps(newProps: Partial<EmbeddingRendererProps>): boolean;

    /** Render */
    render(): void;

    /** Destroy the renderer and free any resource */
    destroy(): void;

    /** Produce a density map */
    densityMap(width: number, height: number, radius: number, viewportState: ViewportState): Promise<DensityMap>;
}
