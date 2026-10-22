const OPERATOR_SYMBOLS: Readonly<Record<string, string>> = {
    output: 'relalg_output',
    scan: 'relalg_scan',
    parquetscan: 'relalg_scan',
    tablescan: 'relalg_scan',
    explicitscan: 'relalg_explicit_scan',
    virtualtable: 'relalg_virtual_table',
    tableconstruction: 'relalg_table_construction',
    tablefunction: 'relalg_table_function',
    select: 'relalg_select',
    map: 'relalg_map',
    groupby: 'relalg_group',
    window: 'relalg_window',
    sort: 'relalg_sort',
    join: 'relalg_join',
    leftouterjoin: 'relalg_left_outer_join',
    rightouterjoin: 'relalg_right_outer_join',
    leftsemijoin: 'relalg_left_semi_join',
    rightsemijoin: 'relalg_right_semi_join',
    leftantijoin: 'relalg_left_anti_join',
    rightantijoin: 'relalg_right_anti_join',
    leftmarkjoin: 'relalg_left_mark_join',
    unionall: 'relalg_union_all',
    intersectall: 'relalg_intersect_all',
    exceptall: 'relalg_except_all',
    iteration: 'relalg_iteration',
    iterationincrement: 'relalg_iteration_increment',
    insert: 'relalg_insert',
};

export const PLAN_OPERATOR_SYMBOL_SIZE = 18;

export function getPlanOperatorSymbol(typeName: string | null): string | null {
    if (typeName == null) return null;
    return OPERATOR_SYMBOLS[typeName.toLowerCase().replace(/-/g, '')] ?? null;
}

export function shouldRenderPlanOperatorSymbol(typeName: string | null, label: string): boolean {
    return typeName != null && label === typeName && getPlanOperatorSymbol(typeName) != null;
}

export function getPlanOperatorDisplayWidth(
    typeName: string | null,
    label: string,
    layoutWidth: number,
    paddingLeft: number,
    statusWidth: number,
    statusMarginRight: number,
    paddingRight: number,
): number {
    if (!shouldRenderPlanOperatorSymbol(typeName, label)) return layoutWidth;
    return paddingLeft + statusWidth + statusMarginRight + PLAN_OPERATOR_SYMBOL_SIZE + paddingRight;
}
