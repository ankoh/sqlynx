export function formatHistogramFocusDescription(
    count: bigint,
    rowCount: number,
    filteredCount: bigint | null = null,
    filteredRowCount: number | null = null,
): string {
    const displayedCount = filteredCount ?? count;
    const displayedRowCount = filteredRowCount ?? rowCount;
    const percentage = displayedRowCount === 0
        ? 0
        : Math.round((Number(displayedCount) / displayedRowCount) * 100 * 100) / 100;
    return `${displayedCount} ${displayedCount === 1n ? "row" : "rows"} (${percentage}%)`;
}
