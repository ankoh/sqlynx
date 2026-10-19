/// Compare two style objects shallowly
function shallowEqualStyle(a: object | undefined, b: object | undefined): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
        if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
    }
    return true;
}

/// Shallow props comparison for React.memo that also compares the `style` prop shallowly.
/// Cells receive fresh style literals from their parents on every render.
export function arePropsEqualWithStyle<P extends object>(prev: Readonly<P>, next: Readonly<P>): boolean {
    const prevKeys = Object.keys(prev) as (keyof P)[];
    if (prevKeys.length !== Object.keys(next).length) return false;
    for (const key of prevKeys) {
        if (key === 'style') {
            if (!shallowEqualStyle(prev[key] as object | undefined, next[key] as object | undefined)) return false;
        } else if (!Object.is(prev[key], next[key])) {
            return false;
        }
    }
    return true;
}
