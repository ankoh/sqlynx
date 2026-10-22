export const DASHBOARD_COLUMN_COUNT = 12;
export const DASHBOARD_ROW_HEIGHT = 96;
export const DASHBOARD_DEFAULT_WIDTH = 6;
export const DASHBOARD_DEFAULT_HEIGHT = 3;

export interface DashboardLayoutHint {
    row?: number | null;
    column?: number | null;
    width?: number | null;
    height?: number | null;
}

export interface DashboardLayoutItem extends DashboardLayoutHint {
    id: number;
}

export interface DashboardPlacement {
    id: number;
    row: number;
    column: number;
    width: number;
    height: number;
}

function clampInteger(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
    if (value == null || !Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function normalize(item: DashboardLayoutItem): DashboardPlacement {
    const width = clampInteger(item.width, DASHBOARD_DEFAULT_WIDTH, 1, DASHBOARD_COLUMN_COUNT);
    return {
        id: item.id,
        row: clampInteger(item.row, 0, 0, Number.MAX_SAFE_INTEGER),
        column: clampInteger(item.column, 0, 0, DASHBOARD_COLUMN_COUNT - width),
        width,
        height: clampInteger(item.height, DASHBOARD_DEFAULT_HEIGHT, 1, Number.MAX_SAFE_INTEGER),
    };
}

export function dashboardPlacementsIntersect(a: DashboardPlacement, b: DashboardPlacement): boolean {
    return a.column < b.column + b.width
        && a.column + a.width > b.column
        && a.row < b.row + b.height
        && a.row + a.height > b.row;
}

function findOpenPlacement(item: DashboardPlacement, placed: readonly DashboardPlacement[]): DashboardPlacement {
    let row = item.row;
    let column = item.column;
    while (true) {
        const candidate = { ...item, row, column };
        if (!placed.some(other => dashboardPlacementsIntersect(candidate, other))) return candidate;
        column += 1;
        if (column + item.width > DASHBOARD_COLUMN_COUNT) {
            column = 0;
            row += 1;
        }
    }
}

/** Place items deterministically. `ownerId` is placed first and therefore owns its requested cells. */
export function placeDashboardItems(
    items: readonly DashboardLayoutItem[],
    ownerId: number | null = null,
): DashboardPlacement[] {
    const normalized = items.map(normalize);
    const ordered = ownerId == null
        ? normalized
        : [
            ...normalized.filter(item => item.id === ownerId),
            ...normalized.filter(item => item.id !== ownerId),
        ];
    const placed: DashboardPlacement[] = [];
    for (const item of ordered) placed.push(findOpenPlacement(item, placed));
    const byId = new Map(placed.map(item => [item.id, item]));
    return items.map(item => byId.get(item.id)!);
}

export function moveDashboardItem(
    items: readonly DashboardPlacement[],
    ownerId: number,
    row: number,
    column: number,
): DashboardPlacement[] {
    return placeDashboardItems(items.map(item => item.id === ownerId ? { ...item, row, column } : item), ownerId);
}

export function resizeDashboardItem(
    items: readonly DashboardPlacement[],
    ownerId: number,
    width: number,
    height: number,
): DashboardPlacement[] {
    return placeDashboardItems(items.map(item => item.id === ownerId ? { ...item, width, height } : item), ownerId);
}
