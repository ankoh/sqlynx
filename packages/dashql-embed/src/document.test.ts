import { describe, expect, it } from 'vitest';
import { renderFeatureDocument, identifierTerms } from './document.js';
import type { ScriptFeatures } from './analysis/features.js';

const features: ScriptFeatures = {
    statementTypes: ['select'],
    tables: ['customer', 'orders'],
    columns: ['customer.c_custkey', 'orders.o_custkey'],
    functions: [],
    aggregates: ['sum'],
    functionCalls: ['sum(orders.o_totalprice)'],
    ctes: [],
    joins: ['customer.c_custkey = orders.o_custkey'],
    filters: ['orders.o_totalprice > 100'],
    operators: ['group by'],
    outputColumns: ['c_custkey', 'total'],
    groupBy: ['customer.c_custkey'],
    orderBy: [],
};
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

describe('renderFeatureDocument', () => {
    it('renders sections in priority order', () => {
        const doc = renderFeatureDocument(features, 1000, words);
        expect(doc.truncated).toBe(false);
        expect(doc.text.split('\n').map(l => l.split(':')[0])).toEqual([
            'Statements', 'Tables', 'Joins', 'Function calls', 'Grouped by', 'Filters', 'Operators', 'Output', 'Columns', 'Terms',
        ]);
    });

    it('trims low-priority sections to fit the budget', () => {
        const doc = renderFeatureDocument(features, 14, words);
        expect(doc.truncated).toBe(true);
        expect(doc.tokenCount).toBeLessThanOrEqual(14);
        expect(doc.text).toContain('Tables: customer, orders');
        expect(doc.text).not.toContain('Terms');
    });

    it('marks cut lists', () => {
        const many = { ...features, tables: Array.from({ length: 50 }, (_, i) => `table_${i}`) };
        const doc = renderFeatureDocument(many, 20, words);
        expect(doc.text).toMatch(/Tables: table_0.*\(\+\d+ more\)/);
        expect(doc.tokenCount).toBeLessThanOrEqual(20);
    });

    it('splits identifiers into terms', () => {
        expect(identifierTerms(['orders.o_orderdate', 'customerName'])).toEqual(['orders', 'orderdate', 'customer', 'name']);
    });
});
