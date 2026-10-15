import type { DashQLShellCommand } from '../api.js';

export const SHELL_EXAMPLES = `-- Vega cars
SELECT * FROM external('https://data.dashql.app/vega-cars/v1/cars.parquet') limit 10;

-- Vega stocks (Iceberg)
select * from external('https://data.dashql.app/vega-stocks/v1/iceberg/', format => 'iceberg', metadata_filename => '00000-bd86997f-7550-4e1a-8af1-5fe63926db79.metadata.json') limit 10;

-- TPC-H Q1
select
    l_returnflag,
    l_linestatus,
    sum(l_quantity) as sum_qty,
    sum(l_extendedprice) as sum_base_price,
    sum(l_extendedprice * (1 - l_discount)) as sum_disc_price,
    sum(l_extendedprice * (1 - l_discount) * (1 + l_tax)) as sum_charge,
    avg(l_quantity) as avg_qty,
    avg(l_extendedprice) as avg_price,
    avg(l_discount) as avg_disc,
    count(*) as count_order
from
    external('https://data.dashql.app/tpch-0.01/v1/lineitem.parquet')
where
    l_shipdate <= '1998-09-02'
group by
    l_returnflag,
    l_linestatus
order by
    l_returnflag,
    l_linestatus;

-- TPC-H Q5
select
        n_name,
        sum(l_extendedprice * (1 - l_discount)) as revenue
from
        external('https://data.dashql.app/tpch-0.01/v1/customer.parquet') customer,
        external('https://data.dashql.app/tpch-0.01/v1/orders.parquet') orders,
        external('https://data.dashql.app/tpch-0.01/v1/lineitem.parquet') lineitem,
        external('https://data.dashql.app/tpch-0.01/v1/supplier.parquet') supplier,
        external('https://data.dashql.app/tpch-0.01/v1/nation.parquet') nation,
        external('https://data.dashql.app/tpch-0.01/v1/region.parquet') region
where
        c_custkey = o_custkey
        and l_orderkey = o_orderkey
        and l_suppkey = s_suppkey
        and c_nationkey = s_nationkey
        and s_nationkey = n_nationkey
        and n_regionkey = r_regionkey
        and r_name = 'ASIA'
        and o_orderdate >= date '1994-01-01'
        and o_orderdate < date '1994-01-01' + interval '1' year
group by
        n_name
order by
        revenue desc;`;

export const examplesCommand: DashQLShellCommand = [
    'examples',
    'Show example SQL queries',
    args => {
        if (args.length !== 0) throw new Error('usage: .examples');
        return SHELL_EXAMPLES;
    },
];
