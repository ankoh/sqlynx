/// Shared color scheme for column summary visualizations (histogram, most frequent, etc.)

/// Colors for regular (non-null) bars
export const COLUMN_SUMMARY_COLORS = {
    /// Total bar color when no filter is active
    totalBar: "hsl(208.5deg 20.69% 50.76%)",
    /// Total bar color when focused and no filter is active
    totalBarFocused: "hsl(208.5deg 20.69% 30.76%)",
    /// Total bar color when a filter is active (faded background)
    totalBarWithFilter: "hsl(210deg 10% 85%)",
    /// Total bar color when focused and a filter is active
    totalBarWithFilterFocused: "hsl(210deg 10% 45%)",
    /// Filtered bar color (the highlighted portion)
    filteredBar: "hsl(208.5deg 20.69% 50.76%)",
    /// Filtered bar color when focused
    filteredBarFocused: "hsl(208.5deg 20.69% 30.76%)",
};

/// Colors for null value bars
export const COLUMN_SUMMARY_NULL_COLORS = {
    /// Total null bar color when no filter is active
    totalBar: "hsl(210deg 17.5% 74.31%)",
    /// Total null bar color when focused and no filter is active
    totalBarFocused: "hsl(208.5deg 20.69% 30.76%)",
    /// Total null bar color when a filter is active (faded background)
    totalBarWithFilter: "hsl(210deg 10% 85%)",
    /// Total null bar color when focused and a filter is active
    totalBarWithFilterFocused: "hsl(210deg 10% 45%)",
    /// Filtered null bar color
    filteredBar: "hsl(210deg 17.5% 50%)",
    /// Filtered null bar color when focused
    filteredBarFocused: "hsl(210deg 17.5% 35%)",
};

/// Helper to get the appropriate total bar color based on filter state and focus
export function getTotalBarColor(hasFilter: boolean, isFocused: boolean, isNull: boolean = false): string {
    const colors = isNull ? COLUMN_SUMMARY_NULL_COLORS : COLUMN_SUMMARY_COLORS;
    if (hasFilter) {
        return isFocused ? colors.totalBarWithFilterFocused : colors.totalBarWithFilter;
    }
    return isFocused ? colors.totalBarFocused : colors.totalBar;
}

/// Helper to get the appropriate filtered bar color based on focus
export function getFilteredBarColor(isFocused: boolean, isNull: boolean = false): string {
    const colors = isNull ? COLUMN_SUMMARY_NULL_COLORS : COLUMN_SUMMARY_COLORS;
    return isFocused ? colors.filteredBarFocused : colors.filteredBar;
}
