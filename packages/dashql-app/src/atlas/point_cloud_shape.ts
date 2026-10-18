/// The layout is normalized to a 98th percentile radius of 1, whatever the number of points. Folders with a handful of
/// scripts are the common case, so the shape of the cloud depends on how many points there are.

/// Radius of the cloud of scripts in scene units at full spread
export const DATA_RADIUS = 1.15;
/// Exponent that pulls the points toward the middle of the cloud, 1 would keep the layout as it is
const FOCUS_EXPONENT = 1.4;
/// How far outliers may reach beyond the normalized radius
const OUTLIER_REACH = 0.4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/// Nominal size of a point in CSS pixels at the distance of the cloud center. A handful of scripts get big dots, a
/// thousand get fine ones.
export function pointSize(count: number): number {
    return clamp(40 / Math.pow(Math.max(count, 1), 0.42), 2.2, 12);
}

/// Opacity of a point, a few big dots can be almost opaque
export function pointAlpha(count: number): number {
    return 0.95 - 0.15 * clamp(Math.log10(Math.max(count, 1)) / 2.5, 0, 1);
}

/// Few points on a sphere of the full radius look scattered, so small clouds contract. Reaches 1 at about 200 points.
export function cloudSpread(count: number): number {
    return 0.6 + 0.4 * clamp((Math.log10(Math.max(count, 1)) - 0.5) / 1.8, 0, 1);
}

/// Radius of a point in scene units for a radius of the layout. Points in the middle move closer together and
/// outliers stay in view.
export function focusRadius(radius: number): number {
    const focused = Math.pow(radius, FOCUS_EXPONENT);
    if (focused <= 1) return focused;
    return 1 + OUTLIER_REACH * Math.tanh((focused - 1) / OUTLIER_REACH);
}

/// Scene positions for the normalized coordinates of a layout (3 values per point)
export function shapeCoords(coords: Float32Array): Float32Array {
    const count = coords.length / 3;
    const scale = DATA_RADIUS * cloudSpread(count);
    const out = new Float32Array(coords.length);
    for (let i = 0; i < count; ++i) {
        const x = coords[i * 3];
        const y = coords[i * 3 + 1];
        const z = coords[i * 3 + 2];
        const radius = Math.hypot(x, y, z);
        const factor = radius > 0 ? (focusRadius(radius) * scale) / radius : 0;
        out[i * 3] = x * factor;
        out[i * 3 + 1] = y * factor;
        out[i * 3 + 2] = z * factor;
    }
    return out;
}
