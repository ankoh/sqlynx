import { describe, expect, it } from 'vitest';
import { identifierTerms, renderPropertiesDocument, renderSyntaxDocument } from './document.js';
import type { SyntaxFeatures } from './analysis/syntax.js';

const features: SyntaxFeatures = {
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
    visualizations: [],
    outputColumns: ['c_custkey', 'total'],
    groupBy: ['customer.c_custkey'],
    orderBy: [],
};
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

describe('renderSyntaxDocument', () => {
    it('renders sections in priority order', () => {
        const doc = renderSyntaxDocument(features, 1000, words);
        expect(doc.truncated).toBe(false);
        expect(doc.text.split('\n').map(l => l.split(':')[0])).toEqual([
            'Statements', 'Tables', 'Joins', 'Function calls', 'Grouped by', 'Filters', 'Operators', 'Output', 'Columns', 'Terms',
        ]);
    });

    it('trims low-priority sections to fit the budget', () => {
        const doc = renderSyntaxDocument(features, 14, words);
        expect(doc.truncated).toBe(true);
        expect(doc.tokenCount).toBeLessThanOrEqual(14);
        expect(doc.text).toContain('Tables: customer, orders');
        expect(doc.text).not.toContain('Terms');
    });

    it('marks cut lists', () => {
        const many = { ...features, tables: Array.from({ length: 50 }, (_, i) => `table_${i}`) };
        const doc = renderSyntaxDocument(many, 20, words);
        expect(doc.text).toMatch(/Tables: table_0.*\(\+\d+ more\)/);
        expect(doc.tokenCount).toBeLessThanOrEqual(20);
    });

    it('keeps whole visualization entries and drops the ones that do not fit', () => {
        const layered = {
            ...features,
            visualizations: [
                'vegalite layer 1 of 2 line chart (line, x date)',
                'vegalite layer 2 of 2 point (x date, y a very long list of words that cannot possibly fit anymore)',
            ],
        };
        const doc = renderSyntaxDocument(layered, 24, words);
        expect(doc.truncated).toBe(true);
        expect(doc.tokenCount).toBeLessThanOrEqual(24);
        expect(doc.text).toContain('Visualization: vegalite layer 1 of 2 line chart (line, x date) (+1 more)');
        expect(doc.text).not.toContain('layer 2');
    });

    it('limits the tables to a share of the budget', () => {
        const many = { ...features, tables: Array.from({ length: 100 }, (_, i) => `t${i}`) };
        const doc = renderSyntaxDocument(many, 40, words);
        const tables = doc.text.split('\n').find(l => l.startsWith('Tables:'))!;
        expect(words(tables)).toBeLessThanOrEqual(10);
        // The sections behind the tables still get their room
        expect(doc.text).toContain('Function calls: sum(orders.o_totalprice)');
    });

    it('splits identifiers into terms', () => {
        expect(identifierTerms(['orders.o_orderdate', 'customerName'])).toEqual(['orders', 'orderdate', 'customer', 'name']);
    });
});

describe('renderPropertiesDocument', () => {
    it('renders one line per property', () => {
        const doc = renderPropertiesDocument(
            { owner: 'finance', runtime_ms: 1834, tags: ['weekly', 'revenue'], notes: 'first\nsecond', missing: null },
            1000,
            words,
        );
        expect(doc.text).toBe('owner: finance\nruntime_ms: 1834\ntags: ["weekly","revenue"]\nnotes: first second');
        expect(doc.truncated).toBe(false);
    });

    it('drops properties that do not fit', () => {
        const doc = renderPropertiesDocument({ a: 'one two three', b: 'four five six seven eight', c: 'x' }, 7, words);
        expect(doc.text).toBe('a: one two three\nc: x');
        expect(doc.truncated).toBe(true);
    });
});
