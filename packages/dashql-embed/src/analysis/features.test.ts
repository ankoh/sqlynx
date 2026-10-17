import { describe, expect, it } from 'vitest';
import { SqlAnalyzer } from './core.js';
import { extractFeatures } from './features.js';
import { analyzeOne } from '../test_fixture.js';

async function features(sql: string, analyzer?: SqlAnalyzer) {
    const f = extractFeatures(await analyzeOne(sql, analyzer));
    expect(f).not.toBeNull();
    return f!;
}

describe('extractFeatures', () => {
    it('resolves comma joins, filters and aggregates (TPC-H Q3)', async () => {
        const f = await features(`select l_orderkey, sum(l_extendedprice * (1 - l_discount)) as revenue, o_orderdate
from customer, orders, lineitem
where c_mktsegment = 'BUILDING' and c_custkey = o_custkey and l_orderkey = o_orderkey
    and o_orderdate < date '1995-03-15' and l_shipdate > date '1995-03-15'
group by l_orderkey, o_orderdate order by revenue desc limit 10;`);
        expect(f.statementTypes).toEqual(['select']);
        expect(f.tables).toEqual(['customer', 'lineitem', 'orders']);
        expect(f.joins).toEqual(['customer.c_custkey = orders.o_custkey', 'lineitem.l_orderkey = orders.o_orderkey']);
        expect(f.filters).toEqual([
            "customer.c_mktsegment = 'BUILDING'",
            "lineitem.l_shipdate > date '1995-03-15'",
            "orders.o_orderdate < date '1995-03-15'",
        ]);
        expect(f.aggregates).toEqual(['sum']);
        expect(f.groupBy).toEqual(['lineitem.l_orderkey', 'orders.o_orderdate']);
        expect(f.operators).toEqual(['group by', 'order by', 'limit']);
        expect(f.outputColumns).toEqual(['l_orderkey', 'revenue', 'o_orderdate']);
        expect(f.columns).toContain('orders.o_orderdate');
        expect(f.columns).not.toContain('revenue');
    });

    it('extracts explicit join conditions with aliases and join types', async () => {
        const f = await features(`select count(*) from customer c left join orders o on c.c_custkey = o.o_custkey and o.o_comment not like '%x%'`);
        expect(f.joins).toEqual(['customer.c_custkey = orders.o_custkey']);
        expect(f.filters).toEqual(["orders.o_comment not like '%x%'"]);
        expect(f.operators).toContain('left join');
        expect(f.aggregates).toEqual(['count']);
    });

    it('treats CTEs separately from tables and flags subqueries', async () => {
        const f = await features(`with big as (select o_custkey, sum(o_totalprice) as total from orders group by o_custkey)
select c_name from customer where c_custkey in (select o_custkey from big where total > 1000)`);
        expect(f.ctes).toEqual(['big']);
        expect(f.tables).toEqual(['customer', 'orders']);
        expect(f.operators).toEqual(expect.arrayContaining(['cte', 'subquery']));
    });

    it('does not turn OR groups into join edges', async () => {
        const f = await features(`select * from customer c, orders o where c.c_custkey = o.o_custkey or c.c_nationkey = o.o_shippriority`);
        expect(f.joins).toEqual([]);
    });

    it('canonicalizes literal-first comparisons and BETWEEN / IN', async () => {
        const f = await features(`select * from orders where 100 < o_totalprice and o_orderdate between date '2020-01-01' and date '2020-12-31' and o_orderstatus in ('F', 'O')`);
        expect(f.filters).toEqual([
            "orders.o_orderdate between date '2020-01-01' and date '2020-12-31'",
            "orders.o_orderstatus in ('F', 'O')",
            'orders.o_totalprice > 100',
        ]);
    });

    it('records set operations, windows and known functions', async () => {
        const f = await features(`select rank() over (partition by o_custkey order by o_totalprice), coalesce(o_comment, 'x') from orders union all select 1, 'a'`);
        expect(f.operators).toEqual(expect.arrayContaining(['window', 'union all']));
        expect(f.functions).toEqual(expect.arrayContaining(['rank', 'coalesce']));
    });

    it('works without a catalog and keeps unresolved names as written', async () => {
        const analyzer = await SqlAnalyzer.create();
        const f = await features(`select a.x, b.y from foo a join bar b on a.id = b.id where a.kind = 'z'`, analyzer);
        expect(f.tables).toEqual(['bar', 'foo']);
        expect(f.joins).toEqual(['bar.id = foo.id']);
        expect(f.filters).toEqual(["foo.kind = 'z'"]);
    });

    it('describes DDL statements', async () => {
        const f = await features(`create table t (a int); select * from t;`);
        expect(f.statementTypes).toEqual(['create table', 'select']);
    });

    it('returns null when nothing could be parsed', async () => {
        const analyzer = await SqlAnalyzer.create();
        const analyzed = analyzer.analyze([{ id: 'x', text: '' }])[0];
        expect(extractFeatures(analyzed)?.tables ?? []).toEqual([]);
    });
});

describe('extractFeatures for DDL', () => {
    it('lists tables that the script creates', async () => {
        const analyzer = await SqlAnalyzer.create();
        const f = await features(`create table a (x int); create table b as select * from a;`, analyzer);
        expect(f.tables).toEqual(['a', 'b']);
    });
});

describe('extractFeatures keeps function names and literal arguments', () => {
    it('renders relative time filters (last 30 days)', async () => {
        const f = await features(`select o_orderkey from orders where date_trunc('day', o_orderdate) > current_timestamp - interval '30' day`);
        expect(f.filters).toEqual([`date_trunc('day', orders.o_orderdate) > current_timestamp - interval '30' day`]);
        expect(f.functionCalls).toEqual(['current_timestamp', `date_trunc('day', orders.o_orderdate)`]);
        expect(f.functions).toEqual(['current_timestamp', 'date_trunc']);
    });

    it('accepts the other interval spellings', async () => {
        const f = await features(`select 1 from orders where o_orderdate > now() - interval '1 month' and o_orderdate >= current_date - 30 and o_orderdate > current_date - interval 7 day`);
        expect(f.filters).toEqual([
            "orders.o_orderdate > current_date - interval 7 day",
            "orders.o_orderdate > now() - interval '1 month'",
            'orders.o_orderdate >= current_date - 30',
        ]);
    });

    it('keeps the literals of all comparisons', async () => {
        const f = await features(`select 1 from orders where extract(year from o_orderdate) = 1995 and lower(o_comment) like '%rush%' and o_orderstatus = 'F'`);
        expect(f.filters).toEqual([
            'extract(year from orders.o_orderdate) = 1995',
            "lower(orders.o_comment) like '%rush%'",
            "orders.o_orderstatus = 'F'",
        ]);
    });

    it('renders calls in the select list and keeps nested arguments', async () => {
        const f = await features(`select date_trunc('month', o_orderdate) as m, sum(o_totalprice * (1 - 0.1)), count(distinct o_custkey), coalesce(o_comment, 'n/a') from orders group by 1`);
        expect(f.functionCalls).toEqual([
            "coalesce(orders.o_comment, 'n/a')",
            'count(distinct orders.o_custkey)',
            "date_trunc('month', orders.o_orderdate)",
            'sum(orders.o_totalprice * (1 - 0.1))',
        ]);
        expect(f.aggregates).toEqual(['count', 'sum']);
    });

    it('keeps the window clause and star arguments', async () => {
        const f = await features(`select count(*), rank() over (partition by o_custkey order by o_totalprice) from orders`);
        expect(f.functionCalls).toEqual(['count(*)', 'rank() over (partition by o_custkey order by o_totalprice)']);
    });

    it('limits very long calls', async () => {
        const args = Array.from({ length: 60 }, (_, i) => `'value_${i}'`).join(', ');
        const f = await features(`select concat(${args}) from orders`);
        expect(f.functionCalls[0].length).toBeLessThanOrEqual(120);
        expect(f.functionCalls[0].endsWith('...')).toBe(true);
    });

    it('only adds parentheses where nesting needs them', async () => {
        const f = await features(`select 1 from lineitem where l_quantity * (l_extendedprice - l_discount) > 1 + 2 * 3 and l_tax > 1 - (l_discount - 0.01)`);
        expect(f.filters).toEqual([
            'lineitem.l_quantity * (lineitem.l_extendedprice - lineitem.l_discount) > 1 + 2 * 3',
            'lineitem.l_tax > 1 - (lineitem.l_discount - 0.01)',
        ]);
    });

    it('resolves positional group by and order by', async () => {
        const f = await features(`select date_trunc('month', o_orderdate) as m, count(*) from orders group by 1 order by 1 desc, 2`);
        expect(f.groupBy).toEqual(["date_trunc('month', orders.o_orderdate)"]);
        expect(f.orderBy).toEqual(["date_trunc('month', orders.o_orderdate)", 'count(*)']);
    });
});
