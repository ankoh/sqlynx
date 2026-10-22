import * as arrow from 'apache-arrow';

/// The category assignment for the scatter plot: a per-point `Uint8Array` color
/// index plus the number of distinct categories and (optionally) their source
/// values for legend/tooltip use.
export interface CategoryAssignment {
    category: Uint8Array;
    categoryCount: number;
    /// The distinct source values in category-index order (at most 256 entries).
    values: unknown[];
}

/// Map an arbitrary Arrow column to a dense `Uint8Array` of category indices. The
/// first 256 distinct values (in first-seen order) get indices 0..255; any further
/// distinct values collapse into the last bucket. Null maps to category 0.
///
/// This is a *rendering* concern (point coloring), not projection, so it lives in
/// the view layer alongside the scatter — the compute module owns only the
/// coordinate computation.
export function extractCategories(table: arrow.Table, columnName: string): CategoryAssignment | null {
    const column = table.getChild(columnName) as arrow.Vector | null;
    if (!column) return null;

    const count = column.length;
    const category = new Uint8Array(count);
    const indexByValue = new Map<unknown, number>();
    const values: unknown[] = [];

    for (let i = 0; i < count; ++i) {
        let v = column.get(i) as unknown;
        if (typeof v === 'bigint') v = Number(v);
        if (v == null) {
            category[i] = 0;
            continue;
        }
        let idx = indexByValue.get(v);
        if (idx === undefined) {
            if (values.length < 256) {
                idx = values.length;
                indexByValue.set(v, idx);
                values.push(v);
            } else {
                idx = 255;
            }
        }
        category[i] = idx;
    }

    return { category, categoryCount: Math.max(1, values.length), values };
}
