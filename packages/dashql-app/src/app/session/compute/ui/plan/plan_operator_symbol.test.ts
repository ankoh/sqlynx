import { getPlanOperatorDisplayWidth, getPlanOperatorSymbol, shouldRenderPlanOperatorSymbol } from './plan_operator_symbol.js';

describe('getPlanOperatorSymbol', () => {
    it.each([
        ['output', 'relalg_output'],
        ['scan', 'relalg_scan'],
        ['parquetscan', 'relalg_scan'],
        ['tablescan', 'relalg_scan'],
        ['explicitscan', 'relalg_explicit_scan'],
        ['virtualtable', 'relalg_virtual_table'],
        ['tableconstruction', 'relalg_table_construction'],
        ['tablefunction', 'relalg_table_function'],
        ['select', 'relalg_select'],
        ['map', 'relalg_map'],
        ['groupby', 'relalg_group'],
        ['window', 'relalg_window'],
        ['sort', 'relalg_sort'],
        ['join', 'relalg_join'],
        ['leftouterjoin', 'relalg_left_outer_join'],
        ['rightouterjoin', 'relalg_right_outer_join'],
        ['leftsemijoin', 'relalg_left_semi_join'],
        ['rightsemijoin', 'relalg_right_semi_join'],
        ['leftantijoin', 'relalg_left_anti_join'],
        ['rightantijoin', 'relalg_right_anti_join'],
        ['leftmarkjoin', 'relalg_left_mark_join'],
        ['unionall', 'relalg_union_all'],
        ['intersectall', 'relalg_intersect_all'],
        ['exceptall', 'relalg_except_all'],
        ['iteration', 'relalg_iteration'],
        ['iterationincrement', 'relalg_iteration_increment'],
        ['insert', 'relalg_insert'],
    ])('maps %s to %s', (operator, symbol) => {
        expect(getPlanOperatorSymbol(operator)).toEqual(symbol);
    });

    it('normalizes operator casing and Hyper kebab-case names', () => {
        expect(getPlanOperatorSymbol('JOIN')).toEqual('relalg_join');
        expect(getPlanOperatorSymbol('group-by')).toEqual('relalg_group');
        expect(getPlanOperatorSymbol('left-outer-join')).toEqual('relalg_left_outer_join');
    });

    it('leaves unknown and missing operator types without a symbol', () => {
        expect(getPlanOperatorSymbol('executiontarget')).toBeNull();
        expect(getPlanOperatorSymbol('futureoperator')).toBeNull();
        expect(getPlanOperatorSymbol(null)).toBeNull();
    });
});

describe('shouldRenderPlanOperatorSymbol', () => {
    it('replaces a known type-only label', () => {
        expect(shouldRenderPlanOperatorSymbol('join', 'join')).toEqual(true);
        expect(shouldRenderPlanOperatorSymbol('group-by', 'group-by')).toEqual(true);
    });

    it('preserves a meaningful operator label', () => {
        expect(shouldRenderPlanOperatorSymbol('tablescan', 'orders')).toEqual(false);
    });

    it('preserves the text fallback for unknown operators', () => {
        expect(shouldRenderPlanOperatorSymbol('futureoperator', 'futureoperator')).toEqual(false);
    });
});

describe('getPlanOperatorDisplayWidth', () => {
    it('compacts a type-only symbol while retaining the status slot', () => {
        expect(getPlanOperatorDisplayWidth('join', 'join', 76, 12, 14, 8, 12)).toEqual(64);
    });

    it('compacts a type-only symbol without an unused status slot', () => {
        expect(getPlanOperatorDisplayWidth('join', 'join', 76, 12, 0, 0, 12)).toEqual(42);
    });

    it('preserves the layout width for labels and unknown types', () => {
        expect(getPlanOperatorDisplayWidth('tablescan', 'orders', 75, 12, 0, 0, 12)).toEqual(75);
        expect(getPlanOperatorDisplayWidth('futureoperator', 'futureoperator', 142, 12, 0, 0, 12)).toEqual(142);
    });
});
